from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any

import aiosqlite

from app.models.jobs import CategoryConfig, CategoryProgress, JobConfig, ProgressJson
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
            )
        except OpenRouterError:
            return None

        raw = response["choices"][0]["message"]["content"]

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
) -> None:
    now = _now_iso()
    await db.execute(
        "INSERT INTO examples (id, job_id, content_json, format, tokens, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), job_id, json.dumps(content), fmt, tokens, now),
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
    messages = build_topic_generation_prompt(cat.name, cat.description, count)

    for _ in range(2):
        try:
            response = await chat_completion(
                api_key=api_key,
                model=config.model,
                messages=messages,
                temperature=config.temperature,
                max_tokens=min(2048, config.max_tokens),
            )
        except OpenRouterError:
            continue

        raw = response["choices"][0]["message"]["content"]
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
) -> list[str]:
    messages = build_outline_generation_prompt(cat.name, topic)

    try:
        response = await chat_completion(
            api_key=api_key,
            model=config.model,
            messages=messages,
            temperature=config.temperature,
            max_tokens=512,
        )
    except OpenRouterError:
        return []

    raw = response["choices"][0]["message"]["content"]
    try:
        points = _parse_json_response(raw)
        if isinstance(points, list):
            return [str(p) for p in points[:4]]
    except ValueError:
        pass
    return []


async def _generate_example(
    api_key: str,
    config: JobConfig,
    cat: CategoryConfig,
    topic: str,
    outline: list[str],
) -> tuple[dict, int] | None:
    messages = build_example_generation_prompt(
        category_name=cat.name,
        topic=topic,
        outline_points=outline or [f"Cover the topic: {topic}"],
        output_format=config.format,
        max_tokens=config.max_tokens,
    )
    return await _generate_and_validate_example(
        api_key=api_key,
        model=config.model,
        messages=messages,
        temperature=config.temperature,
        max_tokens=config.max_tokens,
    )


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

async def run_job(job_id: str, config: JobConfig, api_key: str) -> None:
    """
    Execute the full Plan-then-Execute pipeline for a job.

    Stage 1: Generate topics per category (1 LLM call/category).
    Stage 2+3: For each topic — generate outline, then generate example.

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
        # ── Stage 1: Generate topics ──────────────────────────────────────
        all_topics: dict[str, list[str]] = {}
        for cat, count in zip(config.categories, counts):
            if is_cancelled(job_id):
                raise _CancelledError()
            progress.current_category = cat.name
            await _update_progress(db, job_id, "running", progress)

            topics = await _generate_topics(api_key, config, cat, count)
            all_topics[cat.name] = topics
            await asyncio.sleep(delay)

        # ── Stage 2+3: Outline + Example per topic ────────────────────────
        progress.current_stage = "generating_examples"
        for cat, _ in zip(config.categories, counts):
            topics = all_topics.get(cat.name, [])
            for topic in topics:
                if is_cancelled(job_id):
                    raise _CancelledError()

                outline = await _generate_outline(api_key, config, cat, topic)
                await asyncio.sleep(delay)

                if is_cancelled(job_id):
                    raise _CancelledError()

                result = await _generate_example(api_key, config, cat, topic, outline)
                await asyncio.sleep(delay)

                if result is not None:
                    content, tokens = result
                    await _save_example(db, job_id, content, config.format, tokens)
                    progress.categories[cat.name].completed += 1
                    progress.completed += 1
                else:
                    progress.categories[cat.name].skipped += 1
                    progress.skipped += 1

                progress.current_category = cat.name
                await _update_progress(db, job_id, "running", progress)

        progress.current_stage = "completed"
        await _update_progress(db, job_id, "completed", progress)

    except _CancelledError:
        progress.current_stage = "cancelled"
        await _update_progress(db, job_id, "cancelled", progress)

    except Exception:
        logger.exception("Job %s failed with unhandled exception", job_id)
        progress.current_stage = "failed"
        await _update_progress(db, job_id, "failed", progress)

    finally:
        clear_cancellation(job_id)
