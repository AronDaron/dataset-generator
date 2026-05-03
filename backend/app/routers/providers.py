"""CRUD + introspection endpoints for the multi-provider registry.

Surfaces the `providers` table to the frontend Settings UI: list/add/edit/delete
providers, test connectivity, list models from each provider, and auto-detect
local Ollama / LM Studio / llama.cpp endpoints.
"""

from __future__ import annotations

import uuid
from typing import Any, Literal, Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.database import get_db
from app.services.llm.auto_detect import detect_local_endpoints
from app.services.llm.base import LLMError
from app.services.llm.registry import (
    ProviderDisabledError,
    ProviderNotFoundError,
    build_provider,
    get_provider_row,
    list_providers,
)
from app.services.job_runner import is_running
from app.utils import now_iso as _now_iso

router = APIRouter()

ProviderKind = Literal["openrouter", "openai_compat"]

DEFAULT_BASE_URLS: dict[str, str] = {
    "openrouter": "https://openrouter.ai/api/v1",
    "openai_compat": "http://127.0.0.1:11434/v1",
}


class ProviderResponse(BaseModel):
    id: str
    kind: ProviderKind
    name: str
    base_url: str
    enabled: bool
    is_default: bool
    has_api_key: bool
    api_key_preview: Optional[str] = None
    created_at: str


class ProviderCreate(BaseModel):
    kind: ProviderKind
    name: str = Field(..., min_length=1, max_length=100)
    base_url: str = Field(..., min_length=1, max_length=500)
    api_key: Optional[str] = Field(default=None, max_length=500)
    enabled: bool = True
    set_default: bool = False


class ProviderUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    base_url: Optional[str] = Field(default=None, min_length=1, max_length=500)
    api_key: Optional[str] = Field(default=None, max_length=500)
    enabled: Optional[bool] = None
    set_default: Optional[bool] = None


class TestConnectionResponse(BaseModel):
    ok: bool
    models_count: int = 0
    error: Optional[str] = None


class AutoDetectResponse(BaseModel):
    candidates: list["AutoDetectCandidate"]


class AutoDetectCandidate(BaseModel):
    label: str
    base_url: str
    models_count: int


def _to_response(row: dict[str, Any]) -> ProviderResponse:
    api_key = row.get("api_key")
    preview = None
    if api_key:
        preview = f"...{api_key[-4:]}" if len(api_key) >= 4 else "...****"
    return ProviderResponse(
        id=row["id"],
        kind=row["kind"],
        name=row["name"],
        base_url=row["base_url"],
        enabled=bool(row["enabled"]),
        is_default=bool(row["is_default"]),
        has_api_key=bool(api_key),
        api_key_preview=preview,
        created_at=row["created_at"],
    )


def _llm_error_to_http(e: LLMError) -> HTTPException:
    if e.status_code in (404,):
        return HTTPException(status_code=404, detail=str(e))
    if e.status_code == 409:
        return HTTPException(status_code=409, detail=str(e))
    if e.status_code == 401:
        return HTTPException(status_code=401, detail="Invalid credentials for provider")
    if e.status_code == 429:
        return HTTPException(status_code=429, detail="Rate limit at provider")
    if e.status_code >= 500:
        return HTTPException(status_code=502, detail=f"Provider upstream error: {e}")
    return HTTPException(status_code=e.status_code, detail=str(e))


async def _clear_default(db: aiosqlite.Connection) -> None:
    await db.execute("UPDATE providers SET is_default = 0 WHERE is_default = 1")


async def _ensure_unique_default_after_change(
    db: aiosqlite.Connection,
    *,
    set_default: bool,
    provider_id: str,
) -> None:
    if set_default:
        await _clear_default(db)
        await db.execute(
            "UPDATE providers SET is_default = 1 WHERE id = ?", (provider_id,)
        )


async def _reassign_default_if_orphaned(db: aiosqlite.Connection) -> None:
    """Promote first enabled provider to default if current default is disabled.

    Without this, disabling the default leaves the system with `is_default=1,
    enabled=0` and any job that doesn't pin a provider explicitly hits
    ProviderDisabledError → 422 with a confusing message.
    """
    async with await db.execute(
        "SELECT id FROM providers WHERE is_default = 1 AND enabled = 1"
    ) as cur:
        if await cur.fetchone():
            return
    async with await db.execute(
        "SELECT id FROM providers WHERE enabled = 1 ORDER BY created_at ASC LIMIT 1"
    ) as cur:
        candidate = await cur.fetchone()
    if not candidate:
        return
    await _clear_default(db)
    await db.execute(
        "UPDATE providers SET is_default = 1 WHERE id = ?", (candidate["id"],)
    )


@router.get("", response_model=list[ProviderResponse])
async def list_all_providers(
    db: aiosqlite.Connection = Depends(get_db),
) -> list[ProviderResponse]:
    rows = await list_providers(db)
    return [_to_response(r) for r in rows]


@router.post("", response_model=ProviderResponse, status_code=201)
async def create_provider(
    body: ProviderCreate,
    db: aiosqlite.Connection = Depends(get_db),
) -> ProviderResponse:
    pid = str(uuid.uuid4())
    now = _now_iso()
    if body.set_default:
        await _clear_default(db)
    await db.execute(
        "INSERT INTO providers (id, kind, name, base_url, api_key, enabled, is_default, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            pid, body.kind, body.name, body.base_url, body.api_key,
            1 if body.enabled else 0, 1 if body.set_default else 0, now,
        ),
    )
    await db.commit()
    row = await get_provider_row(db, pid)
    return _to_response(row)


@router.put("/{provider_id}", response_model=ProviderResponse)
async def update_provider(
    provider_id: str,
    body: ProviderUpdate,
    db: aiosqlite.Connection = Depends(get_db),
) -> ProviderResponse:
    try:
        row = await get_provider_row(db, provider_id)
    except ProviderNotFoundError as e:
        raise _llm_error_to_http(e)

    fields: list[str] = []
    values: list[Any] = []
    if body.name is not None:
        fields.append("name = ?")
        values.append(body.name)
    if body.base_url is not None:
        fields.append("base_url = ?")
        values.append(body.base_url)
    if body.api_key is not None:
        # Empty string is treated as "clear key" so callers can drop credentials
        # without deleting the provider row entirely.
        fields.append("api_key = ?")
        values.append(body.api_key or None)
    if body.enabled is not None:
        fields.append("enabled = ?")
        values.append(1 if body.enabled else 0)

    if fields:
        values.append(provider_id)
        await db.execute(
            f"UPDATE providers SET {', '.join(fields)} WHERE id = ?", values,
        )
    await _ensure_unique_default_after_change(
        db, set_default=bool(body.set_default), provider_id=provider_id,
    )
    await _reassign_default_if_orphaned(db)
    await db.commit()

    row = await get_provider_row(db, provider_id)
    return _to_response(row)


@router.delete("/{provider_id}", status_code=204)
async def delete_provider(
    provider_id: str,
    db: aiosqlite.Connection = Depends(get_db),
) -> None:
    try:
        row = await get_provider_row(db, provider_id)
    except ProviderNotFoundError as e:
        raise _llm_error_to_http(e)
    if row["is_default"]:
        raise HTTPException(
            status_code=409, detail="Cannot delete the default provider; set another default first.",
        )
    # Block delete while a job is running and depends on this provider — running
    # jobs hold an LLMProvider instance built from this row's settings.
    async with await db.execute(
        "SELECT id FROM jobs WHERE status IN ('running', 'pending')"
    ) as cur:
        running = await cur.fetchall()
    if running:
        # Conservative: any active job potentially uses any provider (we don't
        # parse config_json here). Force the user to wait or cancel first.
        raise HTTPException(
            status_code=409, detail="Cannot delete a provider while jobs are running. Cancel them first.",
        )
    await db.execute("DELETE FROM providers WHERE id = ?", (provider_id,))
    await db.commit()


@router.post("/{provider_id}/test", response_model=TestConnectionResponse)
async def test_provider(
    provider_id: str,
    db: aiosqlite.Connection = Depends(get_db),
) -> TestConnectionResponse:
    try:
        row = await get_provider_row(db, provider_id)
    except ProviderNotFoundError as e:
        raise _llm_error_to_http(e)
    prov = build_provider(row)
    try:
        models = await prov.list_models()
    except LLMError as e:
        return TestConnectionResponse(ok=False, error=str(e))
    return TestConnectionResponse(ok=True, models_count=len(models))


@router.get("/{provider_id}/models")
async def get_provider_models(
    provider_id: str,
    db: aiosqlite.Connection = Depends(get_db),
) -> dict[str, Any]:
    try:
        row = await get_provider_row(db, provider_id)
    except ProviderNotFoundError as e:
        raise _llm_error_to_http(e)
    prov = build_provider(row)
    try:
        models = await prov.list_models()
    except LLMError as e:
        raise _llm_error_to_http(e)
    return {
        "models": [
            {
                "id": m.id,
                "name": m.name,
                "context_length": m.context_length,
                "pricing": {"prompt": m.pricing.prompt, "completion": m.pricing.completion},
                "is_free": m.pricing.is_free,
                "provider_id": provider_id,
                "provider_kind": row["kind"],
                "raw": m.raw,
            }
            for m in models
        ],
    }


@router.post("/auto-detect", response_model=AutoDetectResponse)
async def auto_detect() -> AutoDetectResponse:
    found = await detect_local_endpoints()
    return AutoDetectResponse(
        candidates=[
            AutoDetectCandidate(label=e.label, base_url=e.base_url, models_count=e.models_count)
            for e in found
        ],
    )


# Used by the frontend's "Add provider" form to suggest a base URL preset
# without us hardcoding the same string in two places.
@router.get("/defaults/{kind}")
async def get_default_base_url(kind: ProviderKind) -> dict[str, str]:
    return {"base_url": DEFAULT_BASE_URLS[kind]}


# Resolve forward refs declared via string annotations
AutoDetectResponse.model_rebuild()
