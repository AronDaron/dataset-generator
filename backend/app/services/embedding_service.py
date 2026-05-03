"""Embedding service — delegates to the configured LLMProvider.

Per `dedup_service` workflow: pick the provider stored in
`settings.embedding_provider_id` (or fall back to the default OpenRouter
provider for jobs that pre-date local embeddings), then call its `embed()`.
This keeps Ollama (`nomic-embed-text`, `mxbai-embed-large`) and OpenRouter
(`openai/text-embedding-3-small`) behind the same call site.
"""

from __future__ import annotations

import logging

import aiosqlite
import numpy as np

from app.services.llm.base import LLMProvider

logger = logging.getLogger(__name__)


async def get_embeddings(
    provider: LLMProvider,
    model: str,
    texts: list[str],
) -> np.ndarray:
    """Return (n, dim) float32 embeddings via the supplied provider."""
    if not texts:
        return np.empty((0, 0), dtype=np.float32)
    return await provider.embed(model, texts)


async def resolve_embedding_provider_id(db: aiosqlite.Connection) -> str | None:
    """Read the `embedding_provider_id` setting; None falls through to default."""
    async with await db.execute(
        "SELECT value FROM settings WHERE key = 'embedding_provider_id'"
    ) as cur:
        row = await cur.fetchone()
    return (row["value"] if row and row["value"] else None)
