"""Async reasoning task — background execution of POST /api/jobs/{id}/add-reasoning.

Architecture mirror of merge_service: validation is synchronous (so a bad
request never leaves a zombie job), the actual work runs in
``asyncio.create_task`` and progress is surfaced through the existing
``GET /jobs/{id}/stream`` SSE. The reasoning pass is a new row in ``jobs`` with
``parent_job_id`` pointing at the source dataset; examples are copied
physically (so dedup/delete on the source can't corrupt downstream training
artifacts) and ``examples.reasoning`` is filled in per row by a separate LLM
call. The source ``content_json`` is never touched, so re-running reasoning
with a different ``reasoning_format`` produces a clean independent job.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from typing import Any

import aiosqlite
from fastapi import HTTPException

from app.config import settings
from app.models.jobs import (
    CategoryProgress,
    JobConfig,
    ProgressJson,
    ReasoningRequest,
    ReasoningResponse,
)
from app.services.event_log import log_event
from app.services.example_schema import (
    SUPPORTED_FORMATS,
    count_assistant_turns,
    strip_to_schema,
)
from app.services.job_runner import (
    _CancelledError,
    _job_tasks,
    _running_jobs,
    _update_progress,
    clear_cancellation,
    is_cancelled,
)
from app.services.llm.base import LLMError, LLMProvider
from app.services.llm.registry import (
    ProviderDisabledError,
    ProviderNotFoundError,
    get_provider,
)
from app.services.stats_service import compute_and_store
from app.services.token_counter import count_tokens
from app.utils import now_iso as _now_iso

logger = logging.getLogger(__name__)

# Same batch + insert SQL as merge — the reasoning copy phase reuses the
# physical-copy mechanics that merge already exercises at scale.
_REASONING_COPY_BATCH = 1000

_REASONING_INSERT_SQL = (
    "INSERT INTO examples "
    "(id, job_id, content_json, format, tokens, judge_score, category, model, "
    "prompt_tokens, completion_tokens, judge_prompt_tokens, judge_completion_tokens) "
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)

_UPDATE_REASONING_SQL = (
    "UPDATE examples SET reasoning = ?, reasoning_model_used = ? WHERE id = ?"
)

# Per-provider lock for backends that can't serve parallel chats (Ollama,
# LM Studio — single GPU contention). Different local providers each get
# their own lock so a user with two distinct local backends still benefits
# from inter-provider parallelism.
_local_provider_locks: dict[str, asyncio.Lock] = {}

# Reuse the existing generation semaphore to bound total in-flight provider
# calls across the process (gen + reasoning together).
_REASONING_GEN_SEMAPHORE = asyncio.Semaphore(10)


# ---------------------------------------------------------------------------
# Prose validation
# ---------------------------------------------------------------------------

_THINK_RE = re.compile(r"<think>[\s\S]*?</think>", re.IGNORECASE)
_CODE_FENCE_RE = re.compile(r"```")
_MIN_REASONING_TOKENS = 20
_MAX_REASONING_TOKENS = 400


def _validate_single_prose(cleaned: str) -> str | None:
    """Validate ONE rationale string (post-strip). Returns reject reason or None.

    Used both for legacy single-prose validation and per-element validation
    when the LLM hands back a JSON array of rationales (one per assistant
    turn). The same length / shape / "looks-like-prose" rules apply to each.
    """
    if not cleaned:
        return "empty_after_strip"
    if _CODE_FENCE_RE.search(cleaned):
        return "code_fence"
    if cleaned[0] in "{[":
        return "json_shaped"
    tokens = count_tokens(cleaned)
    if tokens < _MIN_REASONING_TOKENS:
        return f"too_short ({tokens} tokens)"
    if tokens > _MAX_REASONING_TOKENS:
        return f"too_long ({tokens} tokens)"
    return None


def _strip_and_validate_prose(raw: str) -> tuple[str | None, str | None]:
    """Single-prose validation (kept for tests + the legacy path). Use
    ``_parse_and_validate_prose_list`` for the new multi-turn flow."""
    cleaned = _THINK_RE.sub("", raw or "").strip()
    reason = _validate_single_prose(cleaned)
    return (None, reason) if reason else (cleaned, None)


# Matches a turn header line: `=== TURN 1 ===`, tolerant on whitespace and
# bracket spacing (`===TURN 1===`, `=== Turn 2 ===`, `==TURN 1==`, etc).
_TURN_HEADER_RE = re.compile(
    r"^[ \t]*=+[ \t]*TURN[ \t]*(\d+)[ \t]*=+[ \t]*$",
    re.IGNORECASE | re.MULTILINE,
)


def _split_by_turn_headers(text: str) -> list[tuple[int, str]] | None:
    """Split a multi-turn response on ``=== TURN N ===`` headers.

    Returns a list of ``(turn_number, body_text)`` pairs in document order,
    or ``None`` if no headers were found at all. Body strings are stripped.
    Order is preserved as it appears in the response (NOT sorted by N) so
    that a model that swapped the numbering is caught downstream by the
    expected-sequence check.
    """
    matches = list(_TURN_HEADER_RE.finditer(text))
    if not matches:
        return None
    blocks: list[tuple[int, str]] = []
    for i, m in enumerate(matches):
        n = int(m.group(1))
        body_start = m.end()
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[body_start:body_end].strip()
        blocks.append((n, body))
    return blocks


def _parse_and_validate_prose_list(
    raw: str, expected_n: int,
) -> tuple[list[str] | None, str | None]:
    """Parse a reasoning response (1 LLM call → N proses) into a per-turn list.

    Returns (list, None) on success; (None, reason) on failure.

    Format protocol:
      - ``expected_n == 1``: the whole response is the prose. Validate it as a
        single rationale.
      - ``expected_n > 1``: the response is N prose blocks introduced by
        ``=== TURN N ===`` headers (1-based, in order). Split, check count,
        validate each block.

    Tolerances:
      - Strip a wrapping ``<think>...</think>`` block (model meta-think).
      - For multi-turn responses with NO recognisable headers but the right
        number of double-newline-separated paragraphs, fall back to a plain
        ``\\n\\n``-split so a model that ignores the header convention still
        works as long as paragraph count matches.
    """
    if expected_n <= 0:
        return None, "no_assistant_turns"

    stripped = _THINK_RE.sub("", raw or "").strip()
    if not stripped:
        return None, "empty_after_strip"

    if expected_n == 1:
        cleaned = stripped
        reason = _validate_single_prose(cleaned)
        if reason is not None:
            return None, reason
        return [cleaned], None

    # Multi-turn: prefer the explicit-header format we asked for.
    blocks = _split_by_turn_headers(stripped)

    if blocks is None:
        # No headers at all — fall back to blank-line-separated paragraphs.
        # Only accept when the count is exactly right; otherwise we can't be
        # sure which paragraph corresponds to which turn.
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", stripped) if p.strip()]
        if len(paragraphs) != expected_n:
            return None, "no_turn_headers"
        blocks = list(enumerate(paragraphs, start=1))

    if len(blocks) != expected_n:
        return None, f"wrong_length (got {len(blocks)}, expected {expected_n})"

    # Validate the turn numbering — must be 1..N in order. A model that
    # numbered the blocks out of order (or skipped a number) is rejected
    # because we cannot tell which prose belongs to which assistant turn.
    expected_seq = list(range(1, expected_n + 1))
    actual_seq = [n for n, _ in blocks]
    if actual_seq != expected_seq:
        return None, f"turn_numbers_out_of_order (got {actual_seq})"

    cleaned_proses: list[str] = []
    for n, body in blocks:
        # Strip any per-block <think> wrappers the model might add.
        body = _THINK_RE.sub("", body).strip()
        reason = _validate_single_prose(body)
        if reason is not None:
            return None, f"turn_{n}: {reason}"
        cleaned_proses.append(body)

    return cleaned_proses, None


def _build_reasoning_messages(
    content_json: str, fmt: str, n_assistant_turns: int,
) -> list[dict[str, str]]:
    """Compose chat messages asking the model for ``n_assistant_turns`` rationales.

    The reasoning pass simulates the **first-person internal monologue** an
    assistant has *before* writing each response — same convention as
    DeepSeek-R1 / Qwen3-thinking `<think>` blocks in training data. First
    person, present tense; NO meta-narration like "the assistant identifies…"

    Single LLM call per example. To avoid the JSON-array failure modes
    smaller local models hit, we ask for plain prose separated by a clearly
    visible header (``=== TURN N ===``). For single-turn examples we drop
    the header altogether and just ask for one paragraph.
    """
    try:
        parsed: Any = json.loads(content_json)
    except json.JSONDecodeError:
        parsed = content_json
    if isinstance(parsed, dict) and fmt in SUPPORTED_FORMATS:
        parsed, _ = strip_to_schema(parsed, fmt)
    example_text = json.dumps(parsed, ensure_ascii=False)

    # Minimalist prompt: state the task, pin the voice, name the output
    # shape. No good-examples, no starter-phrase list, no anti-examples —
    # those only got the model to copy the demo. Trust the model to write
    # natural first-person prose; the app does all the formatting work.
    closing_rule = (
        "Speak in first person — never describe yourself as if you were "
        "someone else."
    )

    if n_assistant_turns == 1:
        system = (
            "Read the dialog. For each response you gave, write the thought "
            "process that led to it. First-person (\"I\", \"my\"), present "
            "tense, plain prose, 50-200 tokens. No JSON, no markdown, no "
            "headers, no quotes around the prose. Just the thinking.\n\n"
            f"{closing_rule}"
        )
        user = (
            f"Dialog (format={fmt}):\n"
            f"{example_text}\n\n"
            "Write your thought process before writing your one response."
        )
    else:
        # Header template — explicit, hard-to-confuse-with-prose marker so
        # the parser can split reliably even when the model adds blank lines
        # or extra commentary inside a rationale.
        header_demo = "\n\n".join(
            f"=== TURN {i + 1} ===\n<your thinking before response {i + 1}>"
            for i in range(min(n_assistant_turns, 2))
        )
        if n_assistant_turns > 2:
            header_demo += f"\n\n…through === TURN {n_assistant_turns} ==="

        system = (
            "Read the dialog. For each response you gave, write the thought "
            "process that led to it. First-person (\"I\", \"my\"), present "
            "tense, plain prose, 50-200 tokens per block. No JSON, no "
            "markdown, no other text — just the thinking, separated by the "
            "exact headers shown by the user.\n\n"
            f"{closing_rule}"
        )
        user = (
            f"Dialog (format={fmt}):\n"
            f"{example_text}\n\n"
            f"This dialog has {n_assistant_turns} responses from you. Write "
            f"{n_assistant_turns} thought-process blocks, one per response "
            "in order, using this format:\n\n"
            f"{header_demo}"
        )

    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


# ---------------------------------------------------------------------------
# LLM call helpers
# ---------------------------------------------------------------------------


def _extract_content(response: dict) -> str:
    try:
        return response["choices"][0]["message"].get("content") or ""
    except (KeyError, IndexError, TypeError):
        return ""


async def _call_provider(
    provider: LLMProvider,
    model: str,
    messages: list[dict[str, str]],
    *,
    temperature: float,
    max_tokens: int,
    provider_route: str | None = None,
) -> dict | None:
    """Single chat call. For non-parallel providers (Ollama/LM Studio) calls go
    through the per-provider lock so the GPU only sees one chat at a time.

    ``provider_route`` pins an OpenRouter upstream (e.g. "Anthropic") so a
    reasoning pass on `anthropic/claude-3-haiku` goes through Anthropic
    native instead of a third-party rehost. Honored only by providers whose
    `capabilities.supports_provider_routing` is True; OpenAI-compatible local
    backends ignore it transparently in `provider.chat`.
    """
    async def _do_call() -> dict | None:
        try:
            async with _REASONING_GEN_SEMAPHORE:
                return await provider.chat(
                    model=model,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    max_retries=1,
                    retry_cooldown=15,
                    provider_route=provider_route,
                )
        except LLMError as exc:
            logger.warning("[reasoning] provider error: %s", exc)
            return None

    if not provider.capabilities.supports_parallel and provider.provider_id:
        lock = _local_provider_locks.setdefault(provider.provider_id, asyncio.Lock())
        async with lock:
            return await _do_call()
    return await _do_call()


async def _generate_reasoning_for_example(
    *,
    content_json: str,
    fmt: str,
    provider: LLMProvider,
    model: str,
    temperature: float,
    max_tokens: int,
    job_id: str,
    category: str,
    provider_route: str | None = None,
    max_attempts: int = 3,
) -> list[str] | None:
    """Generate reasoning prose per assistant turn. Returns the list of
    rationales (same length as the example's assistant turn count) on success,
    or None on persistent failure — caller leaves ``reasoning`` NULL and the
    example exports without `<think>` prefixes (skip path).
    """
    try:
        parsed: Any = json.loads(content_json)
    except json.JSONDecodeError:
        log_event(
            job_id, "reasoning_invalid_prose",
            category=category, attempt=1, model=model, reason="malformed_source_content",
        )
        return None

    expected_n = count_assistant_turns(parsed, fmt) if isinstance(parsed, dict) else 0
    if expected_n <= 0:
        log_event(
            job_id, "reasoning_invalid_prose",
            category=category, attempt=1, model=model, reason="no_assistant_turns_in_source",
        )
        return None

    messages = _build_reasoning_messages(content_json, fmt, expected_n)

    # Reasoning model needs more budget when it has to produce multiple
    # rationales — scale max_tokens with turn count so 4-turn datasets don't
    # silently truncate the JSON array.
    effective_max = max(max_tokens, max_tokens * expected_n // 2 + 256)

    for attempt in range(max_attempts):
        if is_cancelled(job_id):
            raise _CancelledError()
        response = await _call_provider(
            provider, model, messages,
            temperature=temperature, max_tokens=effective_max,
            provider_route=provider_route,
        )
        if response is None:
            log_event(
                job_id, "reasoning_api_error",
                category=category, attempt=attempt + 1, model=model,
            )
            continue

        raw = _extract_content(response)
        proses, reason = _parse_and_validate_prose_list(raw, expected_n)
        if proses is not None:
            return proses
        log_event(
            job_id, "reasoning_invalid_prose",
            category=category, attempt=attempt + 1, model=model, reason=reason,
        )
    return None


# ---------------------------------------------------------------------------
# Spawn — synchronous validation
# ---------------------------------------------------------------------------


async def spawn_reasoning_job(
    source_job_id: str,
    request: ReasoningRequest,
    db: aiosqlite.Connection,
) -> ReasoningResponse:
    """Validate inputs synchronously, create the reasoning job row, spawn the
    background task. All HTTP errors come from here so bad requests never
    create a zombie reasoning job.
    """
    # 1. Source job must exist, be completed, and not itself be a reasoning job.
    async with await db.execute(
        "SELECT id, status, config_json, parent_job_id, reasoning_format "
        "FROM jobs WHERE id = ?",
        (source_job_id,),
    ) as cursor:
        source_row = await cursor.fetchone()
    if not source_row:
        raise HTTPException(status_code=404, detail="Source job not found")
    if source_row["status"] != "completed":
        raise HTTPException(
            status_code=409,
            detail=f"Source job is {source_row['status']}, must be completed",
        )
    if source_row["parent_job_id"] is not None or source_row["reasoning_format"] is not None:
        raise HTTPException(
            status_code=409,
            detail="Source is already a reasoning job — chaining is not supported",
        )

    try:
        source_config = json.loads(source_row["config_json"])
    except (json.JSONDecodeError, TypeError) as exc:
        raise HTTPException(status_code=500, detail="Source job config is malformed") from exc

    source_format = source_config.get("format")
    if source_format not in SUPPORTED_FORMATS:
        raise HTTPException(
            status_code=422,
            detail=f"Source job has unsupported format: {source_format!r}",
        )

    source_cat_names = {c.get("name") for c in source_config.get("categories", []) if c.get("name")}
    if not source_cat_names:
        raise HTTPException(status_code=422, detail="Source job has no categories")

    # 2. Every category in the request must match a source category, and every
    # source category must be covered. Partial scope is P3.
    request_names = {c.name for c in request.categories}
    missing = source_cat_names - request_names
    extra = request_names - source_cat_names
    if missing or extra:
        details = []
        if missing:
            details.append(f"missing: {sorted(missing)}")
        if extra:
            details.append(f"unknown: {sorted(extra)}")
        raise HTTPException(
            status_code=422,
            detail=f"Category mismatch with source job — {'; '.join(details)}",
        )

    # 3. Every provider must resolve and be enabled.
    for cat in request.categories:
        try:
            await get_provider(db, cat.provider_id)
        except (ProviderNotFoundError, ProviderDisabledError) as exc:
            raise HTTPException(
                status_code=422,
                detail=f"Provider for category {cat.name!r}: {exc}",
            ) from exc

    # 4. Count examples in the source — used for progress targets.
    async with await db.execute(
        "SELECT COUNT(*) AS n FROM examples WHERE job_id = ?", (source_job_id,)
    ) as cursor:
        count_row = await cursor.fetchone()
    total_count = int(count_row["n"]) if count_row else 0
    if total_count == 0:
        raise HTTPException(status_code=404, detail="Source job has no examples")

    # 5. Per-category targets from the source DB (not source config — config
    # holds the *requested* split, the DB the *actual* count after skips).
    async with await db.execute(
        "SELECT category, COUNT(*) AS n FROM examples "
        "WHERE job_id = ? GROUP BY category",
        (source_job_id,),
    ) as cursor:
        cat_rows = await cursor.fetchall()
    cat_targets: dict[str, int] = {
        (r["category"] or ""): int(r["n"]) for r in cat_rows
    }

    # 6. Build the reasoning job config — copy of source config so list/view
    # endpoints render category names, plus reasoning-specific metadata.
    reasoning_config = dict(source_config)
    reasoning_config["total_examples"] = max(total_count, 10)
    # Strip merge marker so the reasoning job isn't mistaken for a merge.
    reasoning_config.pop("merged_from", None)

    reasoning_category_models = {
        cat.name: {
            "model": cat.model,
            "provider_id": cat.provider_id,
            "provider_route": cat.provider_route,
        }
        for cat in request.categories
    }

    reasoning_job_id = str(uuid.uuid4())
    now = _now_iso()
    initial_progress = ProgressJson(
        total_examples=total_count,
        completed=0,
        skipped=0,
        current_stage="pending",
        categories={
            name: CategoryProgress(target=n, completed=0, skipped=0)
            for name, n in cat_targets.items()
        },
    )

    await db.execute(
        "INSERT INTO jobs "
        "(id, status, config_json, progress_json, "
        " reasoning_format, reasoning_category_models, parent_job_id, "
        " created_at, updated_at) "
        "VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?)",
        (
            reasoning_job_id,
            json.dumps(reasoning_config),
            initial_progress.model_dump_json(),
            request.format,
            json.dumps(reasoning_category_models),
            source_job_id,
            now,
            now,
        ),
    )
    await db.commit()

    _running_jobs.add(reasoning_job_id)
    asyncio.create_task(
        _reasoning_job_task(
            reasoning_job_id=reasoning_job_id,
            source_job_id=source_job_id,
            request=request,
        )
    )

    return ReasoningResponse(
        job_id=reasoning_job_id,
        parent_job_id=source_job_id,
        total_examples=total_count,
    )


# ---------------------------------------------------------------------------
# Background task — copy + generate + export
# ---------------------------------------------------------------------------


async def _reasoning_job_task(
    reasoning_job_id: str,
    source_job_id: str,
    request: ReasoningRequest,
) -> None:
    """Background task: copy source examples → generate reasoning per row →
    export JSONL → compute stats → completed.

    State transitions:
        pending → running(reasoning_copying)
                → running(reasoning_generating)
                → running(reasoning_exporting)
                → running(reasoning_computing_stats)
                → completed

    Cancellation is checked between examples (cooperative) and via
    ``task.cancel()`` on the in-flight provider call (instant).
    """
    from app.database import get_db
    db = await get_db()

    # Register the running task so cancel_job() can interrupt mid-LLM-call.
    current_task = asyncio.current_task()
    if current_task is not None:
        _job_tasks[reasoning_job_id] = current_task

    # Reload the actual category targets from the DB — they match what
    # spawn_reasoning_job seeded into progress_json.
    async with await db.execute(
        "SELECT progress_json FROM jobs WHERE id = ?", (reasoning_job_id,)
    ) as cur:
        prog_row = await cur.fetchone()
    progress = ProgressJson.model_validate_json(prog_row["progress_json"])
    progress.completed = 0
    progress.skipped = 0
    total_count = progress.total_examples

    try:
        log_event(
            reasoning_job_id, "reasoning_started",
            source_job_id=source_job_id, total=total_count, format=request.format,
        )

        # --- Stage 1: copy examples from source ---
        progress.current_stage = "reasoning_copying"
        await _update_progress(db, reasoning_job_id, "running", progress)

        copied = await _copy_examples_from_source(
            db, source_job_id, reasoning_job_id, progress,
            reasoning_job_id_for_cancel=reasoning_job_id,
        )
        if copied != total_count:
            logger.warning(
                "Reasoning job %s: copied %d/%d examples (source mutated mid-copy?)",
                reasoning_job_id, copied, total_count,
            )

        # --- Stage 2: generate reasoning per category ---
        progress.current_stage = "reasoning_generating"
        progress.completed = 0
        for cp in progress.categories.values():
            cp.completed = 0
            cp.skipped = 0
        await _update_progress(db, reasoning_job_id, "running", progress)

        # Resolve providers up front — one lookup per category.
        cat_providers: dict[str, LLMProvider] = {}
        cat_models: dict[str, str] = {}
        cat_routes: dict[str, str | None] = {}
        for cat in request.categories:
            cat_providers[cat.name] = await get_provider(db, cat.provider_id)
            cat_models[cat.name] = cat.model
            cat_routes[cat.name] = cat.provider_route

        # Fan out across categories. Cloud-capable providers run via
        # asyncio.gather; local providers serialize behind their lock.
        await _run_reasoning_categories(
            db=db,
            reasoning_job_id=reasoning_job_id,
            request=request,
            cat_providers=cat_providers,
            cat_models=cat_models,
            cat_routes=cat_routes,
            progress=progress,
        )

        # --- Stage 3: export JSONL ---
        if is_cancelled(reasoning_job_id):
            raise _CancelledError()
        progress.current_stage = "reasoning_exporting"
        await _update_progress(db, reasoning_job_id, "running", progress)
        log_event(reasoning_job_id, "reasoning_export_start")

        from app.services.export_service import export_job
        try:
            await export_job(reasoning_job_id, db)
        except Exception:
            logger.exception("Reasoning export failed for job %s (non-fatal)", reasoning_job_id)

        # --- Stage 4: stats snapshot ---
        if is_cancelled(reasoning_job_id):
            raise _CancelledError()
        progress.current_stage = "reasoning_computing_stats"
        await _update_progress(db, reasoning_job_id, "running", progress)
        log_event(reasoning_job_id, "reasoning_stats_start")

        try:
            await compute_and_store(
                db, reasoning_job_id,
                judge_enabled=False,  # reasoning pass doesn't run a judge
                progress=progress,
            )
        except Exception:
            logger.exception("Reasoning stats failed for job %s (non-fatal)", reasoning_job_id)

        progress.current_stage = "completed"
        await _update_progress(db, reasoning_job_id, "completed", progress)
        log_event(
            reasoning_job_id, "reasoning_completed",
            total=total_count, skipped=progress.skipped,
        )

    except (_CancelledError, asyncio.CancelledError):
        progress.current_stage = "cancelled"
        try:
            await asyncio.shield(_update_progress(db, reasoning_job_id, "cancelled", progress))
        except Exception:
            logger.exception("Failed to persist cancelled status for reasoning job %s", reasoning_job_id)

    except Exception as exc:
        logger.exception("Reasoning task %s failed", reasoning_job_id)
        progress.current_stage = "failed"
        try:
            await asyncio.shield(_update_progress(db, reasoning_job_id, "failed", progress))
        except Exception:
            logger.exception("Failed to persist failed status for reasoning job %s", reasoning_job_id)
        log_event(reasoning_job_id, "reasoning_failed", error=str(exc))

    finally:
        clear_cancellation(reasoning_job_id)
        _running_jobs.discard(reasoning_job_id)
        _job_tasks.pop(reasoning_job_id, None)


async def _copy_examples_from_source(
    db: aiosqlite.Connection,
    source_job_id: str,
    reasoning_job_id: str,
    progress: ProgressJson,
    *,
    reasoning_job_id_for_cancel: str,
) -> int:
    """Stream-copy examples from source → reasoning job. Returns number copied.

    Uses the same insert column set as merge so legacy fields (judge_score,
    token columns, model) carry over — useful for stats and traceability.
    ``reasoning`` and ``reasoning_model_used`` start NULL; the generation
    stage fills them in.
    """
    select_sql = (
        "SELECT content_json, format, tokens, judge_score, category, model, "
        "       prompt_tokens, completion_tokens, "
        "       judge_prompt_tokens, judge_completion_tokens "
        "FROM examples WHERE job_id = ? ORDER BY created_at ASC"
    )
    buffer: list[tuple] = []
    copied = 0

    async def _flush() -> None:
        nonlocal copied
        if not buffer:
            return
        await db.executemany(_REASONING_INSERT_SQL, buffer)
        await db.commit()
        copied += len(buffer)
        buffer.clear()
        progress.completed = copied
        await _update_progress(db, reasoning_job_id, "running", progress)
        log_event(
            reasoning_job_id, "reasoning_copy_batch",
            done=copied, total=progress.total_examples,
        )

    async with await db.execute(select_sql, (source_job_id,)) as cursor:
        async for row in cursor:
            if is_cancelled(reasoning_job_id_for_cancel):
                raise _CancelledError()
            buffer.append((
                str(uuid.uuid4()),
                reasoning_job_id,
                row["content_json"],
                row["format"],
                row["tokens"] or 0,
                row["judge_score"],
                row["category"] or "",
                row["model"] or "",
                row["prompt_tokens"] or 0,
                row["completion_tokens"] or 0,
                row["judge_prompt_tokens"] or 0,
                row["judge_completion_tokens"] or 0,
            ))
            if len(buffer) >= _REASONING_COPY_BATCH:
                await _flush()
    await _flush()
    return copied


async def _run_reasoning_categories(
    *,
    db: aiosqlite.Connection,
    reasoning_job_id: str,
    request: ReasoningRequest,
    cat_providers: dict[str, LLMProvider],
    cat_models: dict[str, str],
    cat_routes: dict[str, str | None],
    progress: ProgressJson,
) -> None:
    """Drive reasoning generation for every category in parallel.

    Cloud-capable providers (supports_parallel=True) fan out via asyncio.gather;
    local providers serialize behind their per-provider lock (see _call_provider).
    """
    async def _run_one_category(cat_name: str) -> None:
        provider = cat_providers[cat_name]
        model = cat_models[cat_name]
        provider_route = cat_routes.get(cat_name)
        async with await db.execute(
            "SELECT id, content_json, format FROM examples "
            "WHERE job_id = ? AND category = ? AND reasoning IS NULL "
            "ORDER BY created_at ASC",
            (reasoning_job_id, cat_name),
        ) as cursor:
            pending_examples = await cursor.fetchall()

        log_event(
            reasoning_job_id, "reasoning_category_start",
            category=cat_name, count=len(pending_examples), model=model,
        )

        for ex_row in pending_examples:
            if is_cancelled(reasoning_job_id):
                raise _CancelledError()
            proses = await _generate_reasoning_for_example(
                content_json=ex_row["content_json"],
                fmt=ex_row["format"],
                provider=provider,
                model=model,
                temperature=request.temperature,
                max_tokens=request.max_tokens,
                job_id=reasoning_job_id,
                category=cat_name,
                provider_route=provider_route,
            )
            cp = progress.categories.get(cat_name)
            if proses is None:
                progress.skipped += 1
                if cp is not None:
                    cp.skipped += 1
                log_event(
                    reasoning_job_id, "reasoning_skipped",
                    category=cat_name, example_id=ex_row["id"],
                )
            else:
                # Persist the per-turn rationales as a JSON array string. The
                # serializer / view layer parse this back through
                # example_schema._parse_reasoning.
                await db.execute(
                    _UPDATE_REASONING_SQL,
                    (json.dumps(proses, ensure_ascii=False), model, ex_row["id"]),
                )
                await db.commit()
                progress.completed += 1
                if cp is not None:
                    cp.completed += 1
            await _update_progress(db, reasoning_job_id, "running", progress)

    tasks = [
        asyncio.create_task(_run_one_category(cat.name), name=f"reasoning-{cat.name}")
        for cat in request.categories
    ]
    try:
        await asyncio.gather(*tasks)
    except (Exception, asyncio.CancelledError):
        for t in tasks:
            if not t.done():
                t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise


# ---------------------------------------------------------------------------
# Resume
# ---------------------------------------------------------------------------


async def resume_reasoning_job(reasoning_job_id: str) -> None:
    """Resume a previously interrupted/cancelled/failed reasoning job.

    Inspects how far the copy + generate phases got and continues from there:

    - 0 examples copied → restart from scratch (rare; copy is the first thing
      the task does).
    - Partial copy (0 < copied < source_count) → drop the partial copy and
      restart from scratch. Streaming inserts mean we can't easily resume
      mid-copy without complex de-duplication against the source.
    - Full copy (copied == source_count) → skip copy, resume generation by
      picking up rows where ``reasoning IS NULL``.
    """
    from app.database import get_db
    db = await get_db()

    async with await db.execute(
        "SELECT status, config_json, parent_job_id, reasoning_format, "
        "       reasoning_category_models, progress_json "
        "FROM jobs WHERE id = ?",
        (reasoning_job_id,),
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise LookupError(f"Reasoning job {reasoning_job_id} not found")
    if row["status"] not in ("interrupted", "cancelled", "pending", "failed"):
        raise ValueError(
            f"Reasoning job {reasoning_job_id} has status {row['status']}, not resumable"
        )
    if not row["reasoning_format"] or not row["parent_job_id"]:
        raise ValueError(
            f"Job {reasoning_job_id} is not a reasoning job (missing reasoning_format/parent_job_id)"
        )

    source_job_id = row["parent_job_id"]
    reasoning_format = row["reasoning_format"]
    try:
        cat_map = json.loads(row["reasoning_category_models"] or "{}")
    except json.JSONDecodeError:
        cat_map = {}

    # Reconstruct ReasoningRequest from stored metadata. Temperature/max_tokens
    # weren't persisted, so fall back to the model defaults — good enough for
    # the resume path (these affect prose style, not correctness).
    from app.models.jobs import ReasoningCategoryConfig
    categories = [
        ReasoningCategoryConfig(
            name=name,
            model=cfg.get("model", ""),
            provider_id=cfg.get("provider_id", ""),
            provider_route=cfg.get("provider_route"),
        )
        for name, cfg in cat_map.items()
        if isinstance(cfg, dict) and cfg.get("model") and cfg.get("provider_id")
    ]
    if not categories:
        raise ValueError(f"Reasoning job {reasoning_job_id}: no usable category config to resume")

    request = ReasoningRequest(format=reasoning_format, categories=categories)

    # Determine resume strategy based on copy state.
    async with await db.execute(
        "SELECT COUNT(*) AS n FROM examples WHERE job_id = ?", (source_job_id,)
    ) as cur:
        source_count = int((await cur.fetchone())["n"])
    async with await db.execute(
        "SELECT COUNT(*) AS n FROM examples WHERE job_id = ?", (reasoning_job_id,)
    ) as cur:
        copied_count = int((await cur.fetchone())["n"])

    if 0 < copied_count < source_count:
        logger.info(
            "Reasoning resume %s: partial copy %d/%d — clearing and starting over",
            reasoning_job_id, copied_count, source_count,
        )
        # Wipe partial copy so _reasoning_job_task starts clean.
        await db.execute("DELETE FROM examples WHERE job_id = ?", (reasoning_job_id,))
        await db.commit()

    # Mark pending so the task can transition into running cleanly.
    await db.execute(
        "UPDATE jobs SET status = 'pending', updated_at = ? WHERE id = ?",
        (_now_iso(), reasoning_job_id),
    )
    await db.commit()

    log_event(reasoning_job_id, "reasoning_resumed", copied=copied_count, target=source_count)

    _running_jobs.add(reasoning_job_id)
    await _reasoning_job_task(
        reasoning_job_id=reasoning_job_id,
        source_job_id=source_job_id,
        request=request,
    )
