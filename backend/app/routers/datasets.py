from __future__ import annotations

import json
import logging
import random
import subprocess
import sys
import uuid
from datetime import datetime

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.config import settings
from app.database import get_db
from app.models.jobs import MergeRequest, MergeResponse
from app.services.export_service import export_job
from app.services.hf_service import upload_to_huggingface
from app.utils import now_iso as _now_iso

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
    """Merge examples from multiple completed jobs into a single merged job."""
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
    configs = []
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

    # 3. Fetch all examples (full rows for copying into new job)
    async with await db.execute(
        f"SELECT content_json, format, tokens, judge_score, category, model, "
        f"prompt_tokens, completion_tokens, judge_prompt_tokens, judge_completion_tokens "
        f"FROM examples WHERE job_id IN ({placeholders}) ORDER BY created_at ASC",
        body.job_ids,
    ) as cursor:
        example_rows = await cursor.fetchall()

    if not example_rows:
        raise HTTPException(status_code=404, detail="No examples found in selected jobs")

    examples = [dict(row) for row in example_rows]

    # 4. Shuffle if requested
    if body.shuffle:
        random.shuffle(examples)

    total_examples = len(examples)

    # 5. Create merged job in DB
    merged_job_id = str(uuid.uuid4())
    now = _now_iso()

    # Collect unique categories across source jobs
    all_categories: dict[str, dict] = {}
    for cfg in configs:
        for cat in cfg.get("categories", []):
            if cat["name"] not in all_categories:
                all_categories[cat["name"]] = cat

    # Build a minimal config for the merged job
    merged_categories = list(all_categories.values())
    # Normalize proportions to sum to 1.0
    n_cats = len(merged_categories)
    for cat in merged_categories:
        cat["proportion"] = round(1.0 / n_cats, 4)
    if merged_categories:
        merged_categories[-1]["proportion"] = round(
            1.0 - sum(c["proportion"] for c in merged_categories[:-1]), 4
        )

    # Determine judge_enabled from any source
    any_judge = any(cfg.get("judge_enabled", False) for cfg in configs)

    merged_config = {
        "categories": merged_categories,
        "total_examples": max(total_examples, 10),
        "temperature": configs[0].get("temperature", 0.7),
        "max_tokens": max(cfg.get("max_tokens", 2048) for cfg in configs),
        "model": "merged",
        "format": dataset_format,
        "judge_enabled": any_judge,
        "conversation_turns": max(cfg.get("conversation_turns", 1) for cfg in configs),
        "merged_from": body.job_ids,
    }

    # Build progress for the merged job
    cat_counts: dict[str, int] = {}
    for ex in examples:
        cat_name = ex["category"] or "Unknown"
        cat_counts[cat_name] = cat_counts.get(cat_name, 0) + 1

    merged_progress = {
        "total_examples": total_examples,
        "completed": total_examples,
        "skipped": 0,
        "current_stage": "completed",
        "categories": {
            name: {"target": count, "completed": count, "skipped": 0}
            for name, count in cat_counts.items()
        },
    }

    await db.execute(
        "INSERT INTO jobs (id, status, config_json, progress_json, created_at, updated_at) "
        "VALUES (?, 'completed', ?, ?, ?, ?)",
        (merged_job_id, json.dumps(merged_config), json.dumps(merged_progress), now, now),
    )

    # 6. Copy examples into the new merged job
    for ex in examples:
        ex_id = str(uuid.uuid4())
        await db.execute(
            "INSERT INTO examples "
            "(id, job_id, content_json, format, tokens, judge_score, category, model, "
            "prompt_tokens, completion_tokens, judge_prompt_tokens, judge_completion_tokens) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                ex_id, merged_job_id, ex["content_json"], ex["format"],
                ex["tokens"], ex["judge_score"], ex["category"] or "",
                ex["model"] or "", ex["prompt_tokens"], ex["completion_tokens"],
                ex["judge_prompt_tokens"], ex["judge_completion_tokens"],
            ),
        )

    await db.commit()

    # 7. Export JSONL file for the merged job
    settings.datasets_dir.mkdir(parents=True, exist_ok=True)
    out_path = settings.datasets_dir / f"{merged_job_id}.jsonl"

    with out_path.open("w", encoding="utf-8") as fh:
        for ex in examples:
            obj = json.loads(ex["content_json"])
            fh.write(json.dumps(obj, ensure_ascii=False) + "\n")

    logger.info(
        "Merged %d examples from %d jobs → job %s (%s)",
        total_examples, len(body.job_ids), merged_job_id, out_path,
    )

    return MergeResponse(
        job_id=merged_job_id,
        path=str(out_path),
        total_examples=total_examples,
        source_jobs=len(body.job_ids),
    )
