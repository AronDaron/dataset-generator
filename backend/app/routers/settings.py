from typing import Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.database import get_db
from app.utils import now_iso as _now_iso

router = APIRouter()

CONFIG_KEYS = [
    "delay_between_requests", "retry_count", "retry_cooldown", "default_model",
    "judge_enabled", "judge_model", "judge_threshold",
    "conversation_turns", "judge_criteria",
    "judge_provider",
    "embedding_model",
]
CONFIG_DEFAULTS = {
    "delay_between_requests": "2.0",
    "retry_count": "3",
    "retry_cooldown": "15",
    "default_model": "openai/gpt-3.5-turbo",
    "judge_enabled": "false",
    "judge_model": "",
    "judge_threshold": "80",
    "conversation_turns": "2",
    "judge_criteria": "relevance, coherence, naturalness, and educational value",
    "judge_provider": "",
    "embedding_model": "openai/text-embedding-3-small",
}


class ApiKeyRequest(BaseModel):
    api_key: str = Field(..., min_length=1)


class ApiKeyResponse(BaseModel):
    has_key: bool
    key_preview: Optional[str] = None  # e.g. "...ab3f"


class HfTokenRequest(BaseModel):
    token: str = Field(..., min_length=1)


class HfTokenResponse(BaseModel):
    has_token: bool
    token_preview: Optional[str] = None


class GlobalConfig(BaseModel):
    delay_between_requests: float = Field(default=2.0, ge=0.0, le=60.0)
    retry_count: int = Field(default=3, ge=1, le=10)
    retry_cooldown: int = Field(default=15, ge=1, le=120)
    default_model: str = Field(default="openai/gpt-3.5-turbo")
    judge_enabled: bool = False
    judge_model: Optional[str] = None
    judge_threshold: int = Field(default=80, ge=0, le=100)
    conversation_turns: int = Field(default=2, ge=1, le=5)
    judge_criteria: str = Field(default="relevance, coherence, naturalness, and educational value")
    judge_provider: Optional[str] = None
    embedding_model: Optional[str] = Field(default="openai/text-embedding-3-small")



@router.post("/api-key", status_code=204)
async def save_api_key(
    body: ApiKeyRequest,
    db: aiosqlite.Connection = Depends(get_db),
) -> None:
    """Legacy shim — writes the OpenRouter key into the providers row.

    The migration always seeds an `openrouter-default` row (disabled when no
    legacy key existed), so the UPDATE here is enough to make the existing
    frontend "API Key" tab keep working until it migrates to /api/providers.
    """
    await db.execute(
        "UPDATE providers SET api_key = ?, enabled = 1 WHERE id = 'openrouter-default'",
        (body.api_key,),
    )
    await db.commit()


@router.get("/api-key", response_model=ApiKeyResponse)
async def get_api_key(db: aiosqlite.Connection = Depends(get_db)) -> ApiKeyResponse:
    async with await db.execute(
        "SELECT api_key FROM providers WHERE id = 'openrouter-default'"
    ) as cursor:
        row = await cursor.fetchone()
    if not row or not row["api_key"]:
        return ApiKeyResponse(has_key=False)
    key: str = row["api_key"]
    preview = f"...{key[-4:]}" if len(key) >= 4 else "...****"
    return ApiKeyResponse(has_key=True, key_preview=preview)


@router.delete("/api-key", status_code=204)
async def delete_api_key(db: aiosqlite.Connection = Depends(get_db)) -> None:
    await db.execute(
        "UPDATE providers SET api_key = NULL, enabled = 0 WHERE id = 'openrouter-default'"
    )
    await db.commit()


@router.get("/config", response_model=GlobalConfig)
async def get_config(db: aiosqlite.Connection = Depends(get_db)) -> GlobalConfig:
    placeholders = ",".join("?" * len(CONFIG_KEYS))
    async with await db.execute(
        f"SELECT key, value FROM settings WHERE key IN ({placeholders})",
        CONFIG_KEYS,
    ) as cursor:
        rows = await cursor.fetchall()
    values: dict[str, str] = {**CONFIG_DEFAULTS, **{row["key"]: row["value"] for row in rows}}
    return GlobalConfig(
        delay_between_requests=float(values["delay_between_requests"]),
        retry_count=int(values["retry_count"]),
        retry_cooldown=int(values["retry_cooldown"]),
        default_model=values["default_model"],
        judge_enabled=values["judge_enabled"].lower() == "true",
        judge_model=values["judge_model"] or None,
        judge_threshold=int(values["judge_threshold"]),
        conversation_turns=int(values["conversation_turns"]),
        judge_criteria=values["judge_criteria"],
        judge_provider=values["judge_provider"] or None,
        embedding_model=values["embedding_model"] or None,
    )


@router.put("/config", response_model=GlobalConfig)
async def update_config(
    body: GlobalConfig,
    db: aiosqlite.Connection = Depends(get_db),
) -> GlobalConfig:
    updates = {
        "delay_between_requests": str(body.delay_between_requests),
        "retry_count": str(body.retry_count),
        "retry_cooldown": str(body.retry_cooldown),
        "default_model": body.default_model,
        "judge_enabled": "true" if body.judge_enabled else "false",
        "judge_model": body.judge_model or "",
        "judge_threshold": str(body.judge_threshold),
        "conversation_turns": str(body.conversation_turns),
        "judge_criteria": body.judge_criteria,
        "judge_provider": body.judge_provider or "",
        "embedding_model": body.embedding_model or "",
    }
    now = _now_iso()
    for key, value in updates.items():
        await db.execute(
            """
            INSERT INTO settings (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            """,
            (key, value, now),
        )
    await db.commit()
    return body


# ── HuggingFace Token ─────────────────────────────────────────


@router.post("/hf-token", status_code=204)
async def save_hf_token(
    body: HfTokenRequest,
    db: aiosqlite.Connection = Depends(get_db),
) -> None:
    await db.execute(
        """
        INSERT INTO settings (key, value, updated_at)
        VALUES ('hf_token', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        """,
        (body.token, _now_iso()),
    )
    await db.commit()


@router.get("/hf-token", response_model=HfTokenResponse)
async def get_hf_token(db: aiosqlite.Connection = Depends(get_db)) -> HfTokenResponse:
    async with await db.execute(
        "SELECT value FROM settings WHERE key = 'hf_token'"
    ) as cursor:
        row = await cursor.fetchone()
    if not row:
        return HfTokenResponse(has_token=False)
    token: str = row["value"]
    preview = f"...{token[-4:]}" if len(token) >= 4 else "...****"
    return HfTokenResponse(has_token=True, token_preview=preview)


@router.delete("/hf-token", status_code=204)
async def delete_hf_token(db: aiosqlite.Connection = Depends(get_db)) -> None:
    await db.execute("DELETE FROM settings WHERE key = 'hf_token'")
    await db.commit()
