from __future__ import annotations

import asyncio
import collections
import json
import logging
import re
import uuid
from typing import Any

import aiosqlite

from app.models.jobs import CategoryConfig, CategoryProgress, JobConfig, JudgeStats, ProgressJson
from app.utils import now_iso as _now_iso
from app.services.event_log import log_event
from app.services.example_schema import validate_example
from app.services.export_service import export_job
from app.services.llm.base import LLMError, LLMProvider
from app.services.llm.registry import get_provider
from app.services.prompt_builder import (
    build_example_generation_prompt,
    build_outline_generation_prompt,
    build_topic_generation_prompt,
)
from app.services.token_counter import count_tokens, effective_limit  # noqa: F401  (re-exported for tests)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Cancellation registry
# ---------------------------------------------------------------------------

_cancelled_jobs: set[str] = set()
_running_jobs: set[str] = set()
# Live asyncio.Task per running job. Used to break out of in-flight provider
# calls (httpx) so cancel feels instant instead of waiting up to REQUEST_TIMEOUT
# (480s) for the current chat() to return on its own.
_job_tasks: dict[str, "asyncio.Task[None]"] = {}

TOPIC_BATCH_SIZE = 10
_judge_semaphore = asyncio.Semaphore(3)
_gen_semaphore = asyncio.Semaphore(10)

# Reasoning models (Qwen3, Gemma 4, Devstral, Mistral Small 2603) can consume
# a large share of max_tokens on <think> blocks before generating content.
# We send 2× the user-facing budget to providers that support reasoning so
# reasoning fits in the overflow half, while the prompt still targets ~70% of
# the user value. Local providers (Ollama, LM Studio) advertise no reasoning,
# so the multiplier resolves to 1× and we don't waste tokens.
API_TOKEN_MULTIPLIER_REASONING = 2
API_TOKEN_MULTIPLIER_PLAIN = 1


def _api_token_multiplier(provider: LLMProvider) -> int:
    return (
        API_TOKEN_MULTIPLIER_REASONING
        if provider.capabilities.supports_reasoning
        else API_TOKEN_MULTIPLIER_PLAIN
    )


def cancel_job(job_id: str) -> None:
    """Mark a job cancelled and interrupt its in-flight provider call.

    Setting the flag alone only stops the loop *between* LLM calls — fine for
    cloud APIs that answer in seconds, miserable for a local 14B model that
    can sit on a single chat() for minutes. Calling task.cancel() propagates
    asyncio.CancelledError into the awaiting httpx request so the connection
    is torn down immediately and run_job's except branch finalises the job.
    """
    _cancelled_jobs.add(job_id)
    task = _job_tasks.get(job_id)
    if task is not None and not task.done():
        task.cancel()


def is_cancelled(job_id: str) -> bool:
    return job_id in _cancelled_jobs


def clear_cancellation(job_id: str) -> None:
    _cancelled_jobs.discard(job_id)


def is_running(job_id: str) -> bool:
    return job_id in _running_jobs


class _CancelledError(Exception):
    """Internal signal for clean job cancellation."""


class AlreadyRunningError(Exception):
    """Raised when a resume/run is attempted on a job already in flight."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------



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
    """Return the text content from an LLM response, stripped of think blocks.

    Handles:
    - None content (models that put reasoning in a separate 'reasoning' field)
    - <think>...</think> blocks (Qwen3 and similar reasoning models)
    """
    try:
        raw = response["choices"][0]["message"].get("content") or ""
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError(f"Invalid LLM response structure: {exc}") from exc
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


def _extract_usage(response: dict) -> dict:
    """Extract prompt_tokens and completion_tokens from an LLM response.

    Subtracts reasoning tokens from completion_tokens so that only real
    output tokens are counted (for display, cost, and limit checks).
    """
    usage = response.get("usage") or {}
    completion = usage.get("completion_tokens", 0)
    reasoning = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens", 0)
    return {
        "prompt_tokens": usage.get("prompt_tokens", 0),
        "completion_tokens": max(completion - reasoning, 0),
    }


def _validate_example_structure(parsed: Any, fmt: str) -> tuple[bool, str | None, str | None]:
    """Strict structural check delegating to example_schema.validate_example."""
    result = validate_example(parsed, fmt)
    return result["ok"], result["reason"], result["detail"]


async def _generate_and_validate_example(
    provider: LLMProvider,
    model: str,
    messages: list[dict],
    temperature: float,
    max_tokens: int,
    retry_cooldown: int = 15,
    provider_route: str | None = None,
    output_format: str = "sharegpt",
    job_id: str | None = None,
    category: str | None = None,
) -> tuple[dict, int, dict] | None:
    """
    Call the provider, parse JSON, validate structure and token count.
    On first attempt: full prompt.
    If token count exceeds effective_limit: one retry with conciseness hint.
    Returns (parsed_dict, token_count, usage_dict) or None.
    """
    provider_tag = provider_route or "auto"
    multiplier = _api_token_multiplier(provider)
    last_was_reasoning_starved = False
    for attempt in range(2):
        if attempt == 1:
            if last_was_reasoning_starved:
                # Local reasoning model burned the entire ×2 budget on
                # thinking and never got to write `content`. Conciseness
                # hint can't help — the model never reaches the user
                # message. Bump the budget instead so reasoning has room
                # AND content can land. Triggered only for providers that
                # don't surface reasoning_tokens (Ollama / LM Studio);
                # OpenRouter reports the breakdown so we never get here.
                multiplier *= 2
            else:
                messages = _inject_conciseness_hint(messages, int(max_tokens * 0.8))

        try:
            response = await provider.chat(
                model=model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens * multiplier,
                max_retries=1,  # pipeline-level retry handles failures; avoid 3×480s compounding
                retry_cooldown=retry_cooldown,
                provider_route=provider_route,
            )
        except LLMError as exc:
            logger.warning(
                "[gen-fail] API error: model=%s provider=%s attempt=%d status=%s body=%.300s",
                model, provider_tag, attempt + 1, exc.status_code, str(exc)[:300],
            )
            if job_id:
                log_event(
                    job_id, "generation_api_error",
                    category=category, attempt=attempt + 1,
                    model=model, provider=provider_tag, status_code=exc.status_code,
                )
            if attempt == 0:
                continue
            return None
        except Exception as exc:
            logger.warning(
                "[gen-fail] unexpected exception: model=%s provider=%s attempt=%d err=%r",
                model, provider_tag, attempt + 1, exc,
            )
            if job_id:
                log_event(
                    job_id, "generation_unexpected_error",
                    category=category, attempt=attempt + 1,
                    model=model, provider=provider_tag, error_type=type(exc).__name__,
                )
            if attempt == 0:
                continue
            return None

        try:
            raw = _extract_content(response)
        except ValueError as exc:
            response_keys = (
                list(response.keys()) if isinstance(response, dict)
                else type(response).__name__
            )
            logger.warning(
                "[gen-fail] invalid response structure: model=%s provider=%s attempt=%d err=%s keys=%s",
                model, provider_tag, attempt + 1, exc, response_keys,
            )
            if job_id:
                log_event(
                    job_id, "generation_invalid_structure",
                    category=category, attempt=attempt + 1,
                    model=model, provider=provider_tag,
                )
            if attempt == 0:
                continue
            return None

        if not raw:
            finish_reason = (response.get("choices") or [{}])[0].get("finish_reason")
            msg = ((response.get("choices") or [{}])[0].get("message") or {})
            has_reasoning = bool(msg.get("reasoning"))
            # Detect "reasoning starvation": the model emitted reasoning
            # (separate field or a `<think>` tag we already stripped) AND
            # ran out of budget AND the provider didn't break out
            # reasoning_tokens for us. OpenRouter populates
            # completion_tokens_details.reasoning_tokens, so this branch
            # only fires for local OpenAI-compat backends. Flag triggers
            # the ×4 budget retry on the next iteration.
            raw_usage = response.get("usage") or {}
            reasoning_reported = (raw_usage.get("completion_tokens_details") or {}).get("reasoning_tokens", 0)
            if (
                attempt == 0
                and finish_reason == "length"
                and has_reasoning
                and not reasoning_reported
            ):
                last_was_reasoning_starved = True
            logger.warning(
                "[gen-fail] empty content: model=%s provider=%s attempt=%d finish=%s has_reasoning=%s",
                model, provider_tag, attempt + 1, finish_reason, has_reasoning,
            )
            if job_id:
                log_event(
                    job_id, "generation_empty_response",
                    category=category, attempt=attempt + 1,
                    model=model, provider=provider_tag,
                    finish_reason=finish_reason, has_reasoning=has_reasoning,
                )
            if attempt == 0:
                continue
            return None

        try:
            parsed = _parse_json_response(raw)
        except ValueError as exc:
            logger.warning(
                "[gen-fail] JSON parse failed: model=%s provider=%s attempt=%d err=%s raw=%.300s",
                model, provider_tag, attempt + 1, exc, raw,
            )
            if job_id:
                log_event(
                    job_id, "generation_json_parse_error",
                    category=category, attempt=attempt + 1,
                    model=model, provider=provider_tag,
                )
            if attempt == 0:
                continue
            return None

        ok, reason, detail = _validate_example_structure(parsed, output_format)
        if not ok:
            logger.warning(
                "[gen-fail] invalid structure: model=%s provider=%s attempt=%d "
                "format=%s reason=%s detail=%s parsed_keys=%s preview=%.300s",
                model, provider_tag, attempt + 1, output_format, reason, detail,
                list(parsed.keys()) if isinstance(parsed, dict) else type(parsed).__name__,
                json.dumps(parsed, ensure_ascii=False)[:300],
            )
            if job_id:
                log_event(
                    job_id, "generation_invalid_structure",
                    category=category, attempt=attempt + 1,
                    model=model, provider=provider_tag, format=output_format,
                    reason=reason, detail=detail,
                )
            if attempt == 0:
                continue
            return None

        usage = _extract_usage(response)
        token_count = usage["completion_tokens"]
        if token_count <= max_tokens:
            return parsed, token_count, usage
        logger.warning(
            "[gen-fail] over token budget: model=%s provider=%s attempt=%d tokens=%d max=%d",
            model, provider_tag, attempt + 1, token_count, max_tokens,
        )
        if job_id:
            log_event(
                job_id, "generation_over_token_budget",
                category=category, attempt=attempt + 1,
                model=model, provider=provider_tag,
                tokens=token_count, max_tokens=max_tokens,
            )
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
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    model: str = "",
    judge_prompt_tokens: int = 0,
    judge_completion_tokens: int = 0,
    category: str = "",
) -> None:
    now = _now_iso()
    await db.execute(
        "INSERT INTO examples "
        "(id, job_id, content_json, format, tokens, created_at, judge_score, "
        " prompt_tokens, completion_tokens, model, judge_prompt_tokens, judge_completion_tokens, category) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            str(uuid.uuid4()), job_id, json.dumps(content), fmt,
            completion_tokens,  # tokens column = output tokens only (excludes prompt)
            now, judge_score,
            prompt_tokens, completion_tokens, model,
            judge_prompt_tokens, judge_completion_tokens,
            category,
        ),
    )
    await db.commit()


# ---------------------------------------------------------------------------
# Stage helpers
# ---------------------------------------------------------------------------

async def _generate_topics(
    provider: LLMProvider,
    config: JobConfig,
    cat: CategoryConfig,
    count: int,
    overhead: dict | None = None,
    job_id: str | None = None,
) -> list[str]:
    logger.info(
        "[_generate_topics] category='%s' requested=%d (TOPIC_BATCH_SIZE=%d)",
        cat.name, count, TOPIC_BATCH_SIZE,
    )
    if job_id:
        log_event(job_id, "topic_generation_start", category=cat.name, count=count)
    messages = build_topic_generation_prompt(cat.name, cat.description, count)
    effective_model = cat.model or config.model

    for _ in range(2):
        try:
            response = await provider.chat(
                model=effective_model,
                messages=messages,
                temperature=config.temperature,
                max_tokens=min(2048, config.max_tokens),
                max_retries=config.retry_count,
                retry_cooldown=config.retry_cooldown,
                provider_route=cat.provider,
            )
        except Exception:
            continue

        if overhead is not None:
            usage = _extract_usage(response)
            overhead["prompt_tokens"] = overhead.get("prompt_tokens", 0) + usage["prompt_tokens"]
            overhead["completion_tokens"] = overhead.get("completion_tokens", 0) + usage["completion_tokens"]
            overhead.setdefault("by_model", {})
            m = overhead["by_model"].setdefault(effective_model, {"prompt_tokens": 0, "completion_tokens": 0})
            m["prompt_tokens"] += usage["prompt_tokens"]
            m["completion_tokens"] += usage["completion_tokens"]

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
    provider: LLMProvider,
    config: JobConfig,
    cat: CategoryConfig,
    topic: str,
    model: str,
    provider_route: str | None = None,
    overhead: dict | None = None,
) -> list[str]:
    messages = build_outline_generation_prompt(cat.name, topic, category_description=cat.description)

    try:
        response = await provider.chat(
            model=model,
            messages=messages,
            temperature=config.temperature,
            max_tokens=512,
            max_retries=config.retry_count,
            retry_cooldown=config.retry_cooldown,
            provider_route=provider_route,
        )
    except Exception:
        return []

    if overhead is not None:
        usage = _extract_usage(response)
        overhead["prompt_tokens"] = overhead.get("prompt_tokens", 0) + usage["prompt_tokens"]
        overhead["completion_tokens"] = overhead.get("completion_tokens", 0) + usage["completion_tokens"]
        overhead.setdefault("by_model", {})
        m = overhead["by_model"].setdefault(model, {"prompt_tokens": 0, "completion_tokens": 0})
        m["prompt_tokens"] += usage["prompt_tokens"]
        m["completion_tokens"] += usage["completion_tokens"]

    raw = _extract_content(response)
    try:
        points = _parse_json_response(raw)
        if isinstance(points, list):
            return [str(p) for p in points[:4]]
    except ValueError:
        pass
    return []


_EMPTY_USAGE: dict = {"prompt_tokens": 0, "completion_tokens": 0}


async def _judge_example(
    provider: LLMProvider,
    content: dict,
    fmt: str,
    model: str,
    judge_criteria: str = "relevance, coherence, naturalness, and educational value",
    provider_route: str | None = None,
) -> tuple[int | None, dict]:
    """Call LLM judge to rate an example on 0-100 scale. Returns (score_or_None, usage_dict)."""
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
        response = await provider.chat(
            model=model,
            messages=messages,
            temperature=0.1,
            max_tokens=1024,  # reasoning models (Qwen3) need space for <think> block
            max_retries=3,    # retry on 429/500 — judge score matters when judge is enabled
            provider_route=provider_route,
        )
        usage = _extract_usage(response)
        parsed = _parse_json_response(_extract_content(response))
        score = parsed.get("score")
        if isinstance(score, (int, float)) and 0 <= score <= 100:
            return int(score), usage
        return None, usage
    except Exception:
        logger.warning("Judge call failed (non-fatal)", exc_info=True)
        return None, _EMPTY_USAGE


async def _generate_example(
    provider: LLMProvider,
    config: JobConfig,
    cat: CategoryConfig,
    topic: str,
    outline: list[str],
    model: str,
    provider_route: str | None = None,
    job_id: str | None = None,
) -> tuple[dict, int] | None:
    messages = build_example_generation_prompt(
        category_name=cat.name,
        topic=topic,
        outline_points=outline or [f"Cover the topic: {topic}"],
        output_format=config.format,
        max_tokens=config.max_tokens,
        conversation_turns=config.conversation_turns,
        category_description=cat.description,
    )
    return await _generate_and_validate_example(
        provider=provider,
        model=model,
        messages=messages,
        temperature=config.temperature,
        max_tokens=config.max_tokens,
        retry_cooldown=config.retry_cooldown,
        provider_route=provider_route,
        output_format=config.format,
        job_id=job_id,
        category=cat.name,
    )


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

# Maximum number of topic attempts per desired example before giving up.
# E.g. target=10 → try at most 50 topics per category.
MAX_ATTEMPTS_PER_EXAMPLE = 5


async def _resolve_category_providers(
    db: aiosqlite.Connection,
    cat: CategoryConfig,
    config: JobConfig,
) -> tuple[LLMProvider, LLMProvider | None]:
    """Resolve gen + (optional) judge provider for a category.

    Falls back through cat → job → default. The judge provider falls back to the
    gen provider when the user didn't pick a different one — same model with a
    different system prompt is the common case.
    """
    gen_id = cat.provider_id or config.provider_id
    gen_provider = await get_provider(db, gen_id)

    if not config.judge_enabled:
        return gen_provider, None

    judge_id = (
        cat.judge_provider_id
        or config.judge_provider_id
        or cat.provider_id
        or config.provider_id
    )
    judge_provider = await get_provider(db, judge_id)
    return gen_provider, judge_provider


async def _run_category(
    cat: CategoryConfig,
    count: int,
    config: JobConfig,
    gen_provider: LLMProvider,
    judge_provider: LLMProvider | None,
    db: aiosqlite.Connection,
    job_id: str,
    progress: ProgressJson,
    all_topics: dict[str, list[str]],
    delay: float,
    overhead: dict | None = None,
) -> None:
    """Run the generation loop for a single category (called via asyncio.gather)."""
    cat_target = count
    topic_queue: collections.deque[str] = collections.deque(
        all_topics.get(cat.name, [])
    )
    max_attempts = cat_target * MAX_ATTEMPTS_PER_EXAMPLE
    total_attempts = 0
    effective_model = cat.model or config.model
    effective_provider_route = cat.provider
    effective_judge_model = cat.judge_model or config.judge_model or config.model
    effective_judge_provider_route = cat.judge_provider or config.judge_provider

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
            log_event(job_id, "topics_exhausted_regenerating", category=cat.name, needed=needed)
            extra = await _generate_topics(
                gen_provider, config, cat, min(TOPIC_BATCH_SIZE, needed),
                overhead=overhead, job_id=job_id,
            )
            topic_queue.extend(extra)
            await asyncio.sleep(delay)
            if not topic_queue:
                logger.warning(
                    "[job %s] Could not generate more topics for '%s' — stopping",
                    job_id, cat.name,
                )
                log_event(job_id, "topics_generation_failed", category=cat.name)
                break

        total_attempts += 1
        topic = topic_queue.popleft()
        await _update_progress(db, job_id, "running", progress)

        async with _gen_semaphore:
            outline = await _generate_outline(
                gen_provider, config, cat, topic, effective_model, effective_provider_route,
                overhead=overhead
            )
        await asyncio.sleep(delay)

        if is_cancelled(job_id):
            raise _CancelledError()

        async with _gen_semaphore:
            result = await _generate_example(
                gen_provider, config, cat, topic, outline, effective_model, effective_provider_route,
                job_id=job_id,
            )
        await asyncio.sleep(delay)

        if result is None:
            logger.warning(
                "[job %s] Generation failed for '%s' (category '%s') — "
                "retrying with next topic. Attempt %d/%d",
                job_id, topic, cat.name, total_attempts, max_attempts,
            )
            log_event(
                job_id, "generation_failed_retrying",
                category=cat.name, topic=topic,
                attempt=total_attempts, max_attempts=max_attempts,
            )
            progress.categories[cat.name].skipped += 1
            progress.skipped += 1
            await _update_progress(db, job_id, "running", progress)
            continue

        content, tokens, gen_usage = result
        judge_score: int | None = None
        save_this = True
        total_judge_prompt = 0
        total_judge_completion = 0

        if config.judge_enabled and judge_provider is not None:
            if progress.judge_stats is None:
                progress.judge_stats = JudgeStats()
            accepted = False
            MAX_JUDGE_RETRIES = 3

            # Increment once per unique example (not per retry attempt)
            progress.judge_stats.evaluated += 1

            for attempt in range(MAX_JUDGE_RETRIES):
                if is_cancelled(job_id):
                    raise _CancelledError()
                async with _judge_semaphore:
                    score, judge_usage = await _judge_example(
                        judge_provider, content, config.format, effective_judge_model,
                        judge_criteria=config.judge_criteria,
                        provider_route=effective_judge_provider_route,
                    )
                total_judge_prompt += judge_usage["prompt_tokens"]
                total_judge_completion += judge_usage["completion_tokens"]
                await asyncio.sleep(delay)

                if score is None:
                    # Judge failed (empty response, parse error) — retry
                    if attempt < MAX_JUDGE_RETRIES - 1:
                        logger.warning(
                            "[job %s] Judge returned no score for '%s' — retry %d/%d",
                            job_id, topic, attempt + 1, MAX_JUDGE_RETRIES,
                        )
                        log_event(
                            job_id, "judge_no_score_retry",
                            category=cat.name, topic=topic,
                            attempt=attempt + 1, max_retries=MAX_JUDGE_RETRIES,
                        )
                        continue
                    # All retries exhausted — skip this example
                    logger.warning(
                        "[job %s] Judge failed all %d attempts for '%s' — skipping",
                        job_id, MAX_JUDGE_RETRIES, topic,
                    )
                    log_event(
                        job_id, "judge_failed_all_retries",
                        category=cat.name, topic=topic,
                        max_retries=MAX_JUDGE_RETRIES,
                    )
                    progress.judge_stats.rejected += 1
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
                if judge_score is not None:
                    log_event(
                        job_id, "judge_rejected_below_threshold",
                        category=cat.name, topic=topic,
                        score=judge_score, threshold=config.judge_threshold,
                    )
                progress.categories[cat.name].skipped += 1
                progress.skipped += 1
                save_this = False

        if save_this:
            await _save_example(
                db, job_id, content, config.format, tokens, judge_score,
                prompt_tokens=gen_usage["prompt_tokens"],
                completion_tokens=gen_usage["completion_tokens"],
                model=effective_model,
                judge_prompt_tokens=total_judge_prompt,
                judge_completion_tokens=total_judge_completion,
                category=cat.name,
            )
            progress.categories[cat.name].completed += 1
            progress.completed += 1
            if judge_score is not None:
                log_event(
                    job_id, "example_accepted",
                    category=cat.name, score=judge_score,
                )
            else:
                log_event(job_id, "example_accepted_no_judge", category=cat.name)

        await _update_progress(db, job_id, "running", progress)

    if progress.categories[cat.name].completed < cat_target:
        logger.warning(
            "[job %s] Category '%s': reached attempt limit (%d) — "
            "achieved %d/%d examples",
            job_id, cat.name, max_attempts,
            progress.categories[cat.name].completed, cat_target,
        )
        log_event(
            job_id, "category_attempt_limit_reached",
            category=cat.name,
            completed=progress.categories[cat.name].completed,
            target=cat_target,
        )


async def run_job(
    job_id: str,
    config: JobConfig,
    resume_progress: ProgressJson | None = None,
) -> None:
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

    Provider resolution:
      - Per-category gen + judge providers are resolved from the DB once before
        the parallel stage starts, so a single provider lookup serves the whole
        category run.

    Progress and status are persisted to SQLite after every example.
    Checks is_cancelled(job_id) before each LLM call.

    When `resume_progress` is provided, skips the zero-initialization of
    progress and uses the caller-supplied state instead (for resume).
    The target-seeking loop in _run_category naturally stops at target.
    """
    from app.database import get_db

    if job_id in _running_jobs:
        raise AlreadyRunningError(f"Job {job_id} is already running")
    _running_jobs.add(job_id)
    # Register the running task so cancel_job() can interrupt in-flight LLM
    # calls instead of waiting for them to time out.
    current_task = asyncio.current_task()
    if current_task is not None:
        _job_tasks[job_id] = current_task

    db = await get_db()
    counts = distribute_examples(config.categories, config.total_examples)
    delay = config.delay_between_requests if config.delay_between_requests is not None else 2.0

    if resume_progress is not None:
        progress = resume_progress
        progress.current_stage = "generating_topics"
        progress.current_category = None
    else:
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

    overhead: dict = {}  # accumulates topic + outline usage for cost calculation

    try:
        # ── Resolve providers per category up front ───────────────────────
        cat_providers: dict[str, tuple[LLMProvider, LLMProvider | None]] = {}
        for cat in config.categories:
            cat_providers[cat.name] = await _resolve_category_providers(db, cat, config)

        # ── Stage 1: Generate initial topics (sequential) ─────────────────
        all_topics: dict[str, list[str]] = {}
        for cat, count in zip(config.categories, counts):
            if is_cancelled(job_id):
                raise _CancelledError()
            progress.current_category = cat.name
            await _update_progress(db, job_id, "running", progress)

            gen_provider, _judge = cat_providers[cat.name]
            topics = await _generate_topics(
                gen_provider, config, cat, min(TOPIC_BATCH_SIZE, count),
                overhead=overhead, job_id=job_id,
            )
            all_topics[cat.name] = topics
            await asyncio.sleep(delay)

        # ── Stage 2+3: All categories in parallel ─────────────────────────
        progress.current_stage = "generating_examples"
        progress.current_category = None  # all categories run simultaneously
        await _update_progress(db, job_id, "running", progress)

        tasks = []
        for cat, count in zip(config.categories, counts):
            gen_provider, judge_provider = cat_providers[cat.name]
            tasks.append(
                asyncio.create_task(
                    _run_category(
                        cat, count, config,
                        gen_provider, judge_provider,
                        db, job_id, progress, all_topics, delay,
                        overhead=overhead,
                    ),
                    name=f"cat-{cat.name}",
                )
            )
        try:
            await asyncio.gather(*tasks)
        except (Exception, asyncio.CancelledError):
            # Catch CancelledError too: when cancel_job() cancels the outer
            # run_job task, asyncio propagates the cancel into this gather,
            # and we want to actively cancel each per-category subtask so
            # their httpx requests close instead of leaking.
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
        log_event(job_id, "job_completed", completed=progress.completed)

        # Actual cost — per-model pricing from real usage
        cat_prices = {
            (c.model or config.model): (c.prompt_price, c.completion_price)
            for c in config.categories
        }
        # Judge pricing per category (fallback: global → legacy)
        j_pp_fallback = config.judge_prompt_price or config.judge_price_per_token
        j_cp_fallback = config.judge_completion_price or config.judge_price_per_token
        cat_judge_prices = {
            c.name: (
                c.judge_prompt_price or j_pp_fallback,
                c.judge_completion_price or j_cp_fallback,
            )
            for c in config.categories
        }
        async with db.execute(
            "SELECT category, model, "
            "       COALESCE(SUM(prompt_tokens), 0), COALESCE(SUM(completion_tokens), 0), "
            "       COALESCE(SUM(judge_prompt_tokens), 0), COALESCE(SUM(judge_completion_tokens), 0) "
            "FROM examples WHERE job_id = ? GROUP BY category, model",
            (job_id,),
        ) as cur:
            rows = await cur.fetchall()

        has_new_usage = any(r[2] > 0 or r[3] > 0 for r in rows)
        if has_new_usage:
            gen_cost = 0.0
            judge_cost = 0.0
            for cat_name, model_id, pt, ct, jpt, jct in rows:
                pp, cp = cat_prices.get(model_id, (0.0, 0.0))
                gen_cost += pt * pp + ct * cp
                j_pp, j_cp = cat_judge_prices.get(cat_name, (j_pp_fallback, j_cp_fallback))
                judge_cost += jpt * j_pp + jct * j_cp
            # Add overhead (topic + outline generation costs)
            for oh_model, oh_usage in overhead.get("by_model", {}).items():
                pp, cp = cat_prices.get(oh_model, (0.0, 0.0))
                gen_cost += oh_usage["prompt_tokens"] * pp + oh_usage["completion_tokens"] * cp
            if gen_cost > 0:
                progress.actual_cost = gen_cost
            if judge_cost > 0:
                progress.judge_cost = judge_cost
        else:
            # Fallback for old jobs (pre-migration) — use legacy averaged pricing
            if config.model_price_per_token > 0:
                total_tokens = sum(r[2] + r[3] for r in rows) or 0
                if total_tokens == 0:
                    async with db.execute(
                        "SELECT COALESCE(SUM(tokens), 0) FROM examples WHERE job_id = ?", (job_id,)
                    ) as cur:
                        row = await cur.fetchone()
                    total_tokens = row[0] or 0
                progress.actual_cost = total_tokens * config.model_price_per_token
            if config.judge_enabled and config.judge_price_per_token > 0 and progress.judge_stats:
                progress.judge_cost = (
                    progress.judge_stats.evaluated * 400 * config.judge_price_per_token
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
            from app.services.stats_service import compute_and_store
            await compute_and_store(
                db, job_id, judge_enabled=config.judge_enabled, progress=progress
            )
        except Exception:
            logger.exception("Stats snapshot failed for job %s (non-fatal)", job_id)
        try:
            await export_job(job_id, db)
        except Exception:
            logger.exception("Auto-export failed for job %s (non-fatal)", job_id)

    except (_CancelledError, asyncio.CancelledError):
        # asyncio.CancelledError fires when cancel_job() called task.cancel()
        # mid-LLM-call; _CancelledError fires from the cooperative checks
        # between calls. Both end the same way: write the terminal state.
        # Shield the DB write so a back-to-back second cancel can't tear it
        # down half-committed.
        progress.current_stage = "cancelled"
        try:
            await asyncio.shield(_update_progress(db, job_id, "cancelled", progress))
        except Exception:
            logger.exception("Failed to persist cancelled status for job %s", job_id)
        # Do NOT re-raise asyncio.CancelledError — fire-and-forget background
        # task: nobody awaits us, and propagating would mark the task FAILED
        # in the asyncio bookkeeping for no benefit.

    except Exception:
        logger.exception("Job %s failed with unhandled exception", job_id)
        progress.current_stage = "failed"
        try:
            await asyncio.shield(_update_progress(db, job_id, "failed", progress))
        except Exception:
            logger.exception("Failed to persist failed status for job %s", job_id)

    finally:
        clear_cancellation(job_id)
        _running_jobs.discard(job_id)
        _job_tasks.pop(job_id, None)


async def resume_job(job_id: str) -> None:
    """
    Resume a previously interrupted or cancelled job.

    Reconstructs ProgressJson from DB state:
      - completed counts come from the `examples` table (actual rows)
      - skipped counts are read from the stored progress_json (best effort)
      - judge_stats preserved from stored progress_json if present

    Delegates to run_job() with the reconstructed progress. The target-seeking
    loop in _run_category naturally resumes from the current completed count.
    """
    from app.database import get_db

    db = await get_db()
    async with await db.execute(
        "SELECT status, config_json, progress_json FROM jobs WHERE id = ?",
        (job_id,),
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise LookupError(f"Job {job_id} not found")
    # 'pending' is allowed — the resume endpoint sets it before spawning this task.
    if row["status"] not in ("interrupted", "cancelled", "pending"):
        raise ValueError(f"Job {job_id} has status {row['status']}, not resumable")

    config = JobConfig.model_validate_json(row["config_json"])
    counts = distribute_examples(config.categories, config.total_examples)
    cat_targets = {c.name: n for c, n in zip(config.categories, counts)}

    async with await db.execute(
        "SELECT category, COUNT(*) AS n FROM examples WHERE job_id = ? GROUP BY category",
        (job_id,),
    ) as cur:
        db_counts = {r["category"]: r["n"] for r in await cur.fetchall()}

    stored_progress: ProgressJson | None = None
    if row["progress_json"]:
        try:
            stored_progress = ProgressJson.model_validate_json(row["progress_json"])
        except Exception:
            stored_progress = None

    stored_cat = stored_progress.categories if stored_progress else {}
    categories: dict[str, CategoryProgress] = {}
    for name, target in cat_targets.items():
        completed = db_counts.get(name, 0)
        skipped = stored_cat.get(name).skipped if name in stored_cat else 0
        categories[name] = CategoryProgress(
            target=target,
            completed=completed,
            skipped=skipped,
        )

    total_completed = sum(c.completed for c in categories.values())
    total_skipped = sum(c.skipped for c in categories.values())

    resume_progress_obj = ProgressJson(
        total_examples=config.total_examples,
        completed=total_completed,
        skipped=total_skipped,
        current_stage="generating_topics",
        current_category=None,
        categories=categories,
        judge_stats=stored_progress.judge_stats if stored_progress else None,
    )

    log_event(job_id, "job_resumed", completed=total_completed, target=config.total_examples)
    await run_job(job_id, config, resume_progress=resume_progress_obj)
