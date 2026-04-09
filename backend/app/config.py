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


settings = Settings()
