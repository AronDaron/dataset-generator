from __future__ import annotations

import json
import logging
from pathlib import Path

import aiosqlite

from app.config import settings

logger = logging.getLogger(__name__)


async def export_job(job_id: str, db: aiosqlite.Connection) -> Path:
    """
    Fetch all examples for job_id from the DB and write them as JSONL to
    datasets_dir/{job_id}.jsonl.  Returns the output Path.

    Creates datasets_dir if it does not exist yet.
    Overwrites any previously exported file for the same job (idempotent).
    Raises RuntimeError if no examples exist for the job.
    """
    settings.datasets_dir.mkdir(parents=True, exist_ok=True)

    async with await db.execute(
        "SELECT content_json FROM examples "
        "WHERE job_id = ? ORDER BY created_at ASC",
        (job_id,),
    ) as cursor:
        rows = await cursor.fetchall()

    if not rows:
        raise RuntimeError(f"No examples found for job {job_id}")

    out_path = settings.datasets_dir / f"{job_id}.jsonl"

    with out_path.open("w", encoding="utf-8") as fh:
        for row in rows:
            obj = json.loads(row["content_json"])
            fh.write(json.dumps(obj, ensure_ascii=False) + "\n")

    logger.info("Exported %d examples for job %s → %s", len(rows), job_id, out_path)
    return out_path
