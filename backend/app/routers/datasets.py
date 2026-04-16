from __future__ import annotations

import json
import logging
import random
import subprocess
import sys
from datetime import datetime

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.config import settings
from app.database import get_db
from app.models.jobs import MergeRequest, MergeResponse
from app.services.export_service import export_job
from app.services.hf_service import upload_to_huggingface

router = APIRouter()
logger = logging.getLogger(__name__)


class HfUploadRequest(BaseModel):
    repo_name: str = Field(..., min_length=1, max_length=200)
    private: bool = True


class HfUploadResponse(BaseModel):
    url: str
    repo_name: str


@router.post("/open-folder")
async def open_datasets_folder() -> dict:
    """
    Open the datasets directory in the system file explorer.
    Creates the directory first if it does not exist.
    Failure to launch the explorer is logged but not propagated.
    """
    settings.datasets_dir.mkdir(parents=True, exist_ok=True)
    path_str = str(settings.datasets_dir)

    if sys.platform == "win32":
        cmd = ["explorer", path_str]
    elif sys.platform == "darwin":
        cmd = ["open", path_str]
    else:
        cmd = ["xdg-open", path_str]

    try:
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        logger.exception("Failed to open datasets folder: %s", path_str)

    return {"path": path_str}


@router.post("/{job_id}/upload-hf", response_model=HfUploadResponse)
async def upload_dataset_to_hf(
    job_id: str,
    body: HfUploadRequest,
    db: aiosqlite.Connection = Depends(get_db),
) -> HfUploadResponse:
    """Upload a job's JSONL dataset to HuggingFace Hub."""
    # 1. Get HF token
    async with await db.execute(
        "SELECT value FROM settings WHERE key = 'hf_token'"
    ) as cursor:
        row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=422, detail="HuggingFace token not configured. Add it in Settings.")

    hf_token: str = row["value"]

    # 2. Ensure JSONL file exists (export if needed)
    jsonl_path = settings.datasets_dir / f"{job_id}.jsonl"
    if not jsonl_path.exists():
        try:
            await export_job(job_id, db)
        except RuntimeError as exc:
            raise HTTPException(status_code=404, detail=str(exc))

    # 3. Upload to HuggingFace
    try:
        url = await upload_to_huggingface(
            file_path=jsonl_path,
            repo_id=body.repo_name,
            token=hf_token,
            private=body.private,
        )
    except RuntimeError as exc:
        detail = str(exc)
        dl = detail.lower()
        if any(kw in dl for kw in ("401", "403", "invalid", "unauthorized", "forbidden", "authentication")):
            raise HTTPException(status_code=401, detail="Invalid HuggingFace token. Check your token in Settings.")
        raise HTTPException(status_code=500, detail=detail)

    return HfUploadResponse(url=url, repo_name=body.repo_name)


@router.post("/merge", response_model=MergeResponse)
async def merge_datasets(
    body: MergeRequest,
    db: aiosqlite.Connection = Depends(get_db),
) -> MergeResponse:
    """Merge examples from multiple completed jobs into a single JSONL file."""
    placeholders = ",".join("?" * len(body.job_ids))

    # 1. Validate all jobs exist and are completed
    async with await db.execute(
        f"SELECT id, status, config_json FROM jobs WHERE id IN ({placeholders})",
        body.job_ids,
    ) as cursor:
        rows = await cursor.fetchall()

    found_ids = {row["id"] for row in rows}
    missing = set(body.job_ids) - found_ids
    if missing:
        raise HTTPException(status_code=404, detail=f"Jobs not found: {', '.join(missing)}")

    not_completed = [row["id"] for row in rows if row["status"] != "completed"]
    if not_completed:
        raise HTTPException(status_code=409, detail=f"Jobs not completed: {', '.join(not_completed)}")

    # 2. Validate all jobs have the same format
    formats = set()
    for row in rows:
        try:
            cfg = json.loads(row["config_json"])
            formats.add(cfg.get("format", "unknown"))
        except (json.JSONDecodeError, TypeError):
            formats.add("unknown")

    if len(formats) > 1:
        raise HTTPException(
            status_code=422,
            detail=f"Cannot merge jobs with different formats: {', '.join(formats)}",
        )

    # 3. Fetch all examples
    async with await db.execute(
        f"SELECT content_json FROM examples WHERE job_id IN ({placeholders}) ORDER BY created_at ASC",
        body.job_ids,
    ) as cursor:
        example_rows = await cursor.fetchall()

    if not example_rows:
        raise HTTPException(status_code=404, detail="No examples found in selected jobs")

    contents = [row["content_json"] for row in example_rows]

    # 4. Shuffle if requested
    if body.shuffle:
        random.shuffle(contents)

    # 5. Write merged JSONL
    settings.datasets_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = settings.datasets_dir / f"merged_{timestamp}.jsonl"

    with out_path.open("w", encoding="utf-8") as fh:
        for content_json in contents:
            obj = json.loads(content_json)
            fh.write(json.dumps(obj, ensure_ascii=False) + "\n")

    logger.info("Merged %d examples from %d jobs → %s", len(contents), len(body.job_ids), out_path)

    return MergeResponse(
        path=str(out_path),
        total_examples=len(contents),
        source_jobs=len(body.job_ids),
    )
