import asyncio
from typing import Any

import httpx

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
MAX_RETRIES = 3
RETRY_COOLDOWN = 15  # seconds
RETRYABLE_CODES = {429, 500}


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
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    last_error: OpenRouterError | None = None
    async with httpx.AsyncClient(timeout=60.0) as client:
        for attempt in range(max_retries):
            r = await client.post(
                f"{OPENROUTER_BASE_URL}/chat/completions",
                headers=headers,
                json=payload,
            )
            if r.status_code == 200:
                return r.json()
            if r.status_code in RETRYABLE_CODES:
                last_error = OpenRouterError(r.status_code, r.text)
                if attempt < max_retries - 1:
                    await asyncio.sleep(retry_cooldown)
                continue
            # Non-retryable error (401, 403, 422, etc.) — raise immediately
            raise OpenRouterError(r.status_code, r.text)
    raise last_error  # type: ignore[misc]


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
