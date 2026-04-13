from __future__ import annotations

import asyncio
import collections
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any

import aiosqlite

from app.models.jobs import CategoryConfig, CategoryProgress, JobConfig, JudgeStats, ProgressJson
from app.services.export_service import export_job
from app.services.openrouter_client import OpenRouterError, chat_completion
from app.services.prompt_builder import (
    build_example_generation_prompt,
    build_outline_generation_prompt,
    build_topic_generation_prompt,
)
from app.services.token_counter import count_tokens, effective_limit

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Cancellation registry
# ---------------------------------------------------------------------------

_cancelled_jobs: set[str] = set()

TOPIC_BATCH_SIZE = 10
_judge_semaphore = asyncio.Semaphore(3)
_gen_semaphore = asyncio.Semaphore(10)


def cancel_job(job_id: str) -> None:
    _cancelled_jobs.add(job_id)


def is_cancelled(job_id: str) -> bool:
    return job_id in _cancelled_jobs


def clear_cancellation(job_id: str) -> None:
    _cancelled_jobs.discard(job_id)


class _CancelledError(Exception):
    """Internal signal for clean job cancellation."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def distribute_examples(categories: list[CategoryConfig], total: int) -> list[int]:
    """Distribute total examples across categories using largest-remainder method."""
    exact = [c.proportion * total for c in categories]
    floored = [int(e) for e in exact]
    remainder = total - sum(floored)
    fractional = sorted(
        ((exact[i] - floored[i], i) for i in range(len(categories))),
        reverse=True,
    )
    for j in range(remainder):
        floored[fractional[j][1]] += 1
    return floored


def _parse_json_response(raw: str) -> Any:
    """Parse JSON from LLM output, handling common wrapping artifacts."""
    # 1. Direct parse
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    # 2. Strip markdown fence
    fence_match = re.search(r"```(?:json)?\s*([\s\S]+?)\s*```", raw)
    if fence_match:
        try:
            return json.loads(fence_match.group(1))
        except json.JSONDecodeError:
            pass
    # 3. Find first { or [ and parse from there
    for start_char, end_char in [("{", "}"), ("[", "]")]:
        start = raw.find(start_char)
        end = raw.rfind(end_char)
        if start != -1 and end != -1 and end > start:
            try:
                return json.loads(raw[start : end + 1])
            except json.JSONDecodeError:
                pass
    raise ValueError(f"Could not parse JSON from LLM output: {raw[:200]!r}")


_THINK_RE = re.compile(r"<think>[\s\S]*?</think>", re.IGNORECASE)


def _extract_content(response: dict) -> str:
    """Return the text content from an OpenRouter response, stripped of think blocks.

    Handles:
    - None content (models that put reasoning in a separate 'reasoning' field)
    - <think>...</think> blocks (Qwen3 and similar reasoning models)
    """
    try:
        raw = response["choices"][0]["message"].get("content") or ""
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError(f"Invalid OpenRouter response structure: {exc}") from exc
    return _THINK_RE.sub("", raw).strip()


def _inject_conciseness_hint(messages: list[dict], target_tokens: int) -> list[dict]:
    """Append a conciseness reminder to the last user message."""
    messages = [m.copy() for m in messages]
    for i in range(len(messages) - 1, -1, -1):
        if messages[i]["role"] == "user":
            messages[i]["content"] += (
                f"\n\nIMPORTANT: Be concise. "
                f"Target total output length: under {target_tokens} tokens."
            )
            break
    return messages


async def _generate_and_validate_example(
    api_key: str,
    model: str,
    messages: list[dict],
    temperature: float,
    max_tokens: int,
    retry_cooldown: int = 15,
    provider: str | None = None,
) -> tuple[dict, int] | None:
    """
    Call LLM, parse JSON, validate token count.
    On first attempt: full prompt.
    If token count exceeds effective_limit: one retry with conciseness hint.
    Returns (parsed_dict, token_count) or None.
    """
    limit = effective_limit(max_tokens)

    for attempt in range(2):
        if attempt == 1:
            messages = _inject_conciseness_hint(messages, int(limit * 0.8))

        try:
            response = await chat_completion(
                api_key=api_key,
                model=model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                max_retries=1,  # pipeline-level retry handles failures; avoid 3×480s compounding
                retry_cooldown=retry_cooldown,
                provider=provider,
            )
        except Exception:
            if attempt == 0:
                continue
            return None

        raw = _extract_content(response)
        if not raw:
            if attempt == 0:
                continue
            return None

        try:
            parsed = _parse_json_response(raw)
        except ValueError:
            if attempt == 0:
                continue
            return None

        token_count = count_tokens(raw)
        if token_count <= limit:
            return parsed, token_count
        # Over limit — retry with conciseness hint

    return None


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

async def _update_progress(
    db: aiosqlite.Connection,
    job_id: str,
    status: str,
    progress: ProgressJson,
) -> None:
    now = _now_iso()
    await db.execute(
        "UPDATE jobs SET status = ?, progress_json = ?, updated_at = ? WHERE id = ?",
        (status, progress.model_dump_json(), now, job_id),
    )
    await db.commit()


async def _save_example(
    db: aiosqlite.Connection,
    job_id: str,
    content: dict,
    fmt: str,
    tokens: int,
    judge_score: int | None = None,
) -> None:
    now = _now_iso()
    await db.execute(
        "INSERT INTO examples (id, job_id, content_json, format, tokens, created_at, judge_score) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), job_id, json.dumps(content), fmt, tokens, now, judge_score),
    )
    await db.commit()


# ---------------------------------------------------------------------------
# Stage helpers
# ---------------------------------------------------------------------------

async def _generate_topics(
    api_key: str,
    config: JobConfig,
    cat: CategoryConfig,
    count: int,
) -> list[str]:
    logger.info(
        "[_generate_topics] category='%s' requested=%d (TOPIC_BATCH_SIZE=%d)",
        cat.name, count, TOPIC_BATCH_SIZE,
    )
    messages = build_topic_generation_prompt(cat.name, cat.description, count)

    for _ in range(2):
        try:
            response = await chat_completion(
                api_key=api_key,
                model=cat.model or config.model,
                messages=messages,
                temperature=config.temperature,
                max_tokens=min(2048, config.max_tokens),
                max_retries=config.retry_count,
                retry_cooldown=config.retry_cooldown,
                provider=cat.provider,
            )
        except Exception:
            continue

        raw = _extract_content(response)
        try:
            topics = _parse_json_response(raw)
            if isinstance(topics, list) and topics:
                topics = [str(t) for t in topics]
                if len(topics) >= count:
                    return topics[:count]
                while len(topics) < count:
                    topics.append(f"{cat.name} topic {len(topics) + 1}")
                return topics
        except ValueError:
            continue

    return [f"{cat.name} topic {i + 1}" for i in range(count)]


async def _generate_outline(
    api_key: str,
    config: JobConfig,
    cat: CategoryConfig,
    topic: str,
    model: str,
    provider: str | None = None,
) -> list[str]:
    messages = build_outline_generation_prompt(cat.name, topic)

    try:
        response = await chat_completion(
            api_key=api_key,
            model=model,
            messages=messages,
            temperature=config.temperature,
            max_tokens=512,
            max_retries=config.retry_count,
            retry_cooldown=config.retry_cooldown,
            provider=provider,
        )
    except Exception:
        return []

    raw = _extract_content(response)
    try:
        points = _parse_json_response(raw)
        if isinstance(points, list):
            return [str(p) for p in points[:4]]
    except ValueError:
        pass
    return []


async def _judge_example(
    content: dict,
    fmt: str,
    model: str,
    api_key: str,
    judge_criteria: str = "relevance, coherence, naturalness, and educational value",
    provider: str | None = None,
) -> int | None:
    """Call LLM judge to rate an example on 0-100 scale. Returns int or None on failure."""
    judge_prompt = (
        "You are an expert dataset quality evaluator. "
        f"Rate the following training example on a scale of 0-100 based on: {judge_criteria}. "
        'Respond with ONLY a JSON object: {"score": <number>}'
    )
    messages = [
        {"role": "system", "content": judge_prompt},
        {"role": "user", "content": f"Example to evaluate:\n{json.dumps(content, ensure_ascii=False)}"},
    ]
    try:
        response = await chat_completion(
            api_key=api_key,
            model=model,
            messages=messages,
            temperature=0.1,
            max_tokens=1024,  # reasoning models (Qwen3) need space for <think> block
            max_retries=1,    # fail fast — judge failure is non-fatal (returns None → auto-accept)
            provider=provider,
        )
        parsed = _parse_json_response(_extract_content(response))
        score = parsed.get("score")
        if isinstance(score, (int, float)) and 0 <= score <= 100:
            return int(score)
        return None
    except Exception:
        logger.warning("Judge call failed (non-fatal)", exc_info=True)
        return None


async def _generate_example(
    api_key: str,
    config: JobConfig,
    cat: CategoryConfig,
    topic: str,
    outline: list[str],
    model: str,
    provider: str | None = None,
) -> tuple[dict, int] | None:
    messages = build_example_generation_prompt(
        category_name=cat.name,
        topic=topic,
        outline_points=outline or [f"Cover the topic: {topic}"],
        output_format=config.format,
        max_tokens=config.max_tokens,
        conversation_turns=config.conversation_turns,
    )
    return await _generate_and_validate_example(
        api_key=api_key,
        model=model,
        messages=messages,
        temperature=config.temperature,
        max_tokens=config.max_tokens,
        retry_cooldown=config.retry_cooldown,
        provider=provider,
    )


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

# Maximum number of topic attempts per desired example before giving up.
# E.g. target=10 → try at most 30 topics per category.
MAX_ATTEMPTS_PER_EXAMPLE = 3


async def _run_category(
    cat: CategoryConfig,
    count: int,
    config: JobConfig,
    api_key: str,
    db: aiosqlite.Connection,
    job_id: str,
    progress: ProgressJson,
    all_topics: dict[str, list[str]],
    delay: float,
) -> None:
    """Run the generation loop for a single category (called via asyncio.gather)."""
    cat_target = count
    topic_queue: collections.deque[str] = collections.deque(
        all_topics.get(cat.name, [])
    )
    max_attempts = cat_target * MAX_ATTEMPTS_PER_EXAMPLE
    total_attempts = 0
    effective_model = cat.model or config.model
    effective_provider = cat.provider

    while progress.categories[cat.name].completed < cat_target and total_attempts < max_attempts:
        if is_cancelled(job_id):
            raise _CancelledError()

        # Queue empty but target not yet met — generate more topics on the fly
        if not topic_queue:
            needed = cat_target - progress.categories[cat.name].completed
            logger.info(
                "[job %s] Topics exhausted for '%s', generating %d more to reach target",
                job_id, cat.name, needed,
            )
            extra = await _generate_topics(api_key, config, cat, min(TOPIC_BATCH_SIZE, needed))
            topic_queue.extend(extra)
            await asyncio.sleep(delay)
            if not topic_queue:
                logger.warning(
                    "[job %s] Could not generate more topics for '%s' — stopping",
                    job_id, cat.name,
                )
                break

        total_attempts += 1
        topic = topic_queue.popleft()
        progress.current_category = cat.name
        await _update_progress(db, job_id, "running", progress)

        async with _gen_semaphore:
            outline = await _generate_outline(
                api_key, config, cat, topic, effective_model, effective_provider
            )
            await asyncio.sleep(delay)

            if is_cancelled(job_id):
                raise _CancelledError()

            result = await _generate_example(
                api_key, config, cat, topic, outline, effective_model, effective_provider
            )
            await asyncio.sleep(delay)

        if result is None:
            logger.warning(
                "[job %s] Generation failed for '%s' (category '%s') — "
                "retrying with next topic. Attempt %d/%d",
                job_id, topic, cat.name, total_attempts, max_attempts,
            )
            progress.categories[cat.name].skipped += 1
            progress.skipped += 1
            await _update_progress(db, job_id, "running", progress)
            continue

        content, tokens = result
        judge_score: int | None = None
        save_this = True

        if config.judge_enabled:
            effective_judge_model = config.judge_model or config.model
            if progress.judge_stats is None:
                progress.judge_stats = JudgeStats()
            accepted = False
            MAX_JUDGE_RETRIES = 3

            for attempt in range(MAX_JUDGE_RETRIES):
                if is_cancelled(job_id):
                    raise _CancelledError()
                progress.judge_stats.evaluated += 1
                async with _judge_semaphore:
                    score = await _judge_example(
                        content, config.format, effective_judge_model, api_key,
                        judge_criteria=config.judge_criteria,
                        provider=config.judge_provider,
                    )
                await asyncio.sleep(delay)

                if score is None:
                    accepted = True
                    progress.judge_stats.accepted += 1
                    break
                if score >= config.judge_threshold:
                    judge_score = score
                    accepted = True
                    progress.judge_stats.accepted += 1
                    break
                judge_score = score
                if attempt == MAX_JUDGE_RETRIES - 1:
                    progress.judge_stats.rejected += 1

            if not accepted:
                logger.warning(
                    "[job %s] Judge rejected '%s' (score=%s < %d) — retrying with next topic",
                    job_id, topic, judge_score, config.judge_threshold,
                )
                progress.categories[cat.name].skipped += 1
                progress.skipped += 1
                save_this = False

        if save_this:
            await _save_example(db, job_id, content, config.format, tokens, judge_score)
            progress.categories[cat.name].completed += 1
            progress.completed += 1

        await _update_progress(db, job_id, "running", progress)

    if progress.categories[cat.name].completed < cat_target:
        logger.warning(
            "[job %s] Category '%s': reached attempt limit (%d) — "
            "achieved %d/%d examples",
            job_id, cat.name, max_attempts,
            progress.categories[cat.name].completed, cat_target,
        )


async def run_job(job_id: str, config: JobConfig, api_key: str) -> None:
    """
    Execute the full Plan-then-Execute pipeline for a job.

    Stage 1: Generate topics per category (sequential, 1 LLM call/category).
    Stage 2+3: All categories run in parallel via asyncio.gather.
              _gen_semaphore(10) limits total concurrent generation API calls.
              _judge_semaphore(3) limits concurrent judge calls.
            - Each failed example (generation error / judge rejection) is
              skipped and a fresh topic is tried immediately.
            - When all pre-generated topics are used up, new topics are
              generated on-the-fly so the job always tries to reach the
              requested count.
            - Safety limit: at most MAX_ATTEMPTS_PER_EXAMPLE × target
              attempts per category (prevents infinite loop on total failure).

    Progress and status are persisted to SQLite after every example.
    Checks is_cancelled(job_id) before each LLM call.
    """
    from app.database import get_db

    db = await get_db()
    counts = distribute_examples(config.categories, config.total_examples)
    delay = config.delay_between_requests if config.delay_between_requests is not None else 2.0

    progress = ProgressJson(
        total_examples=config.total_examples,
        completed=0,
        skipped=0,
        current_stage="generating_topics",
        categories={
            c.name: CategoryProgress(target=n, completed=0, skipped=0)
            for c, n in zip(config.categories, counts)
        },
    )
    await _update_progress(db, job_id, "running", progress)

    try:
        # ── Stage 1: Generate initial topics (sequential) ─────────────────
        all_topics: dict[str, list[str]] = {}
        for cat, count in zip(config.categories, counts):
            if is_cancelled(job_id):
                raise _CancelledError()
            progress.current_category = cat.name
            await _update_progress(db, job_id, "running", progress)

            topics = await _generate_topics(api_key, config, cat, min(TOPIC_BATCH_SIZE, count))
            all_topics[cat.name] = topics
            await asyncio.sleep(delay)

        # ── Stage 2+3: All categories in parallel ─────────────────────────
        progress.current_stage = "generating_examples"
        await _update_progress(db, job_id, "running", progress)

        tasks = [
            asyncio.create_task(
                _run_category(cat, count, config, api_key, db, job_id, progress, all_topics, delay),
                name=f"cat-{cat.name}",
            )
            for cat, count in zip(config.categories, counts)
        ]
        try:
            await asyncio.gather(*tasks)
        except Exception:
            for t in tasks:
                if not t.done():
                    t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise

        progress.current_stage = "completed"
        logger.info(
            "[job %s] Completed — generated: %d, skipped: %d (total requested: %d)",
            job_id, progress.completed, progress.skipped, progress.total_examples,
        )

        # Actual cost — SUM(tokens) z tabeli examples × cena per token
        if config.model_price_per_token > 0:
            async with db.execute(
                "SELECT COALESCE(SUM(tokens), 0) FROM examples WHERE job_id = ?", (job_id,)
            ) as cur:
                row = await cur.fetchone()
            progress.actual_cost = (row[0] or 0) * config.model_price_per_token

        # Judge cost — estymacja: evaluated × ~400 tokenów na wywołanie × cena
        if config.judge_enabled and config.judge_price_per_token > 0 and progress.judge_stats:
            _AVG_JUDGE_TOKENS = 400
            progress.judge_cost = (
                progress.judge_stats.evaluated * _AVG_JUDGE_TOKENS * config.judge_price_per_token
            )

        # Avg judge score — AVG(judge_score) dla zakończonego joba
        if config.judge_enabled and progress.judge_stats:
            async with db.execute(
                "SELECT AVG(judge_score) FROM examples WHERE job_id = ? AND judge_score IS NOT NULL",
                (job_id,),
            ) as cur:
                row = await cur.fetchone()
            progress.judge_stats.avg_score = round(row[0], 1) if row[0] is not None else None

        await _update_progress(db, job_id, "completed", progress)
        try:
            await export_job(job_id, db)
        except Exception:
            logger.exception("Auto-export failed for job %s (non-fatal)", job_id)

    except _CancelledError:
        progress.current_stage = "cancelled"
        await _update_progress(db, job_id, "cancelled", progress)

    except Exception:
        logger.exception("Job %s failed with unhandled exception", job_id)
        progress.current_stage = "failed"
        await _update_progress(db, job_id, "failed", progress)

    finally:
        clear_cancellation(job_id)
