from __future__ import annotations

import logging
from pathlib import Path

import aiosqlite

from app.config import settings
from app.services.example_schema import serialize_for_jsonl

logger = logging.getLogger(__name__)


async def export_job(job_id: str, db: aiosqlite.Connection) -> Path:
    """
    Fetch all examples for job_id from the DB and write them as JSONL to
    datasets_dir/{job_id}.jsonl.  Returns the output Path.

    Creates datasets_dir if it does not exist yet.
    Overwrites any previously exported file for the same job (idempotent).
    Raises RuntimeError if no examples exist for the job.

    Each row is passed through ``serialize_for_jsonl`` which strips extra
    top-level and per-turn keys not in the format whitelist. This is a no-op
    for rows produced by the strict validator (post-fix); for legacy rows
    that snuck through the old liberal validator it ensures every emitted
    line shares the same Arrow/HF schema.
    """
    settings.datasets_dir.mkdir(parents=True, exist_ok=True)

    async with await db.execute(
        "SELECT content_json, format FROM examples "
        "WHERE job_id = ? ORDER BY created_at ASC",
        (job_id,),
    ) as cursor:
        rows = await cursor.fetchall()

    if not rows:
        raise RuntimeError(f"No examples found for job {job_id}")

    out_path = settings.datasets_dir / f"{job_id}.jsonl"

    stripped_rows = 0
    total_dropped = 0
    sample_paths: list[str] = []
    with out_path.open("w", encoding="utf-8") as fh:
        for row in rows:
            line, dropped = serialize_for_jsonl(row["content_json"], row["format"])
            fh.write(line + "\n")
            if dropped:
                stripped_rows += 1
                total_dropped += len(dropped)
                if len(sample_paths) < 5:
                    sample_paths.extend(dropped[: 5 - len(sample_paths)])

    if stripped_rows:
        logger.warning(
            "Export %s: stripped extra keys from %d/%d rows "
            "(dropped %d paths total, sample=%s)",
            job_id, stripped_rows, len(rows), total_dropped, sample_paths,
        )

    logger.info("Exported %d examples for job %s → %s", len(rows), job_id, out_path)
    return out_path
