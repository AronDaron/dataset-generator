from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import AsyncGenerator, Optional

logger = logging.getLogger(__name__)

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.config import settings
from app.database import get_db
from app.utils import get_api_key as _get_api_key, now_iso as _now_iso
import statistics

from app.models.jobs import (
    CategoryProgress,
    CategoryRunInfo,
    DuplicateRequest,
    DuplicatesResponse,
    ExampleResponse,
    GenerationEfficiency,
    JobConfig,
    JobListItem,
    JobResponse,
    JobStatsResponse,
    ProgressJson,
    RunSummary,
    ScoreBucket,
    ScoreDistribution,
    TokenStatsByCategory,
)
from app.services.dedup_service import find_duplicates
from app.services.event_log import clear_events, get_events
from app.services.export_service import export_job
from app.services.job_runner import cancel_job, distribute_examples, run_job

router = APIRouter()


def _parse_progress(row) -> Optional[ProgressJson]:
    if not row["progress_json"]:
        return None
    try:
        return ProgressJson.model_validate_json(row["progress_json"])
    except Exception:
        return None


def _parse_config(row) -> JobConfig:
    return JobConfig.model_validate_json(row["config_json"])


def _row_to_job_response(row) -> JobResponse:
    config = _parse_config(row)
    progress = _parse_progress(row)
    return JobResponse(
        id=row["id"],
        status=row["status"],
        config=config,
        progress=progress,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _row_to_list_item(row) -> JobListItem:
    config = _parse_config(row)
    actual_cost = None
    judge_cost = None
    progress = _parse_progress(row)
    if progress:
        actual_cost = progress.actual_cost
        judge_cost = progress.judge_cost
    # Real count from examples table — reflects deletions (dedup, manual)
    completed = row["actual_count"]
    category_models = [cat.model or config.model for cat in config.categories]
    # Detect merged jobs by checking for merged_from in config_json
    is_merged = False
    try:
        raw_cfg = json.loads(row["config_json"])
        is_merged = "merged_from" in raw_cfg
    except (json.JSONDecodeError, TypeError):
        pass
    return JobListItem(
        id=row["id"],
        status=row["status"],
        total_examples=config.total_examples,
        completed=completed,
        format=config.format,
        model=config.model,
        category_models=category_models,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        actual_cost=actual_cost,
        judge_cost=judge_cost,
        is_merged=is_merged,
    )


@router.post("", response_model=JobResponse, status_code=201)
async def create_job(
    body: JobConfig,
    db: aiosqlite.Connection = Depends(get_db),
) -> JobResponse:
    """Create and immediately start a generation job."""
    api_key = await _get_api_key(db)

    # Resolve delay, retry_count, retry_cooldown from global settings if not provided in body
    keys = ('delay_between_requests', 'retry_count', 'retry_cooldown')
    placeholders = ','.join('?' * len(keys))
    async with await db.execute(
        f"SELECT key, value FROM settings WHERE key IN ({placeholders})", keys
    ) as cursor:
        rows = await cursor.fetchall()
    s = {row["key"]: row["value"] for row in rows}

    resolved_delay = body.delay_between_requests
    if resolved_delay is None:
        resolved_delay = float(s.get("delay_between_requests") or 2.0)
    resolved_retry_count = int(s.get("retry_count") or 3)
    resolved_retry_cooldown = int(s.get("retry_cooldown") or 15)

    config = body.model_copy(update={
        "delay_between_requests": resolved_delay,
        "retry_count": resolved_retry_count,
        "retry_cooldown": resolved_retry_cooldown,
    })

    job_id = str(uuid.uuid4())
    now = _now_iso()
    config_json = config.model_dump_json()

    counts = distribute_examples(config.categories, config.total_examples)
    initial_progress = ProgressJson(
        total_examples=config.total_examples,
        completed=0,
        skipped=0,
        current_stage="pending",
        categories={
            c.name: CategoryProgress(target=n, completed=0, skipped=0)
            for c, n in zip(config.categories, counts)
        },
    )

    await db.execute(
        "INSERT INTO jobs (id, status, config_json, progress_json, created_at, updated_at) "
        "VALUES (?, 'pending', ?, ?, ?, ?)",
        (job_id, config_json, initial_progress.model_dump_json(), now, now),
    )
    await db.commit()

    asyncio.create_task(run_job(job_id, config, api_key))

    return JobResponse(
        id=job_id,
        status="pending",
        config=config,
        progress=initial_progress,
        created_at=now,
        updated_at=now,
    )


@router.get("", response_model=list[JobListItem])
async def list_jobs(
    db: aiosqlite.Connection = Depends(get_db),
) -> list[JobListItem]:
    """List all jobs ordered by creation time descending."""
    async with await db.execute(
        "SELECT j.id, j.status, j.config_json, j.progress_json, j.created_at, j.updated_at, "
        "(SELECT COUNT(*) FROM examples WHERE examples.job_id = j.id) AS actual_count "
        "FROM jobs j ORDER BY j.created_at DESC"
    ) as cursor:
        rows = await cursor.fetchall()
    return [_row_to_list_item(row) for row in rows]


@router.get("/{job_id}", response_model=JobResponse)
async def get_job(
    job_id: str,
    db: aiosqlite.Connection = Depends(get_db),
) -> JobResponse:
    """Get full job details including progress."""
    async with await db.execute(
        "SELECT id, status, config_json, progress_json, created_at, updated_at "
        "FROM jobs WHERE id = ?",
        (job_id,),
    ) as cursor:
        row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Job not found")
    return _row_to_job_response(row)


@router.delete("/{job_id}", status_code=204)
async def delete_job_endpoint(
    job_id: str,
    db: aiosqlite.Connection = Depends(get_db),
) -> None:
    """Cancel a running job, or hard-delete a terminal job from the database."""
    async with await db.execute(
        "SELECT status FROM jobs WHERE id = ?", (job_id,)
    ) as cursor:
        row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Job not found")

    status = row["status"]

    if status in ("pending", "running"):
        cancel_job(job_id)
        now = _now_iso()
        await db.execute(
            "UPDATE jobs SET status = 'cancelling', updated_at = ? WHERE id = ?",
            (now, job_id),
        )
        await db.commit()

    elif status in ("completed", "cancelled", "failed"):
        await db.execute("DELETE FROM examples WHERE job_id = ?", (job_id,))
        await db.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
        await db.commit()
        clear_events(job_id)
        jsonl_path = settings.datasets_dir / f"{job_id}.jsonl"
        logger.info("Deleting JSONL file: %s (exists=%s)", jsonl_path, jsonl_path.exists())
        try:
            jsonl_path.unlink(missing_ok=True)
            logger.info("JSONL file deleted: %s", jsonl_path)
        except Exception:
            logger.exception("Failed to delete JSONL file: %s", jsonl_path)

    else:
        raise HTTPException(
            status_code=409, detail=f"Job is currently {status}, try again shortly"
        )


async def _stream_job_progress(
    job_id: str,
    db: aiosqlite.Connection,
) -> AsyncGenerator[str, None]:
    """Async generator yielding SSE messages for the given job."""
    POLL_INTERVAL = 0.75
    KEEPALIVE_EVERY_TICKS = int(20 / POLL_INTERVAL)  # ~20 s
    MAX_STREAM_TICKS = int(86400 / POLL_INTERVAL)     # 24h hard cap — protects against zombie jobs; frontend auto-reconnects
    TERMINAL_STATES = {"completed", "cancelled", "failed"}

    # Validate job exists before opening the stream
    async with await db.execute(
        "SELECT id FROM jobs WHERE id = ?", (job_id,)
    ) as cursor:
        row = await cursor.fetchone()
    if not row:
        yield "event: error\ndata: " + json.dumps({"detail": "Job not found"}) + "\n\n"
        return

    tick = 0
    while True:
        async with await db.execute(
            "SELECT status, progress_json FROM jobs WHERE id = ?", (job_id,)
        ) as cursor:
            job_row = await cursor.fetchone()

        async with await db.execute(
            "SELECT id, job_id, content_json, format, tokens, created_at, judge_score, category, model "
            "FROM examples WHERE job_id = ? ORDER BY created_at DESC LIMIT 5",
            (job_id,),
        ) as cursor:
            ex_rows = await cursor.fetchall()

        status = job_row["status"]
        progress = _parse_progress(job_row)
        examples = [
            {
                "id": r["id"],
                "job_id": r["job_id"],
                "content": json.loads(r["content_json"]),
                "format": r["format"],
                "tokens": r["tokens"],
                "created_at": r["created_at"],
                "judge_score": r["judge_score"],
                "category": r["category"],
                "model": r["model"],
            }
            for r in ex_rows
        ]

        recent_events = [e.model_dump() for e in get_events(job_id)]

        payload = json.dumps({
            "status": status,
            "progress": progress.model_dump() if progress else None,
            "examples": examples,
            "recent_events": recent_events,
        })

        is_terminal = status in TERMINAL_STATES
        event_name = "done" if is_terminal else "progress"
        yield f"event: {event_name}\ndata: {payload}\n\n"

        if is_terminal:
            return

        tick += 1
        if tick >= MAX_STREAM_TICKS:
            yield "event: error\ndata: " + json.dumps({"detail": "Stream timeout"}) + "\n\n"
            return
        if tick % KEEPALIVE_EVERY_TICKS == 0:
            yield ": keepalive\n\n"

        await asyncio.sleep(POLL_INTERVAL)


@router.get("/{job_id}/stream")
async def stream_job_progress(
    job_id: str,
    db: aiosqlite.Connection = Depends(get_db),
):
    """SSE: stream job progress until terminal state (completed/cancelled/failed)."""
    return StreamingResponse(
        _stream_job_progress(job_id, db),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.get("/{job_id}/export")
async def export_job_endpoint(
    job_id: str,
    db: aiosqlite.Connection = Depends(get_db),
) -> dict:
    """Export job examples to JSONL and return the file path. Job must be completed."""
    async with await db.execute(
        "SELECT status FROM jobs WHERE id = ?", (job_id,)
    ) as cursor:
        row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Job not found")
    if row["status"] != "completed":
        raise HTTPException(
            status_code=409,
            detail=f"Job is not completed (current status: {row['status']})",
        )

    try:
        path = await export_job(job_id, db)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {"path": str(path), "job_id": job_id}


@router.get("/{job_id}/examples", response_model=list[ExampleResponse])
async def list_examples(
    job_id: str,
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: aiosqlite.Connection = Depends(get_db),
) -> list[ExampleResponse]:
    """Paginated list of examples for a job, newest first."""
    async with await db.execute(
        "SELECT id FROM jobs WHERE id = ?", (job_id,)
    ) as cursor:
        if not await cursor.fetchone():
            raise HTTPException(status_code=404, detail="Job not found")
    async with await db.execute(
        "SELECT id, job_id, content_json, format, tokens, created_at, judge_score, category, model "
        "FROM examples WHERE job_id = ? "
        "ORDER BY created_at DESC LIMIT ? OFFSET ?",
        (job_id, limit, offset),
    ) as cursor:
        rows = await cursor.fetchall()
    return [
        ExampleResponse(
            id=row["id"],
            job_id=row["job_id"],
            content=json.loads(row["content_json"]),
            format=row["format"],
            tokens=row["tokens"],
            created_at=row["created_at"],
            judge_score=row["judge_score"],
            category=row["category"],
            model=row["model"],
        )
        for row in rows
    ]


# ---- Quality Report / Stats ----


def _compute_score_buckets(scores: list[int]) -> list[ScoreBucket]:
    """Build histogram buckets with dynamic width based on score range."""
    if not scores:
        return []
    min_s, max_s = min(scores), max(scores)
    score_range = max_s - min_s
    if score_range <= 10:
        width = 1
    elif score_range <= 25:
        width = 5
    else:
        width = 10
    start = (min_s // width) * width
    buckets: list[ScoreBucket] = []
    while start <= max_s:
        end = min(start + width, max_s + 1)
        is_last = end > max_s
        count = sum(1 for s in scores if start <= s < end) if not is_last else sum(1 for s in scores if start <= s <= max_s)
        upper_label = min(start + width - 1, max_s)
        label = f"{start}-{upper_label}" if width > 1 else str(start)
        if count > 0:
            buckets.append(ScoreBucket(label=label, count=count))
        start += width
    return buckets


def _build_run_summary(row, config: JobConfig, progress: Optional[ProgressJson]) -> RunSummary:
    """Build RunSummary from a jobs row + parsed config/progress."""
    status = row["status"]
    started_at = row["created_at"]
    is_terminal = status in ("completed", "cancelled", "failed")
    ended_at = row["updated_at"] if is_terminal else None

    duration_seconds: Optional[int] = None
    if ended_at:
        try:
            from datetime import datetime
            start_dt = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
            end_dt = datetime.fromisoformat(ended_at.replace("Z", "+00:00"))
            duration_seconds = max(0, int((end_dt - start_dt).total_seconds()))
        except (ValueError, TypeError):
            duration_seconds = None

    # Detect merged jobs by merged_from in config_json
    is_merged = False
    merged_from_count = 0
    try:
        raw_cfg = json.loads(row["config_json"])
        merged_from = raw_cfg.get("merged_from")
        if isinstance(merged_from, list):
            is_merged = True
            merged_from_count = len(merged_from)
    except (json.JSONDecodeError, TypeError):
        pass

    progress_cats = progress.categories if progress and progress.categories else {}

    cat_infos: list[CategoryRunInfo] = []
    for cat in config.categories:
        gen_model = cat.model or config.model
        gen_provider = cat.provider
        gen_is_default = cat.model is None

        if config.judge_enabled:
            judge_model = cat.judge_model or config.judge_model or config.model
            judge_provider = cat.judge_provider or config.judge_provider
            judge_is_default = cat.judge_model is None
        else:
            judge_model = None
            judge_provider = None
            judge_is_default = False

        cat_progress = progress_cats.get(cat.name)
        target = cat_progress.target if cat_progress else 0
        completed = cat_progress.completed if cat_progress else 0

        cat_infos.append(
            CategoryRunInfo(
                name=cat.name,
                gen_model=gen_model,
                gen_provider=gen_provider,
                gen_model_is_default=gen_is_default,
                judge_model=judge_model,
                judge_provider=judge_provider,
                judge_model_is_default=judge_is_default,
                target=target,
                completed=completed,
            )
        )

    actual_examples = progress.completed if progress else 0

    return RunSummary(
        started_at=started_at,
        ended_at=ended_at,
        duration_seconds=duration_seconds,
        status=status,
        format=config.format,
        total_examples=config.total_examples,
        actual_examples=actual_examples,
        is_merged=is_merged,
        merged_from_count=merged_from_count,
        categories=cat_infos,
    )


@router.get("/{job_id}/stats", response_model=JobStatsResponse)
async def get_job_stats(
    job_id: str,
    db: aiosqlite.Connection = Depends(get_db),
) -> JobStatsResponse:
    """Quality report statistics for a completed job."""
    async with await db.execute(
        "SELECT id, status, config_json, progress_json, created_at, updated_at FROM jobs WHERE id = ?",
        (job_id,),
    ) as cursor:
        row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Job not found")

    config = JobConfig.model_validate_json(row["config_json"])
    progress = _parse_progress(row)
    run_summary = _build_run_summary(row, config, progress)

    # Token stats by category
    async with await db.execute(
        "SELECT "
        "  CASE WHEN category = '' THEN 'Unknown' ELSE category END AS cat, "
        "  COUNT(*) AS cnt, "
        "  ROUND(AVG(prompt_tokens + completion_tokens), 1) AS avg_tok, "
        "  MIN(prompt_tokens + completion_tokens) AS min_tok, "
        "  MAX(prompt_tokens + completion_tokens) AS max_tok "
        "FROM examples WHERE job_id = ? "
        "GROUP BY cat ORDER BY cat",
        (job_id,),
    ) as cursor:
        token_rows = await cursor.fetchall()

    token_stats = [
        TokenStatsByCategory(
            category=r["cat"],
            examples_count=r["cnt"],
            avg_tokens=r["avg_tok"] or 0,
            min_tokens=r["min_tok"] or 0,
            max_tokens=r["max_tok"] or 0,
        )
        for r in token_rows
    ]

    # Score distribution (only when judge was enabled)
    score_dist = None
    if config.judge_enabled:
        async with await db.execute(
            "SELECT judge_score FROM examples "
            "WHERE job_id = ? AND judge_score IS NOT NULL",
            (job_id,),
        ) as cursor:
            score_rows = await cursor.fetchall()
        scores = [r["judge_score"] for r in score_rows]
        if scores:
            sorted_scores = sorted(scores)
            score_dist = ScoreDistribution(
                buckets=_compute_score_buckets(scores),
                total=len(scores),
                min_score=sorted_scores[0],
                max_score=sorted_scores[-1],
                avg_score=round(statistics.mean(scores), 1),
                median_score=int(statistics.median(sorted_scores)),
            )

    # Generation efficiency from progress_json
    efficiency: list[GenerationEfficiency] = []
    if progress and progress.categories:
        for cat_name, cat_prog in progress.categories.items():
            total_attempts = cat_prog.completed + cat_prog.skipped
            rate = (cat_prog.completed / total_attempts * 100) if total_attempts > 0 else 100.0
            efficiency.append(
                GenerationEfficiency(
                    category=cat_name,
                    target=cat_prog.target,
                    completed=cat_prog.completed,
                    skipped=cat_prog.skipped,
                    success_rate=round(rate, 1),
                )
            )

    return JobStatsResponse(
        job_id=job_id,
        judge_enabled=config.judge_enabled,
        run_summary=run_summary,
        score_distribution=score_dist,
        token_stats=token_stats,
        generation_efficiency=efficiency,
    )


# ---- Deduplication ----


@router.post("/{job_id}/duplicates", response_model=DuplicatesResponse)
async def find_duplicate_examples(
    job_id: str,
    body: DuplicateRequest,
    db: aiosqlite.Connection = Depends(get_db),
) -> DuplicatesResponse:
    """Find near-duplicate example pairs using embedding cosine similarity."""
    async with await db.execute(
        "SELECT id FROM jobs WHERE id = ?", (job_id,)
    ) as cur:
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="Job not found")

    async with await db.execute(
        "SELECT COUNT(*) FROM examples WHERE job_id = ?", (job_id,)
    ) as cur:
        row = await cur.fetchone()
        total = row[0] if row else 0

    # Fetch API key and embedding model from settings
    api_key = await _get_api_key(db)

    async with await db.execute(
        "SELECT value FROM settings WHERE key = 'embedding_model'"
    ) as cur:
        em_row = await cur.fetchone()
    embedding_model = (em_row["value"] if em_row and em_row["value"] else "openai/text-embedding-3-small")

    pairs = await find_duplicates(db, job_id, body.threshold, api_key, embedding_model)
    return DuplicatesResponse(pairs=pairs, total_examples=total)


@router.delete("/{job_id}/examples/{example_id}", status_code=204)
async def delete_example(
    job_id: str,
    example_id: str,
    db: aiosqlite.Connection = Depends(get_db),
) -> None:
    """Delete a single example from a job."""
    async with await db.execute(
        "SELECT id FROM examples WHERE id = ? AND job_id = ?",
        (example_id, job_id),
    ) as cur:
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="Example not found")

    await db.execute(
        "DELETE FROM examples WHERE id = ? AND job_id = ?",
        (example_id, job_id),
    )
    await db.commit()

    # Keep JSONL file in sync with DB state
    jsonl_path = settings.datasets_dir / f"{job_id}.jsonl"
    async with await db.execute(
        "SELECT COUNT(*) AS n FROM examples WHERE job_id = ?", (job_id,)
    ) as cur:
        remaining = (await cur.fetchone())["n"]
    if remaining == 0:
        jsonl_path.unlink(missing_ok=True)
    else:
        await export_job(job_id, db)
