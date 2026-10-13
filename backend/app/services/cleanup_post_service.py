"""Async cleanup post-process — background execution of POST /api/jobs/{id}/add-cleanup.

Second, independent way into the cleanup stage. The inline stage (job_runner,
generation → cleanup → judge) normalizes an example while the dataset is being
produced; this module applies the *same* per-example logic to a dataset that
already exists. That buys three things the inline stage cannot: datasets
generated before the stage existed can still be cleaned, rules can be iterated
without paying for regeneration, and a local backend loads the cleanup model
once for the whole batch instead of interleaving it with generation.

Architecture is a mirror of ``reasoning_service``: validation is synchronous
(so a bad request never leaves a zombie job), the work runs in
``asyncio.create_task`` and progress is surfaced through the existing
``GET /jobs/{id}/stream`` SSE. The pass is a new row in ``jobs`` with
``parent_job_id`` pointing at the source dataset and examples copied
physically.

One deliberate difference from reasoning: reasoning writes into a column of
its own (``examples.reasoning``) and never touches ``content_json``, while
cleanup *replaces* ``content_json``. That is exactly why the pass runs on a
copy — the source dataset stays byte-identical, so a cleanup model that turns
out to rewrite instead of normalize costs one deleted job, not the dataset.

The per-example work itself is not reimplemented here: ``_cleanup_example``
from ``job_runner`` is the single implementation of collect → prompt → chat →
parse → per-slot gates → splice → schema re-validation, and both entry points
call it. See the note above ``_call_cleanup`` for why it lives there.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid

import aiosqlite
from fastapi import HTTPException

from app.models.jobs import (
    CategoryProgress,
    CleanupJobRequest,
    CleanupJobResponse,
    CleanupStats,
    ProgressJson,
)
from app.services.event_log import log_event
from app.services.example_schema import SUPPORTED_FORMATS
from app.services.job_runner import (
    _CancelledError,
    _cleanup_example,
    _cleanup_semaphore,
    _job_tasks,
    _running_jobs,
    _update_progress,
    clear_cancellation,
    is_cancelled,
)
from app.services.llm.base import LLMProvider
from app.services.llm.registry import (
    ProviderDisabledError,
    ProviderNotFoundError,
    get_provider,
)
from app.services.stats_service import compute_and_store
from app.utils import now_iso as _now_iso

logger = logging.getLogger(__name__)

# Same batch size as the merge / reasoning copy phases.
_CLEANUP_COPY_BATCH = 1000

# Every column that carries dataset value. `created_at` is copied verbatim
# (unlike the reasoning copy, which lets SQLite default it) so the cleaned
# dataset exports in exactly the source order — export sorts by created_at and
# the default has one-second resolution, which would shuffle same-second rows.
_CLEANUP_INSERT_SQL = (
    "INSERT INTO examples "
    "(id, job_id, content_json, format, tokens, created_at, judge_score, category, model, "
    "prompt_tokens, completion_tokens, judge_prompt_tokens, judge_completion_tokens, "
    "cleanup_prompt_tokens, cleanup_completion_tokens, reasoning, reasoning_model_used) "
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)

_UPDATE_CONTENT_SQL = (
    "UPDATE examples SET content_json = ?, "
    "cleanup_prompt_tokens = cleanup_prompt_tokens + ?, "
    "cleanup_completion_tokens = cleanup_completion_tokens + ? "
    "WHERE id = ?"
)

_UPDATE_TOKENS_SQL = (
    "UPDATE examples SET "
    "cleanup_prompt_tokens = cleanup_prompt_tokens + ?, "
    "cleanup_completion_tokens = cleanup_completion_tokens + ? "
    "WHERE id = ?"
)

# Marker written into the job's config_json. Mirrors how merge marks itself
# with `merged_from` — no schema migration needed, and the read path (list,
# resume, stats) can tell a cleanup pass from a plain generation job.
CLEANUP_POST_CONFIG_KEY = "cleanup_post_from"


def is_cleanup_post_config(raw_cfg: dict | None) -> bool:
    """True when ``raw_cfg`` belongs to a cleanup post-process job."""
    return bool(raw_cfg and CLEANUP_POST_CONFIG_KEY in raw_cfg)


# ---------------------------------------------------------------------------
# Spawn — synchronous validation
# ---------------------------------------------------------------------------


async def spawn_cleanup_job(
    source_job_id: str,
    request: CleanupJobRequest,
    db: aiosqlite.Connection,
) -> CleanupJobResponse:
    """Validate inputs synchronously, create the cleanup job row, spawn the task.

    Every HTTP error is raised from here, so a rejected request never leaves a
    half-created job behind.
    """
    # 1. Source job must exist and be completed.
    async with await db.execute(
        "SELECT id, status, config_json, reasoning_format, reasoning_category_models "
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

    source_cat_names = {
        c.get("name") for c in source_config.get("categories", []) if c.get("name")
    }
    if not source_cat_names:
        raise HTTPException(status_code=422, detail="Source job has no categories")

    # 2. Default provider must resolve and be enabled. Per-category overrides
    # are optional; whatever they leave unset falls back to the defaults.
    try:
        await get_provider(db, request.provider_id)
    except (ProviderNotFoundError, ProviderDisabledError) as exc:
        raise HTTPException(status_code=422, detail=f"Cleanup provider: {exc}") from exc

    for override in request.categories:
        if override.name not in source_cat_names:
            raise HTTPException(
                status_code=422,
                detail=f"Unknown category in override: {override.name!r}",
            )
        if override.provider_id:
            try:
                await get_provider(db, override.provider_id)
            except (ProviderNotFoundError, ProviderDisabledError) as exc:
                raise HTTPException(
                    status_code=422,
                    detail=f"Provider for category {override.name!r}: {exc}",
                ) from exc

    # 3. Count examples — the progress target and the reason to run at all.
    async with await db.execute(
        "SELECT COUNT(*) AS n FROM examples WHERE job_id = ?", (source_job_id,)
    ) as cursor:
        count_row = await cursor.fetchone()
    total_count = int(count_row["n"]) if count_row else 0
    if total_count == 0:
        raise HTTPException(status_code=404, detail="Source job has no examples")

    # 4. Per-category targets from the DB (actual counts, not the requested
    # split — the source may have skipped examples or been deduplicated).
    async with await db.execute(
        "SELECT category, COUNT(*) AS n FROM examples WHERE job_id = ? GROUP BY category",
        (source_job_id,),
    ) as cursor:
        cat_rows = await cursor.fetchall()
    cat_targets: dict[str, int] = {(r["category"] or ""): int(r["n"]) for r in cat_rows}

    # 5. Build the cleanup job config (see _build_cleanup_config).
    cleanup_config = _build_cleanup_config(
        source_config, request, total_count=total_count, source_job_id=source_job_id
    )

    cleanup_job_id = str(uuid.uuid4())
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
        cleanup_stats=CleanupStats(),
    )

    # `reasoning_format` / `reasoning_category_models` ride along from the
    # source: the copied rows keep their `reasoning` column, so the cleaned
    # dataset must export the same `<think>` blocks the source exported.
    await db.execute(
        "INSERT INTO jobs "
        "(id, status, config_json, progress_json, "
        " reasoning_format, reasoning_category_models, parent_job_id, "
        " created_at, updated_at) "
        "VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?)",
        (
            cleanup_job_id,
            json.dumps(cleanup_config),
            initial_progress.model_dump_json(),
            source_row["reasoning_format"],
            source_row["reasoning_category_models"],
            source_job_id,
            now,
            now,
        ),
    )
    await db.commit()

    _running_jobs.add(cleanup_job_id)
    asyncio.create_task(
        _cleanup_job_task(
            cleanup_job_id=cleanup_job_id,
            source_job_id=source_job_id,
            request=request,
        )
    )

    return CleanupJobResponse(
        job_id=cleanup_job_id,
        parent_job_id=source_job_id,
        total_examples=total_count,
    )


# ---------------------------------------------------------------------------
# Background task — copy + clean + export
# ---------------------------------------------------------------------------



def _build_cleanup_config(
    source_config: dict[str, Any],
    request: "CleanupJobRequest",
    *,
    total_count: int,
    source_job_id: str,
) -> dict[str, Any]:
    """Config for the cleanup job: source config + the cleanup block.

    Keeps the source categories so list and stats views still render their
    names, but the model chosen in the dialog is authoritative — see the reset
    below.
    """
    cleanup_config = dict(source_config)
    cleanup_config["total_examples"] = max(total_count, 10)
    # Strip the merge marker so a cleaned merge isn't re-read as a merge (its
    # source configs would be resolved for display and hide the real models).
    cleanup_config.pop("merged_from", None)
    cleanup_config["cleanup_enabled"] = True
    cleanup_config["cleanup_model"] = request.model
    cleanup_config["cleanup_provider_id"] = request.provider_id
    cleanup_config["cleanup_provider"] = request.provider_route
    cleanup_config["cleanup_rules"] = request.cleanup_rules
    cleanup_config["cleanup_prompt_price"] = request.prompt_price
    cleanup_config["cleanup_completion_price"] = request.completion_price
    cleanup_config[CLEANUP_POST_CONFIG_KEY] = source_job_id

    # The dialog's choice is authoritative. Categories copied from the source
    # job carry that job's per-category cleanup overrides, and without this
    # reset they would outrank the model the user just picked (resolution is
    # `cat_cfg.get("cleanup_model") or request.model`). Wipe them first, then
    # re-apply only what this request explicitly asked for.
    cats = [dict(c) for c in cleanup_config.get("categories", [])]
    for cat in cats:
        cat["cleanup_model"] = request.model
        cat["cleanup_provider_id"] = request.provider_id
        cat["cleanup_provider"] = request.provider_route
    cleanup_config["categories"] = cats

    overrides = {o.name: o for o in request.categories}
    if overrides:
        for cat in cats:
            override = overrides.get(cat.get("name"))
            if override is None:
                continue
            cat["cleanup_model"] = override.model or request.model
            cat["cleanup_provider_id"] = override.provider_id or request.provider_id
            cat["cleanup_provider"] = (
                override.provider_route
                if override.provider_route is not None
                else request.provider_route
            )
        cleanup_config["categories"] = cats

    return cleanup_config


async def _cleanup_job_task(
    cleanup_job_id: str,
    source_job_id: str,
    request: CleanupJobRequest,
) -> None:
    """Background task: copy source examples → clean each row → export → stats.

    State transitions:
        pending → running(cleanup_copying)
                → running(cleanup_processing)
                → running(cleanup_exporting)
                → running(cleanup_computing_stats)
                → completed

    Cancellation is checked between examples (cooperative) and via
    ``task.cancel()`` on the in-flight provider call (instant).
    """
    from app.database import get_db
    db = await get_db()

    current_task = asyncio.current_task()
    if current_task is not None:
        _job_tasks[cleanup_job_id] = current_task

    async with await db.execute(
        "SELECT config_json, progress_json FROM jobs WHERE id = ?", (cleanup_job_id,)
    ) as cur:
        job_row = await cur.fetchone()
    if job_row is None:
        # Deleted between spawn and the first tick of the task. Nothing to do,
        # but the registries still have to be released by hand — the finally
        # block below is not reached from here.
        logger.error("Cleanup job %s vanished before its task started", cleanup_job_id)
        clear_cancellation(cleanup_job_id)
        _running_jobs.discard(cleanup_job_id)
        _job_tasks.pop(cleanup_job_id, None)
        return
    progress = ProgressJson.model_validate_json(job_row["progress_json"])
    progress.completed = 0
    progress.skipped = 0
    if progress.cleanup_stats is None:
        progress.cleanup_stats = CleanupStats()
    total_count = progress.total_examples

    try:
        config = json.loads(job_row["config_json"])
    except (json.JSONDecodeError, TypeError):
        config = {}
    fmt = config.get("format", "sharegpt")
    config_max_tokens = int(config.get("max_tokens", 2048) or 2048)

    try:
        log_event(
            cleanup_job_id, "cleanup_job_started",
            source_job_id=source_job_id, total=total_count, model=request.model,
        )

        # --- Stage 1: copy examples from source ---
        progress.current_stage = "cleanup_copying"
        await _update_progress(db, cleanup_job_id, "running", progress)

        copied = await _copy_examples_from_source(
            db, source_job_id, cleanup_job_id, progress,
        )
        if copied != total_count:
            logger.warning(
                "Cleanup job %s: copied %d/%d examples (source mutated mid-copy?)",
                cleanup_job_id, copied, total_count,
            )

        # --- Stage 2: clean every copied example ---
        progress.current_stage = "cleanup_processing"
        progress.completed = 0
        for cp in progress.categories.values():
            cp.completed = 0
            cp.skipped = 0
        await _update_progress(db, cleanup_job_id, "running", progress)

        targets = await _resolve_category_targets(db, config, request, progress)

        prompt_tokens, completion_tokens = await _run_cleanup_categories(
            db=db,
            cleanup_job_id=cleanup_job_id,
            fmt=fmt,
            config_max_tokens=config_max_tokens,
            cleanup_rules=request.cleanup_rules,
            targets=targets,
            progress=progress,
        )

        if request.prompt_price or request.completion_price:
            progress.cleanup_cost = (
                prompt_tokens * request.prompt_price
                + completion_tokens * request.completion_price
            )

        # --- Stage 3: export JSONL ---
        if is_cancelled(cleanup_job_id):
            raise _CancelledError()
        progress.current_stage = "cleanup_exporting"
        await _update_progress(db, cleanup_job_id, "running", progress)

        from app.services.export_service import export_job
        try:
            await export_job(cleanup_job_id, db)
        except Exception:
            logger.exception("Cleanup export failed for job %s (non-fatal)", cleanup_job_id)

        # --- Stage 4: stats snapshot ---
        if is_cancelled(cleanup_job_id):
            raise _CancelledError()
        progress.current_stage = "cleanup_computing_stats"
        await _update_progress(db, cleanup_job_id, "running", progress)

        try:
            await compute_and_store(
                db, cleanup_job_id,
                # Judge scores are copied verbatim from the source, so the
                # score distribution stays meaningful for a judged source.
                judge_enabled=bool(config.get("judge_enabled")),
                progress=progress,
            )
        except Exception:
            logger.exception("Cleanup stats failed for job %s (non-fatal)", cleanup_job_id)

        progress.current_stage = "completed"
        await _update_progress(db, cleanup_job_id, "completed", progress)
        stats = progress.cleanup_stats or CleanupStats()
        log_event(
            cleanup_job_id, "cleanup_job_completed",
            total=total_count, modified=stats.modified,
            reverted=stats.reverted, failed=stats.failed,
        )

    except (_CancelledError, asyncio.CancelledError):
        progress.current_stage = "cancelled"
        try:
            await asyncio.shield(_update_progress(db, cleanup_job_id, "cancelled", progress))
        except Exception:
            logger.exception(
                "Failed to persist cancelled status for cleanup job %s", cleanup_job_id
            )

    except Exception as exc:
        logger.exception("Cleanup task %s failed", cleanup_job_id)
        progress.current_stage = "failed"
        try:
            await asyncio.shield(_update_progress(db, cleanup_job_id, "failed", progress))
        except Exception:
            logger.exception(
                "Failed to persist failed status for cleanup job %s", cleanup_job_id
            )
        log_event(cleanup_job_id, "cleanup_job_failed", error=str(exc))

    finally:
        clear_cancellation(cleanup_job_id)
        _running_jobs.discard(cleanup_job_id)
        _job_tasks.pop(cleanup_job_id, None)


async def _copy_examples_from_source(
    db: aiosqlite.Connection,
    source_job_id: str,
    cleanup_job_id: str,
    progress: ProgressJson,
) -> int:
    """Stream-copy examples from source → cleanup job. Returns number copied.

    Everything that carries dataset or accounting value comes along: content,
    judge score, per-stage token counters and the reasoning prose. New row ids
    (the copies are independent rows) and the original ``created_at`` (so the
    export keeps source ordering).
    """
    select_sql = (
        "SELECT content_json, format, tokens, created_at, judge_score, category, model, "
        "       prompt_tokens, completion_tokens, "
        "       judge_prompt_tokens, judge_completion_tokens, "
        "       cleanup_prompt_tokens, cleanup_completion_tokens, "
        "       reasoning, reasoning_model_used "
        "FROM examples WHERE job_id = ? ORDER BY created_at ASC"
    )
    buffer: list[tuple] = []
    copied = 0

    async def _flush() -> None:
        nonlocal copied
        if not buffer:
            return
        await db.executemany(_CLEANUP_INSERT_SQL, buffer)
        await db.commit()
        copied += len(buffer)
        buffer.clear()
        progress.completed = copied
        await _update_progress(db, cleanup_job_id, "running", progress)
        log_event(
            cleanup_job_id, "cleanup_job_copy_batch",
            done=copied, total=progress.total_examples,
        )

    async with await db.execute(select_sql, (source_job_id,)) as cursor:
        async for row in cursor:
            if is_cancelled(cleanup_job_id):
                raise _CancelledError()
            buffer.append((
                str(uuid.uuid4()),
                cleanup_job_id,
                row["content_json"],
                row["format"],
                row["tokens"] or 0,
                row["created_at"],
                row["judge_score"],
                row["category"] or "",
                row["model"] or "",
                row["prompt_tokens"] or 0,
                row["completion_tokens"] or 0,
                row["judge_prompt_tokens"] or 0,
                row["judge_completion_tokens"] or 0,
                row["cleanup_prompt_tokens"] or 0,
                row["cleanup_completion_tokens"] or 0,
                row["reasoning"],
                row["reasoning_model_used"],
            ))
            if len(buffer) >= _CLEANUP_COPY_BATCH:
                await _flush()
    await _flush()
    return copied


async def _resolve_category_targets(
    db: aiosqlite.Connection,
    config: dict,
    request: CleanupJobRequest,
    progress: ProgressJson,
) -> dict[str, tuple[LLMProvider, str, str | None]]:
    """Resolve (provider, model, route) per category name.

    Falls back to the request defaults for every category without an override.
    Categories are keyed by the values actually present in the copied rows
    (``progress.categories``) so a source whose config drifted from its data —
    a merge, or a category renamed after the fact — still gets cleaned.
    """
    overrides: dict[str, dict] = {}
    for cat in config.get("categories", []):
        name = cat.get("name")
        if name:
            overrides[name] = cat

    cache: dict[str, LLMProvider] = {}

    async def _provider(provider_id: str) -> LLMProvider:
        if provider_id not in cache:
            cache[provider_id] = await get_provider(db, provider_id)
        return cache[provider_id]

    targets: dict[str, tuple[LLMProvider, str, str | None]] = {}
    for cat_name in progress.categories:
        cat_cfg = overrides.get(cat_name, {})
        provider_id = cat_cfg.get("cleanup_provider_id") or request.provider_id
        model = cat_cfg.get("cleanup_model") or request.model
        route = cat_cfg.get("cleanup_provider")
        if route is None:
            route = request.provider_route
        targets[cat_name] = (await _provider(provider_id), model, route or None)
    return targets


async def _run_cleanup_categories(
    *,
    db: aiosqlite.Connection,
    cleanup_job_id: str,
    fmt: str,
    config_max_tokens: int,
    cleanup_rules: str,
    targets: dict[str, tuple[LLMProvider, str, str | None]],
    progress: ProgressJson,
) -> tuple[int, int]:
    """Clean every copied example, category by category. Returns token totals.

    Categories run concurrently (cloud providers overlap; local backends
    serialize behind ``provider_gate`` inside ``_cleanup_example``), rows
    within a category run in order. Nothing is ever dropped: an example the
    stage could not fix keeps the content it was copied with, which is why
    ``progress.skipped`` stays 0 for the whole pass.
    """
    totals = {"prompt": 0, "completion": 0}

    # One tally shared by every category coroutine — the counters describe the
    # whole pass, exactly like the inline stage's job-level CleanupStats.
    stats = progress.cleanup_stats
    if stats is None:
        stats = CleanupStats()
        progress.cleanup_stats = stats

    async def _run_one_category(cat_name: str) -> None:
        provider, model, provider_route = targets[cat_name]
        async with await db.execute(
            "SELECT id, content_json, format FROM examples "
            "WHERE job_id = ? AND category = ? ORDER BY created_at ASC",
            (cleanup_job_id, cat_name),
        ) as cursor:
            rows = await cursor.fetchall()

        cp = progress.categories.get(cat_name)

        for row in rows:
            if is_cancelled(cleanup_job_id):
                raise _CancelledError()

            row_fmt = row["format"] or fmt
            try:
                content = json.loads(row["content_json"])
            except (json.JSONDecodeError, TypeError):
                content = None

            if not isinstance(content, dict):
                logger.warning(
                    "[cleanup-post] example %s has malformed content — skipped", row["id"],
                )
                stats.processed += 1
                stats.failed += 1
            else:
                # Same pool as the inline stage so both entry points together
                # never exceed the cleanup concurrency budget.
                async with _cleanup_semaphore:
                    cleaned, usage, outcome = await _cleanup_example(
                        provider, content, row_fmt, model,
                        cleanup_rules=cleanup_rules,
                        config_max_tokens=config_max_tokens,
                        provider_route=provider_route,
                        job_id=cleanup_job_id,
                        category=cat_name,
                    )

                prompt_tokens = usage.get("prompt_tokens", 0)
                completion_tokens = usage.get("completion_tokens", 0)
                totals["prompt"] += prompt_tokens
                totals["completion"] += completion_tokens

                stats.processed += 1
                if outcome == "modified":
                    stats.modified += 1
                elif outcome == "reverted":
                    stats.reverted += 1
                elif outcome == "failed":
                    stats.failed += 1
                else:
                    stats.unchanged += 1

                # Only a content-changing outcome rewrites the row; every
                # outcome still books the tokens it burned.
                if cleaned is not None and outcome in ("modified", "reverted"):
                    await db.execute(
                        _UPDATE_CONTENT_SQL,
                        (
                            json.dumps(cleaned, ensure_ascii=False),
                            prompt_tokens, completion_tokens, row["id"],
                        ),
                    )
                    await db.commit()
                elif prompt_tokens or completion_tokens:
                    await db.execute(
                        _UPDATE_TOKENS_SQL,
                        (prompt_tokens, completion_tokens, row["id"]),
                    )
                    await db.commit()

            progress.completed += 1
            if cp is not None:
                cp.completed += 1
            await _update_progress(db, cleanup_job_id, "running", progress)

    tasks = [
        asyncio.create_task(_run_one_category(name), name=f"cleanup-{name}")
        for name in targets
    ]
    try:
        await asyncio.gather(*tasks)
    except (Exception, asyncio.CancelledError):
        for t in tasks:
            if not t.done():
                t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise

    return totals["prompt"], totals["completion"]
