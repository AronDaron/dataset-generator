"""Async merge task — background execution of POST /api/datasets/merge.

Frontend no longer waits for the merge to finish; instead it redirects to
/jobs?id={merged_id} and watches the existing SSE stream. Validation (404,
409, 422) stays synchronous in `spawn_merge_job` so bad requests never create
a zombie merged row.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import uuid
import aiosqlite
from fastapi import HTTPException

from app.config import settings
from app.models.jobs import CategoryProgress, MergeRequest, ProgressJson
from app.routers.jobs import _fetch_source_configs, _is_merged, _resolve_leaf_sources
from app.services.event_log import log_event
from app.services.job_runner import (
    _CancelledError,
    _running_jobs,
    _update_progress,
    clear_cancellation,
    is_cancelled,
)
from app.services.stats_service import compute_and_store
from app.utils import now_iso as _now_iso

logger = logging.getLogger(__name__)

# Hard cap on merge size. Raised to 500_000 after P1-B streaming merge
# landed (no more fetchall OOM). For shuffle, see LARGE_SHUFFLE_THRESHOLD.
MAX_MERGE_EXAMPLES = 500_000

# Above this total, shuffle is skipped (with a warning event) — a true
# shuffle of 500k rows needs either a full in-memory materialization of
# content_json (~1GB) or per-id lookups, both out of scope here.
LARGE_SHUFFLE_THRESHOLD = 100_000

# executemany batch size (tuned for SQLite throughput vs memory pressure).
_MERGE_INSERT_BATCH = 1000

_MERGE_EXAMPLE_INSERT_SQL = (
    "INSERT INTO examples "
    "(id, job_id, content_json, format, tokens, judge_score, category, model, "
    "prompt_tokens, completion_tokens, judge_prompt_tokens, judge_completion_tokens) "
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)


def _jsonl_line(content_json: str) -> str:
    """Fast-path JSONL line. content_json is already minified by _save_example;
    defensive round-trip kicks in only for legacy rows with embedded newlines."""
    if "\n" in content_json:
        return json.dumps(json.loads(content_json), ensure_ascii=False)
    return content_json


def _make_merged_progress(total: int, stage: str) -> ProgressJson:
    return ProgressJson(
        total_examples=total,
        completed=0,
        skipped=0,
        current_stage=stage,
        categories={},
    )


async def spawn_merge_job(
    body: MergeRequest,
    db: aiosqlite.Connection,
) -> tuple[str, int]:
    """Validate inputs synchronously, create a pending merged job row, spawn
    the background task. Returns (merged_job_id, total_example_count).

    Raises HTTPException on any validation failure — nothing is persisted if
    validation fails.
    """
    placeholders = ",".join("?" * len(body.job_ids))

    # 1. Source jobs must all exist
    async with await db.execute(
        f"SELECT id, status, config_json FROM jobs WHERE id IN ({placeholders})",
        body.job_ids,
    ) as cursor:
        rows = await cursor.fetchall()
    found_ids = {row["id"] for row in rows}
    missing = set(body.job_ids) - found_ids
    if missing:
        raise HTTPException(status_code=404, detail=f"Jobs not found: {', '.join(missing)}")

    # 2. Source jobs must all be completed
    not_completed = [row["id"] for row in rows if row["status"] != "completed"]
    if not_completed:
        raise HTTPException(
            status_code=409,
            detail=f"Jobs not completed: {', '.join(not_completed)}",
        )

    # 3. All source jobs must share the same format
    formats: set[str] = set()
    configs: list[dict] = []
    for row in rows:
        try:
            cfg = json.loads(row["config_json"])
            configs.append(cfg)
            formats.add(cfg.get("format", "unknown"))
        except (json.JSONDecodeError, TypeError):
            formats.add("unknown")
    if len(formats) > 1:
        raise HTTPException(
            status_code=422,
            detail=f"Cannot merge jobs with different formats: {', '.join(formats)}",
        )
    dataset_format = formats.pop()

    # 4. Count total examples + hard cap
    async with await db.execute(
        f"SELECT COUNT(*) AS n FROM examples WHERE job_id IN ({placeholders})",
        body.job_ids,
    ) as cursor:
        count_row = await cursor.fetchone()
    total_count = count_row["n"] if count_row else 0
    if total_count == 0:
        raise HTTPException(status_code=404, detail="No examples found in selected jobs")
    if total_count > MAX_MERGE_EXAMPLES:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Cannot merge {total_count:,} examples — limit is "
                f"{MAX_MERGE_EXAMPLES:,}. Split into smaller merges."
            ),
        )

    # 5. Build merged config (identical to the old sync path — no business
    # logic change, only the INSERT moves into the background task).
    merged_config = await _build_merged_config(db, configs, body.job_ids, dataset_format, total_count)

    merged_job_id = str(uuid.uuid4())
    now = _now_iso()
    pending_progress = _make_merged_progress(total_count, "pending")

    await db.execute(
        "INSERT INTO jobs (id, status, config_json, progress_json, created_at, updated_at) "
        "VALUES (?, 'pending', ?, ?, ?, ?)",
        (merged_job_id, json.dumps(merged_config), pending_progress.model_dump_json(), now, now),
    )
    await db.commit()

    # 6. Spawn the background task. The task fetches the singleton db via
    # get_db() — aiosqlite serializes ops on the same connection so sharing
    # with the caller's Depends-injected handle is safe.
    _running_jobs.add(merged_job_id)
    asyncio.create_task(
        _merge_job_task(
            source_job_ids=list(body.job_ids),
            shuffle=body.shuffle,
            merged_job_id=merged_job_id,
            total_count=total_count,
        )
    )

    return merged_job_id, total_count


async def _build_merged_config(
    db: aiosqlite.Connection,
    configs: list[dict],
    source_job_ids: list[str],
    dataset_format: str,
    total_examples: int,
) -> dict:
    """Assemble the merged job's config_json. Mirrors the logic that used to
    live inline in routers/datasets.merge_datasets."""
    all_categories: dict[str, dict] = {}
    for cfg in configs:
        for cat in cfg.get("categories", []):
            if cat["name"] not in all_categories:
                all_categories[cat["name"]] = cat

    merged_categories = list(all_categories.values())
    n_cats = len(merged_categories) or 1
    for cat in merged_categories:
        cat["proportion"] = round(1.0 / n_cats, 4)
    if merged_categories:
        merged_categories[-1]["proportion"] = round(
            1.0 - sum(c["proportion"] for c in merged_categories[:-1]), 4
        )

    any_judge = any(cfg.get("judge_enabled", False) for cfg in configs)

    # Preserve real globals from source datasets (recursively descending into
    # nested merges so we never leak a "merged" placeholder).
    nested_ids: list[str] = []
    for cfg in configs:
        if _is_merged(cfg):
            nested_ids.extend(cfg.get("merged_from", []) or [])
    nested_map = await _fetch_source_configs(db, nested_ids) if nested_ids else {}
    leaf_configs = _resolve_leaf_sources(configs, nested_map)

    source_gen_globals = [cfg.get("model", "") for cfg in leaf_configs if cfg.get("model")]
    merged_gen_global = ", ".join(dict.fromkeys(source_gen_globals)) or "unknown"

    source_judge_globals = [
        cfg.get("judge_model", "")
        for cfg in leaf_configs
        if cfg.get("judge_enabled") and cfg.get("judge_model")
    ]
    merged_judge_global = ", ".join(dict.fromkeys(source_judge_globals)) or None

    return {
        "categories": merged_categories,
        "total_examples": max(total_examples, 10),
        "temperature": configs[0].get("temperature", 0.7),
        "max_tokens": max(cfg.get("max_tokens", 2048) for cfg in configs),
        "model": merged_gen_global,
        "format": dataset_format,
        "judge_enabled": any_judge,
        "judge_model": merged_judge_global,
        "conversation_turns": max(cfg.get("conversation_turns", 1) for cfg in configs),
        "merged_from": source_job_ids,
    }


def _row_to_params(r: dict, merged_job_id: str) -> tuple:
    """Map one example row dict to the positional tuple expected by
    _MERGE_EXAMPLE_INSERT_SQL. Kept as a plain helper so both shuffle and
    streaming paths share the same column ordering."""
    return (
        str(uuid.uuid4()), merged_job_id, r["content_json"], r["format"],
        r["tokens"], r["judge_score"], r["category"] or "",
        r["model"] or "", r["prompt_tokens"], r["completion_tokens"],
        r["judge_prompt_tokens"], r["judge_completion_tokens"],
    )


async def _merge_job_task(
    source_job_ids: list[str],
    shuffle: bool,
    merged_job_id: str,
    total_count: int,
) -> None:
    """Background task — copies source examples, writes JSONL, stores stats.

    State transitions:
        pending → running(merging_copying) → running(merging_exporting)
                → running(merging_computing_stats) → completed
    Honors cancellation between batches via is_cancelled(merged_job_id).
    Any exception → status='failed' with an error event in the log.
    """
    from app.database import get_db
    db = await get_db()

    # Load merged_config (we need categories + format in the task, and the
    # caller already serialized it into jobs.config_json).
    async with await db.execute(
        "SELECT config_json FROM jobs WHERE id = ?", (merged_job_id,)
    ) as cursor:
        row = await cursor.fetchone()
    merged_config = json.loads(row["config_json"]) if row else {}

    progress = _make_merged_progress(total_count, "merging_copying")

    cat_counts: dict[str, int] = {}
    try:
        log_event(
            merged_job_id, "merge_started",
            source_count=len(source_job_ids), total=total_count,
        )
        await _update_progress(db, merged_job_id, "running", progress)

        placeholders = ",".join("?" * len(source_job_ids))
        select_sql = (
            f"SELECT content_json, format, tokens, judge_score, category, model, "
            f"prompt_tokens, completion_tokens, judge_prompt_tokens, "
            f"judge_completion_tokens "
            f"FROM examples WHERE job_id IN ({placeholders}) ORDER BY created_at ASC"
        )

        # Shuffle path materializes everything (needed for deterministic
        # random order); skipped for large merges to protect desktop RAM.
        use_shuffle = shuffle
        if shuffle and total_count > LARGE_SHUFFLE_THRESHOLD:
            use_shuffle = False
            logger.warning(
                "Skipping shuffle for merge %s: %d rows > threshold %d",
                merged_job_id, total_count, LARGE_SHUFFLE_THRESHOLD,
            )
            log_event(
                merged_job_id, "merge_shuffle_skipped_large",
                total=total_count, threshold=LARGE_SHUFFLE_THRESHOLD,
            )

        materialized: list[dict] = []
        if use_shuffle:
            async with await db.execute(select_sql, source_job_ids) as cursor:
                example_rows = await cursor.fetchall()
            materialized = [dict(r) for r in example_rows]
            random.shuffle(materialized)
            for ex in materialized:
                cat_name = ex["category"] or "Unknown"
                cat_counts[cat_name] = cat_counts.get(cat_name, 0) + 1
            progress.categories = {
                name: CategoryProgress(target=count, completed=0, skipped=0)
                for name, count in cat_counts.items()
            }

        # --- Copy + export phase (fused: write each row to JSONL as we insert) ---
        progress.current_stage = "merging_copying"
        await _update_progress(db, merged_job_id, "running", progress)

        settings.datasets_dir.mkdir(parents=True, exist_ok=True)
        out_path = settings.datasets_dir / f"{merged_job_id}.jsonl"

        copied = 0
        insert_buffer: list[tuple] = []

        async def _flush_insert_buffer() -> None:
            nonlocal copied
            if not insert_buffer:
                return
            await db.executemany(_MERGE_EXAMPLE_INSERT_SQL, insert_buffer)
            copied += len(insert_buffer)
            insert_buffer.clear()
            progress.completed = copied
            if progress.categories:
                for cat_name, cp in progress.categories.items():
                    # For shuffle path we count from materialized; for streaming
                    # we use the running cat_counts which reflects inserted rows.
                    cp.completed = min(cat_counts.get(cat_name, 0), cp.target)
            await _update_progress(db, merged_job_id, "running", progress)
            log_event(merged_job_id, "merge_copy_batch", done=copied, total=total_count)

        with out_path.open("w", encoding="utf-8") as fh:
            if use_shuffle:
                # materialized path — already has content in memory
                for ex in materialized:
                    if is_cancelled(merged_job_id):
                        raise _CancelledError()
                    insert_buffer.append(_row_to_params(ex, merged_job_id))
                    fh.write(_jsonl_line(ex["content_json"]) + "\n")
                    if len(insert_buffer) >= _MERGE_INSERT_BATCH:
                        await _flush_insert_buffer()
                await _flush_insert_buffer()
            else:
                # Streaming path — iterate the cursor, write JSONL + insert by batch
                async with await db.execute(select_sql, source_job_ids) as cursor:
                    async for row in cursor:
                        if is_cancelled(merged_job_id):
                            raise _CancelledError()
                        ex = dict(row)
                        cat_name = ex["category"] or "Unknown"
                        cat_counts[cat_name] = cat_counts.get(cat_name, 0) + 1
                        if cat_name not in progress.categories:
                            progress.categories[cat_name] = CategoryProgress(
                                target=0, completed=0, skipped=0
                            )
                        # target grows as we see rows — updated to reflect what
                        # we've seen so far so the UI shows a sane fraction.
                        progress.categories[cat_name].target = cat_counts[cat_name]
                        insert_buffer.append(_row_to_params(ex, merged_job_id))
                        fh.write(_jsonl_line(ex["content_json"]) + "\n")
                        if len(insert_buffer) >= _MERGE_INSERT_BATCH:
                            await _flush_insert_buffer()
                await _flush_insert_buffer()
                # Final pass: set true targets == counts for stats.
                for cat_name, count in cat_counts.items():
                    progress.categories[cat_name].target = count
                    progress.categories[cat_name].completed = count

        await db.commit()

        # --- Export phase ---
        # JSONL was written inline during copy; the event is still fired for
        # backwards compatibility with activity-log consumers.
        if is_cancelled(merged_job_id):
            raise _CancelledError()
        progress.current_stage = "merging_exporting"
        await _update_progress(db, merged_job_id, "running", progress)
        log_event(merged_job_id, "merge_export_start")

        # --- Stats phase ---
        if is_cancelled(merged_job_id):
            raise _CancelledError()
        progress.current_stage = "merging_computing_stats"
        await _update_progress(db, merged_job_id, "running", progress)
        log_event(merged_job_id, "merge_stats_start")

        # Stats snapshot wants a progress that reflects the final completed
        # counts (target == completed for every category, same as the
        # legacy sync merge produced).
        final_progress = ProgressJson(
            total_examples=total_count,
            completed=total_count,
            skipped=0,
            current_stage="completed",
            categories={
                name: CategoryProgress(target=count, completed=count, skipped=0)
                for name, count in cat_counts.items()
            },
        )
        await compute_and_store(
            db, merged_job_id,
            judge_enabled=merged_config.get("judge_enabled", False),
            progress=final_progress,
        )

        await _update_progress(db, merged_job_id, "completed", final_progress)
        log_event(merged_job_id, "merge_completed", total=total_count)

    except _CancelledError:
        progress.current_stage = "cancelled"
        await _update_progress(db, merged_job_id, "cancelled", progress)

    except Exception as exc:
        logger.exception("Merge task %s failed", merged_job_id)
        progress.current_stage = "failed"
        await _update_progress(db, merged_job_id, "failed", progress)
        log_event(merged_job_id, "merge_failed", error=str(exc))

    finally:
        clear_cancellation(merged_job_id)
        _running_jobs.discard(merged_job_id)
