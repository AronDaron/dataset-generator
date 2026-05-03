"""OpenRouterProvider — concrete LLMProvider for openrouter.ai.

Behavioural parity with the legacy openrouter_client.py: same retry policy,
same headers, same payload shape. Embedding endpoint is openrouter.ai/api/v1/embeddings.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Final

import httpx
import numpy as np

from app.services.llm.base import (
    ChatResult,
    LLMError,
    LLMProvider,
    ModelInfo,
    Pricing,
    ProviderCapabilities,
)

logger = logging.getLogger(__name__)

OPENROUTER_BASE_URL: Final = "https://openrouter.ai/api/v1"
MAX_RETRIES: Final = 3
RETRY_COOLDOWN: Final = 15  # seconds
RETRYABLE_CODES: Final = {429, 500, 503}
REQUEST_TIMEOUT: Final = 480.0  # DeepSeek V3.2 at 11 tps × 4096 tokens ≈ 370s; 480s gives safe margin
EMBEDDING_TIMEOUT: Final = 60.0
EMBEDDING_BATCH_SIZE: Final = 100

OPENROUTER_CAPABILITIES: Final = ProviderCapabilities(
    supports_provider_routing=True,
    supports_reasoning=True,
    requires_api_key=True,
    has_pricing=True,
    supports_embeddings=True,
)


def _headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost",
        "X-Title": "DatasetGenerator",
    }


def _to_pricing(raw: dict[str, Any]) -> Pricing:
    pr = raw.get("pricing") or {}
    try:
        return Pricing(prompt=float(pr.get("prompt") or 0.0), completion=float(pr.get("completion") or 0.0))
    except (TypeError, ValueError):
        return Pricing()


class OpenRouterProvider(LLMProvider):
    kind = "openrouter"
    capabilities = OPENROUTER_CAPABILITIES

    def __init__(
        self,
        api_key: str,
        *,
        provider_id: str | None = None,
        base_url: str = OPENROUTER_BASE_URL,
    ) -> None:
        super().__init__(provider_id=provider_id)
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")

    async def chat(
        self,
        model: str,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        max_retries: int = MAX_RETRIES,
        retry_cooldown: int = RETRY_COOLDOWN,
        provider_route: str | None = None,
    ) -> ChatResult:
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if provider_route:
            payload["provider"] = {"order": [provider_route], "allow_fallbacks": False}
            logger.debug("Provider routing: model=%s provider=%s", model, provider_route)

        last_error: LLMError | None = None
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            for attempt in range(max_retries):
                try:
                    r = await client.post(
                        f"{self.base_url}/chat/completions",
                        headers=_headers(self.api_key),
                        json=payload,
                    )
                except httpx.TimeoutException:
                    logger.warning(
                        "OpenRouter request timed out after %.0fs (attempt %d/%d, model=%s)",
                        REQUEST_TIMEOUT, attempt + 1, max_retries, model,
                    )
                    last_error = self._error(408, f"Request timed out after {REQUEST_TIMEOUT:.0f}s")
                    if attempt < max_retries - 1:
                        await asyncio.sleep(retry_cooldown)
                    continue
                except httpx.NetworkError as exc:
                    logger.warning(
                        "OpenRouter network error (attempt %d/%d, model=%s): %s",
                        attempt + 1, max_retries, model, exc,
                    )
                    last_error = self._error(503, f"Network error: {exc}")
                    if attempt < max_retries - 1:
                        await asyncio.sleep(retry_cooldown)
                    continue

                if r.status_code == 200:
                    return r.json()
                if r.status_code in RETRYABLE_CODES:
                    last_error = self._error(r.status_code, r.text)
                    if attempt < max_retries - 1:
                        await asyncio.sleep(retry_cooldown)
                    continue
                logger.error(
                    "OpenRouter non-retryable error %d (model=%s): %s",
                    r.status_code, model, r.text[:200],
                )
                raise self._error(r.status_code, r.text)
        assert last_error is not None
        raise last_error

    async def list_models(self) -> list[ModelInfo]:
        last_error: LLMError | None = None
        async with httpx.AsyncClient(timeout=30.0) as client:
            for attempt in range(MAX_RETRIES):
                try:
                    r = await client.get(f"{self.base_url}/models", headers=_headers(self.api_key))
                except httpx.TimeoutException:
                    last_error = self._error(408, "Model list request timed out")
                    if attempt < MAX_RETRIES - 1:
                        await asyncio.sleep(RETRY_COOLDOWN)
                    continue
                except httpx.NetworkError as exc:
                    last_error = self._error(503, f"Network error: {exc}")
                    if attempt < MAX_RETRIES - 1:
                        await asyncio.sleep(RETRY_COOLDOWN)
                    continue
                if r.status_code == 200:
                    return [self._to_model_info(m) for m in r.json().get("data", [])]
                if r.status_code in RETRYABLE_CODES:
                    last_error = self._error(r.status_code, r.text)
                    if attempt < MAX_RETRIES - 1:
                        await asyncio.sleep(RETRY_COOLDOWN)
                    continue
                raise self._error(r.status_code, r.text)
        assert last_error is not None
        raise last_error

    async def embed(self, model: str, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.empty((0, 0), dtype=np.float32)
        all_embeddings: list[list[float]] = []
        async with httpx.AsyncClient(timeout=EMBEDDING_TIMEOUT) as client:
            for i in range(0, len(texts), EMBEDDING_BATCH_SIZE):
                batch = texts[i : i + EMBEDDING_BATCH_SIZE]
                all_embeddings.extend(await self._embed_batch(client, model, batch))
        return np.array(all_embeddings, dtype=np.float32)

    async def _embed_batch(
        self,
        client: httpx.AsyncClient,
        model: str,
        texts: list[str],
    ) -> list[list[float]]:
        payload = {"model": model, "input": texts}
        last_error: LLMError | None = None
        for attempt in range(MAX_RETRIES):
            try:
                r = await client.post(
                    f"{self.base_url}/embeddings",
                    headers=_headers(self.api_key),
                    json=payload,
                )
            except httpx.TimeoutException:
                last_error = self._error(408, f"Embedding request timed out after {EMBEDDING_TIMEOUT:.0f}s")
                if attempt < MAX_RETRIES - 1:
                    await asyncio.sleep(RETRY_COOLDOWN)
                continue
            except httpx.NetworkError as exc:
                last_error = self._error(503, f"Network error: {exc}")
                if attempt < MAX_RETRIES - 1:
                    await asyncio.sleep(RETRY_COOLDOWN)
                continue

            if r.status_code == 200:
                data = r.json()
                items = sorted(data.get("data", []), key=lambda x: x.get("index", 0))
                return [item["embedding"] for item in items]

            if r.status_code in RETRYABLE_CODES:
                last_error = self._error(r.status_code, r.text)
                if attempt < MAX_RETRIES - 1:
                    await asyncio.sleep(RETRY_COOLDOWN)
                continue

            raise self._error(r.status_code, r.text)

        assert last_error is not None
        raise last_error

    async def health_check(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(f"{self.base_url}/models", headers=_headers(self.api_key))
            return r.status_code == 200
        except httpx.HTTPError:
            return False

    def _error(self, status_code: int, message: str) -> LLMError:
        return LLMError(
            status_code,
            message,
            provider_id=self.provider_id,
            provider_kind=self.kind,
        )

    @staticmethod
    def _to_model_info(raw: dict[str, Any]) -> ModelInfo:
        ctx = raw.get("context_length") or raw.get("top_provider", {}).get("context_length")
        return ModelInfo(
            id=str(raw.get("id") or ""),
            name=str(raw.get("name") or raw.get("id") or ""),
            context_length=int(ctx) if ctx else None,
            pricing=_to_pricing(raw),
            raw=raw,
        )
