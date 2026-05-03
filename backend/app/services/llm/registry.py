"""Provider registry — DB-backed lookup that returns ready-to-use LLMProvider.

`get_provider` is the single entry point for the job runner / embedding service:
fetch the row, build the right concrete subclass, hand it back. The function
also resolves "default" semantics — if no provider_id is given, pick the row
flagged is_default=1 (first enabled provider as a last-resort fallback).
"""

from __future__ import annotations

from typing import Any

import aiosqlite

from app.services.llm.base import LLMError, LLMProvider
from app.services.llm.openai_compat import OpenAICompatProvider
from app.services.llm.openrouter import OpenRouterProvider


class ProviderNotFoundError(LLMError):
    """Raised when a provider_id doesn't resolve to any DB row."""

    def __init__(self, message: str) -> None:
        super().__init__(404, message, provider_kind=None)


class ProviderDisabledError(LLMError):
    """Raised when the resolved provider has enabled=0."""

    def __init__(self, provider_id: str) -> None:
        super().__init__(409, f"Provider {provider_id!r} is disabled", provider_id=provider_id)


def _row_to_dict(row: aiosqlite.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "name": row["name"],
        "base_url": row["base_url"],
        "api_key": row["api_key"],
        "enabled": bool(row["enabled"]),
        "is_default": bool(row["is_default"]),
        "created_at": row["created_at"],
    }


async def list_providers(db: aiosqlite.Connection) -> list[dict[str, Any]]:
    async with await db.execute(
        "SELECT id, kind, name, base_url, api_key, enabled, is_default, created_at "
        "FROM providers ORDER BY is_default DESC, created_at ASC"
    ) as cur:
        rows = await cur.fetchall()
    return [_row_to_dict(r) for r in rows]


async def get_provider_row(
    db: aiosqlite.Connection,
    provider_id: str | None,
) -> dict[str, Any]:
    """Return the raw row for a provider id, or the default if id is None.

    Falls back to the first enabled provider when no row is flagged as default
    (covers the post-migration state where the placeholder default has no key).
    """
    if provider_id:
        async with await db.execute(
            "SELECT id, kind, name, base_url, api_key, enabled, is_default, created_at "
            "FROM providers WHERE id = ?",
            (provider_id,),
        ) as cur:
            row = await cur.fetchone()
        if not row:
            raise ProviderNotFoundError(f"Provider {provider_id!r} not found")
        return _row_to_dict(row)

    # Resolve default
    async with await db.execute(
        "SELECT id, kind, name, base_url, api_key, enabled, is_default, created_at "
        "FROM providers WHERE is_default = 1 LIMIT 1"
    ) as cur:
        row = await cur.fetchone()
    if row:
        return _row_to_dict(row)

    async with await db.execute(
        "SELECT id, kind, name, base_url, api_key, enabled, is_default, created_at "
        "FROM providers WHERE enabled = 1 ORDER BY created_at ASC LIMIT 1"
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise ProviderNotFoundError("No providers configured")
    return _row_to_dict(row)


def build_provider(row: dict[str, Any]) -> LLMProvider:
    kind = row["kind"]
    pid = row["id"]
    if kind == "openrouter":
        return OpenRouterProvider(
            api_key=row["api_key"] or "",
            provider_id=pid,
            base_url=row["base_url"],
        )
    if kind == "openai_compat":
        return OpenAICompatProvider(
            base_url=row["base_url"],
            api_key=row["api_key"],
            provider_id=pid,
        )
    raise ProviderNotFoundError(f"Unknown provider kind: {kind!r}")


async def get_provider(
    db: aiosqlite.Connection,
    provider_id: str | None = None,
    *,
    require_enabled: bool = True,
) -> LLMProvider:
    """Resolve a provider id (or the default) to a ready-to-use LLMProvider.

    Raises ProviderNotFoundError on missing id and ProviderDisabledError when
    `require_enabled` is True and the row has enabled=0.
    """
    row = await get_provider_row(db, provider_id)
    if require_enabled and not row["enabled"]:
        raise ProviderDisabledError(row["id"])
    return build_provider(row)
