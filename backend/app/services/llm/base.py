"""LLM provider interface — common shapes for cloud and local backends.

All concrete providers (OpenRouter, OpenAI-compatible/Ollama/LM Studio) implement
`LLMProvider`. `chat()` returns the raw OpenAI-style response dict so existing
job_runner helpers (`_extract_content`, `_extract_usage`) work unchanged.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import numpy as np


# Canonical chat response shape — mirrors OpenAI/OpenRouter so downstream
# parsing helpers in job_runner don't need provider-specific branches.
ChatResult = dict[str, Any]


@dataclass(frozen=True)
class Pricing:
    """Per-token pricing in USD. Local providers report all-zero."""

    prompt: float = 0.0
    completion: float = 0.0

    @property
    def is_free(self) -> bool:
        return self.prompt == 0.0 and self.completion == 0.0


@dataclass(frozen=True)
class ModelInfo:
    """Normalised model metadata across providers."""

    id: str                               # provider-native model identifier
    name: str                             # user-facing label
    context_length: int | None = None
    pricing: Pricing = field(default_factory=Pricing)
    raw: dict[str, Any] = field(default_factory=dict)  # original provider payload


@dataclass(frozen=True)
class ProviderCapabilities:
    """Feature flags that drive conditional code paths in job_runner.

    The job runner branches on capabilities (e.g. reasoning multiplier, provider
    routing) rather than on provider kind strings — adding a new provider only
    requires choosing the right capability values.
    """

    supports_provider_routing: bool   # OpenRouter-style {"provider": {...}} pole
    supports_reasoning: bool          # max_tokens × 2 multiplier applied only when True
    requires_api_key: bool
    has_pricing: bool                 # cost tracking applicable
    supports_embeddings: bool


class LLMError(Exception):
    """Provider-agnostic error with HTTP-like status_code semantics.

    Status codes follow HTTP conventions so existing _openrouter_error_to_http
    mapping (401→401, 429→429, 5xx→502) works uniformly across providers.
    Codes used internally:
      408 — request timed out
      503 — network error / endpoint unreachable
    """

    def __init__(
        self,
        status_code: int,
        message: str,
        *,
        provider_id: str | None = None,
        provider_kind: str | None = None,
    ) -> None:
        self.status_code = status_code
        self.provider_id = provider_id
        self.provider_kind = provider_kind
        super().__init__(f"LLM[{provider_kind or '?'}] {status_code}: {message}")


class LLMProvider(ABC):
    """Abstract base for chat + embedding backends.

    Subclasses MUST set `kind` and `capabilities` as class attributes. Instances
    are short-lived (one per request chain in a job) — provider state lives
    in registry-managed singletons.
    """

    kind: str
    capabilities: ProviderCapabilities

    def __init__(self, *, provider_id: str | None = None) -> None:
        self.provider_id = provider_id

    @abstractmethod
    async def chat(
        self,
        model: str,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        max_retries: int = 3,
        retry_cooldown: int = 15,
        provider_route: str | None = None,
    ) -> ChatResult:
        """Send a chat completion request. Returns OpenAI-shaped response dict.

        `provider_route` is only honoured when `capabilities.supports_provider_routing`
        is True (OpenRouter "DeepSeek" etc.); silently ignored otherwise.
        """

    @abstractmethod
    async def list_models(self) -> list[ModelInfo]:
        """Fetch available models from the provider."""

    @abstractmethod
    async def embed(self, model: str, texts: list[str]) -> np.ndarray:
        """Return (n, dim) float32 embeddings for `texts`. Raises if
        `capabilities.supports_embeddings` is False."""

    @abstractmethod
    async def health_check(self) -> bool:
        """Lightweight reachability probe. False on any error."""
