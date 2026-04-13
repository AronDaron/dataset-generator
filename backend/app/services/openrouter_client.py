import asyncio
import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
MAX_RETRIES = 3
RETRY_COOLDOWN = 15  # seconds
RETRYABLE_CODES = {429, 500}
REQUEST_TIMEOUT = 480.0  # seconds — DeepSeek V3.2 at 11 tps × 4096 tokens ≈ 370s; 480s gives safe margin


class OpenRouterError(Exception):
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        super().__init__(f"OpenRouter {status_code}: {message}")


async def chat_completion(
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    temperature: float = 0.7,
    max_tokens: int = 2048,
    max_retries: int = MAX_RETRIES,
    retry_cooldown: int = RETRY_COOLDOWN,
    provider: str | None = None,
) -> dict[str, Any]:
    """Send a chat completion request to OpenRouter with retry logic.

    Retries up to max_retries times on 429/500 with retry_cooldown seconds between attempts.
    Pass values from DB config (GlobalConfig) to honour user settings.
    Raises OpenRouterError on final failure or non-retryable error.
    """
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost",
        "X-Title": "DatasetGenerator",
    }
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if provider:
        payload["provider"] = {"order": [provider], "allow_fallbacks": False}
        logger.debug("Provider routing: model=%s provider=%s", model, provider)
    last_error: OpenRouterError | None = None
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        for attempt in range(max_retries):
            try:
                r = await client.post(
                    f"{OPENROUTER_BASE_URL}/chat/completions",
                    headers=headers,
                    json=payload,
                )
            except httpx.TimeoutException:
                logger.warning(
                    "OpenRouter request timed out after %.0fs (attempt %d/%d, model=%s)",
                    REQUEST_TIMEOUT, attempt + 1, max_retries, model,
                )
                last_error = OpenRouterError(408, f"Request timed out after {REQUEST_TIMEOUT:.0f}s")
                if attempt < max_retries - 1:
                    await asyncio.sleep(retry_cooldown)
                continue
            except httpx.NetworkError as exc:
                logger.warning(
                    "OpenRouter network error (attempt %d/%d, model=%s): %s",
                    attempt + 1, max_retries, model, exc,
                )
                last_error = OpenRouterError(503, f"Network error: {exc}")
                if attempt < max_retries - 1:
                    await asyncio.sleep(retry_cooldown)
                continue

            if r.status_code == 200:
                return r.json()
            if r.status_code in RETRYABLE_CODES:
                last_error = OpenRouterError(r.status_code, r.text)
                if attempt < max_retries - 1:
                    await asyncio.sleep(retry_cooldown)
                continue
            # Non-retryable error (401, 403, 422, etc.) — raise immediately
            logger.error(
                "OpenRouter non-retryable error %d (model=%s): %s",
                r.status_code, model, r.text[:200],
            )
            raise OpenRouterError(r.status_code, r.text)
    assert last_error is not None
    raise last_error


async def list_models(api_key: str) -> list[dict[str, Any]]:
    """Fetch available models from OpenRouter."""
    headers = {
        "Authorization": f"Bearer {api_key}",
        "HTTP-Referer": "http://localhost",
        "X-Title": "DatasetGenerator",
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(f"{OPENROUTER_BASE_URL}/models", headers=headers)
        r.raise_for_status()
        return r.json().get("data", [])
