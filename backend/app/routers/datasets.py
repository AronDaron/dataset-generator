from __future__ import annotations

import logging
import subprocess
import sys

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.config import settings
from app.database import get_db
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
