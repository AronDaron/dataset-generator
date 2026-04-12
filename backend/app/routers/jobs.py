from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import AsyncGenerator, Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.database import get_db
from app.models.jobs import (
    CategoryProgress,
    ExampleResponse,
    JobConfig,
    JobListItem,
    JobResponse,
    ProgressJson,
)
from app.services.export_service import export_job
from app.services.job_runner import cancel_job, run_job

router = APIRouter()


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


async def _get_api_key(db: aiosqlite.Connection) -> str:
    async with await db.execute(
        "SELECT value FROM settings WHERE key = 'openrouter_api_key'"
    ) as cursor:
        row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=422, detail="OpenRouter API key not configured")
    return row["value"]


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
    completed = 0
    progress = _parse_progress(row)
    if progress:
        completed = progress.completed
    return JobListItem(
        id=row["id"],
        status=row["status"],
        total_examples=config.total_examples,
        completed=completed,
        format=config.format,
        model=config.model,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


@router.post("", response_model=JobResponse, status_code=201)
async def create_job(
    body: JobConfig,
    db: aiosqlite.Connection = Depends(get_db),
) -> JobResponse:
    """Create and immediately start a generation job."""
    api_key = await _get_api_key(db)

    # Resolve delay, retry_count, retry_cooldown from global settings if not provided in body
    resolved_delay = body.delay_between_requests
    if resolved_delay is None:
        async with await db.execute(
            "SELECT value FROM settings WHERE key = 'delay_between_requests'"
        ) as cursor:
            row = await cursor.fetchone()
        resolved_delay = float(row["value"]) if row else 2.0

    async with await db.execute(
        "SELECT value FROM settings WHERE key = 'retry_count'"
    ) as cursor:
        row = await cursor.fetchone()
    resolved_retry_count = int(row["value"]) if row else 3

    async with await db.execute(
        "SELECT value FROM settings WHERE key = 'retry_cooldown'"
    ) as cursor:
        row = await cursor.fetchone()
    resolved_retry_cooldown = int(row["value"]) if row else 15

    config = body.model_copy(update={
        "delay_between_requests": resolved_delay,
        "retry_count": resolved_retry_count,
        "retry_cooldown": resolved_retry_cooldown,
    })

    job_id = str(uuid.uuid4())
    now = _now_iso()
    config_json = config.model_dump_json()

    initial_progress = ProgressJson(
        total_examples=config.total_examples,
        completed=0,
        skipped=0,
        current_stage="pending",
        categories={
            c.name: CategoryProgress(target=0, completed=0, skipped=0)
            for c in config.categories
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
        "SELECT id, status, config_json, progress_json, created_at, updated_at "
        "FROM jobs ORDER BY created_at DESC"
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
async def cancel_job_endpoint(
    job_id: str,
    db: aiosqlite.Connection = Depends(get_db),
) -> None:
    """Signal a running job to stop at its next cancellation checkpoint."""
    async with await db.execute(
        "SELECT status FROM jobs WHERE id = ?", (job_id,)
    ) as cursor:
        row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Job not found")
    if row["status"] not in ("pending", "running"):
        raise HTTPException(
            status_code=409, detail=f"Job is already {row['status']}"
        )

    cancel_job(job_id)
    now = _now_iso()
    await db.execute(
        "UPDATE jobs SET status = 'cancelling', updated_at = ? WHERE id = ?",
        (now, job_id),
    )
    await db.commit()


async def _stream_job_progress(
    job_id: str,
    db: aiosqlite.Connection,
) -> AsyncGenerator[str, None]:
    """Async generator yielding SSE messages for the given job."""
    POLL_INTERVAL = 0.75
    KEEPALIVE_EVERY_TICKS = int(20 / POLL_INTERVAL)  # ~20 s
    MAX_STREAM_TICKS = int(7200 / POLL_INTERVAL)      # 2h hard cap — protects against zombie jobs
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
            "SELECT id, job_id, content_json, format, tokens, created_at, judge_score "
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
            }
            for r in ex_rows
        ]

        payload = json.dumps({
            "status": status,
            "progress": progress.model_dump() if progress else None,
            "examples": examples,
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
        "SELECT id, job_id, content_json, format, tokens, created_at, judge_score "
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
        )
        for row in rows
    ]
