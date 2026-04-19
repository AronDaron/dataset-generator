import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import List


def get_app_data_dir() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home())) / "DatasetGenerator"
    else:
        base = Path.home() / ".datasetgenerator"
    base.mkdir(parents=True, exist_ok=True)
    return base


def get_frontend_dir() -> Path:
    # PyInstaller onedir build: bundled assets live under sys._MEIPASS
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS) / "out"  # type: ignore[attr-defined]
    # Dev / python desktop.py: backend/app/config.py -> parents[2] is repo root
    return Path(__file__).resolve().parents[2] / "frontend" / "out"


@dataclass
class Settings:
    # CORS origins for development
    # In Phase 6 (pywebview desktop build), same-origin so CORS not needed
    cors_origins: List[str] = field(
        default_factory=lambda: [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
        ]
    )
    db_path: Path = field(default_factory=lambda: get_app_data_dir() / "database.sqlite")
    datasets_dir: Path = field(default_factory=lambda: get_app_data_dir() / "datasets")
    frontend_dir: Path = field(default_factory=get_frontend_dir)


settings = Settings()
