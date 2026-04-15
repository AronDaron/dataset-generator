"""Embedding service — calls OpenRouter /v1/embeddings for semantic vectors."""

from __future__ import annotations

import asyncio
import logging

import httpx
import numpy as np

from app.services.openrouter_client import (
    MAX_RETRIES,
    OPENROUTER_BASE_URL,
    RETRY_COOLDOWN,
    RETRYABLE_CODES,
    OpenRouterError,
)

logger = logging.getLogger(__name__)

EMBEDDING_TIMEOUT = 60.0  # seconds — embeddings are fast
BATCH_SIZE = 100  # max texts per single API request


async def _embed_batch(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    model: str,
    texts: list[str],
) -> list[list[float]]:
    """Embed a single batch with retry logic."""
    payload = {"model": model, "input": texts}
    last_error: OpenRouterError | None = None

    for attempt in range(MAX_RETRIES):
        try:
            r = await client.post(
                f"{OPENROUTER_BASE_URL}/embeddings",
                headers=headers,
                json=payload,
            )
        except httpx.TimeoutException:
            last_error = OpenRouterError(408, f"Embedding request timed out after {EMBEDDING_TIMEOUT:.0f}s")
            if attempt < MAX_RETRIES - 1:
                await asyncio.sleep(RETRY_COOLDOWN)
            continue
        except httpx.NetworkError as exc:
            last_error = OpenRouterError(503, f"Network error: {exc}")
            if attempt < MAX_RETRIES - 1:
                await asyncio.sleep(RETRY_COOLDOWN)
            continue

        if r.status_code == 200:
            data = r.json()
            # OpenAI-compatible response: {"data": [{"embedding": [...], "index": 0}, ...]}
            items = sorted(data.get("data", []), key=lambda x: x.get("index", 0))
            return [item["embedding"] for item in items]

        if r.status_code in RETRYABLE_CODES:
            last_error = OpenRouterError(r.status_code, r.text)
            if attempt < MAX_RETRIES - 1:
                await asyncio.sleep(RETRY_COOLDOWN)
            continue

        raise OpenRouterError(r.status_code, r.text)

    assert last_error is not None
    raise last_error


async def get_embeddings(
    api_key: str,
    model: str,
    texts: list[str],
) -> np.ndarray:
    """Get embeddings for a list of texts. Returns numpy array of shape (n, dim).

    Automatically batches requests if len(texts) > BATCH_SIZE.
    """
    if not texts:
        return np.empty((0, 0))

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost",
        "X-Title": "DatasetGenerator",
    }

    all_embeddings: list[list[float]] = []
    async with httpx.AsyncClient(timeout=EMBEDDING_TIMEOUT) as client:
        for i in range(0, len(texts), BATCH_SIZE):
            batch = texts[i : i + BATCH_SIZE]
            embeddings = await _embed_batch(client, headers, model, batch)
            all_embeddings.extend(embeddings)

    return np.array(all_embeddings, dtype=np.float32)
