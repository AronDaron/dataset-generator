"""Backwards-compatible facade over `app.services.llm.openrouter`.

Existing call sites and tests import `chat_completion`, `list_models`, and
`OpenRouterError` from this module. Internally everything now delegates to
`OpenRouterProvider` so the legacy code path and the new provider abstraction
share a single implementation. New code should import from `app.services.llm`.
"""

from __future__ import annotations

from typing import Any

from app.services.llm.base import LLMError
from app.services.llm.openrouter import (
    MAX_RETRIES,
    OPENROUTER_BASE_URL,
    REQUEST_TIMEOUT,
    RETRY_COOLDOWN,
    RETRYABLE_CODES,
    OpenRouterProvider,
)

__all__ = [
    "MAX_RETRIES",
    "OPENROUTER_BASE_URL",
    "REQUEST_TIMEOUT",
    "RETRY_COOLDOWN",
    "RETRYABLE_CODES",
    "OpenRouterError",
    "chat_completion",
    "list_models",
]


class OpenRouterError(LLMError):
    """Legacy alias kept for tests and call sites that catch this name.

    Subclass of LLMError so `except LLMError` and `except OpenRouterError` both
    catch it. Constructor signature matches the original positional form.
    """

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(status_code, message, provider_kind="openrouter")


def _adapt_llm_error(exc: LLMError) -> OpenRouterError:
    """Re-raise an LLMError as the legacy OpenRouterError so call sites that
    `except OpenRouterError` keep working."""
    return OpenRouterError(exc.status_code, str(exc).split(": ", 1)[-1])


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
    """Send a chat completion via the default OpenRouter provider."""
    prov = OpenRouterProvider(api_key)
    try:
        return await prov.chat(
            model,
            messages,
            temperature=temperature,
            max_tokens=max_tokens,
            max_retries=max_retries,
            retry_cooldown=retry_cooldown,
            provider_route=provider,
        )
    except LLMError as exc:
        raise _adapt_llm_error(exc) from exc


async def list_models(api_key: str) -> list[dict[str, Any]]:
    """Fetch model list (raw payload list) from OpenRouter."""
    prov = OpenRouterProvider(api_key)
    try:
        models = await prov.list_models()
    except LLMError as exc:
        raise _adapt_llm_error(exc) from exc
    return [m.raw for m in models]
