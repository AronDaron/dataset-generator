from __future__ import annotations

import logging
import subprocess
import sys

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


class DownloadRequest(BaseModel):
    # Save-to-disk proxy. Neither a.click() on a Blob nor a form-POST with
    # Content-Disposition triggers a download inside pywebview/WebView2 (no
    # default download handler), so we write the file ourselves and hand the
    # frontend a path it can reveal via POST /api/datasets/open-folder.
    filename: str = Field(..., min_length=1, max_length=200, pattern=r"^[A-Za-z0-9._\- ]+$")
    mime_type: str = Field(..., min_length=1, max_length=100)
    content: str = Field(..., max_length=20_000_000)


class DownloadResponse(BaseModel):
    path: str
    filename: str
    directory: str


@router.post("/download", response_model=DownloadResponse)
async def proxy_download(body: DownloadRequest) -> DownloadResponse:
    settings.datasets_dir.mkdir(parents=True, exist_ok=True)
    target = settings.datasets_dir / body.filename
    target.write_text(body.content, encoding="utf-8")
    return DownloadResponse(
        path=str(target),
        filename=body.filename,
        directory=str(settings.datasets_dir),
    )


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


@router.post("/merge", response_model=MergeResponse, status_code=202)
async def merge_datasets(
    body: MergeRequest,
    db: aiosqlite.Connection = Depends(get_db),
) -> MergeResponse:
    """Queue an async merge of multiple completed jobs.

    Validation (404/409/422) happens synchronously. On success, a pending
    merged job is created and a background task drives it to completion —
    the frontend redirects to /jobs?id={job_id} and reads the existing SSE
    stream. `path` comes back empty at 202; the JSONL file is produced by
    the background task before it flips status to completed.
    """
    from app.services.merge_service import spawn_merge_job
    merged_job_id, total_count = await spawn_merge_job(body, db)
    return MergeResponse(
        job_id=merged_job_id,
        path="",
        total_examples=total_count,
        source_jobs=len(body.job_ids),
    )
