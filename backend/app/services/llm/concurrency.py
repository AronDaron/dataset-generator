"""Shared per-provider concurrency gate.

Self-hosted backends (Ollama, LM Studio) advertise ``supports_parallel=False``
because parallel chat calls to the same endpoint contend for one GPU and
routinely OOM a 14B+ model. Every pipeline stage that fans out provider calls
has to honour that flag, and each of them doing it with its own private lock
dict would defeat the purpose: three stages × one lock each = three concurrent
calls hitting the same GPU.

``provider_gate`` is therefore the single place in the process that owns those
locks — keyed by ``provider_id``, so a user running two distinct local backends
still gets inter-provider parallelism. For providers that do support parallel
calls (OpenRouter and friends) the gate is a no-op and costs nothing.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator

from app.services.llm.base import LLMProvider

# provider_id → lock. Process-wide on purpose: it mirrors the physical
# constraint (one endpoint, one GPU), which is shared by every stage.
_provider_locks: dict[str, asyncio.Lock] = {}


@asynccontextmanager
async def provider_gate(provider: LLMProvider) -> AsyncIterator[None]:
    """Serialize calls to a provider that cannot serve them in parallel.

    No-op for ``supports_parallel`` providers (and for providers without an
    id, which have no stable lock key); otherwise the body runs while holding
    that provider's lock.

    Usage::

        async with provider_gate(provider):
            response = await provider.chat(...)
    """
    if provider.capabilities.supports_parallel or not provider.provider_id:
        yield
        return

    lock = _provider_locks.setdefault(provider.provider_id, asyncio.Lock())
    async with lock:
        yield
