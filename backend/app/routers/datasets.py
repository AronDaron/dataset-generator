from __future__ import annotations

import logging
import subprocess
import sys

from fastapi import APIRouter

from app.config import settings

router = APIRouter()
logger = logging.getLogger(__name__)


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
