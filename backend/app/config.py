from dataclasses import dataclass, field
from typing import List


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


settings = Settings()
