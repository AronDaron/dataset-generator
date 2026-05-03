"""LLM provider abstraction layer.

Wraps cloud (OpenRouter) and local (Ollama, LM Studio, llama.cpp, custom
OpenAI-compatible) backends behind a uniform `LLMProvider` interface. Use
`get_provider(provider_id, db)` from `registry` to obtain a configured
instance. Job runner and embedding service depend only on this package.
"""

from app.services.llm.base import (
    ChatResult,
    LLMError,
    LLMProvider,
    ModelInfo,
    Pricing,
    ProviderCapabilities,
)

__all__ = [
    "ChatResult",
    "LLMError",
    "LLMProvider",
    "ModelInfo",
    "Pricing",
    "ProviderCapabilities",
]
