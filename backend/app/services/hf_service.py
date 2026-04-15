from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from huggingface_hub import HfApi
from huggingface_hub.errors import HfHubHTTPError

logger = logging.getLogger(__name__)


async def upload_to_huggingface(
    file_path: Path,
    repo_id: str,
    token: str,
    private: bool = True,
) -> str:
    """
    Upload a JSONL dataset file to HuggingFace Hub.

    Returns the URL of the created/updated dataset repo.
    Raises RuntimeError on failure.
    """
    api = HfApi(token=token)

    try:
        await asyncio.to_thread(
            api.create_repo,
            repo_id,
            repo_type="dataset",
            private=private,
            exist_ok=True,
        )
    except HfHubHTTPError as exc:
        logger.error("HF create_repo failed for %s: %s", repo_id, exc)
        raise RuntimeError(f"Failed to create repository: {exc}") from exc

    try:
        await asyncio.to_thread(
            api.upload_file,
            path_or_fileobj=str(file_path),
            path_in_repo="train.jsonl",
            repo_id=repo_id,
            repo_type="dataset",
        )
    except HfHubHTTPError as exc:
        logger.error("HF upload_file failed for %s: %s", repo_id, exc)
        raise RuntimeError(f"Failed to upload file: {exc}") from exc

    url = f"https://huggingface.co/datasets/{repo_id}"
    logger.info("Uploaded %s → %s", file_path.name, url)
    return url
