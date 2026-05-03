"""Local LLM auto-detection — probes well-known ports for OpenAI-compatible endpoints.

Used by `POST /api/providers/auto-detect`. Pure function (no DB, no side
effects) so the router can decide whether to surface results to the user or
auto-add them. Probe targets the OpenAI-compatible `/v1/models` route — Ollama
exposes it since 0.1.31, LM Studio always has it.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Final

import httpx

PROBE_TIMEOUT: Final = 1.5  # seconds — local endpoints answer in <100 ms; 1.5s is generous


@dataclass(frozen=True)
class DetectedEndpoint:
    label: str            # "Ollama" | "LM Studio" | …
    base_url: str         # always with `/v1` suffix so it can be saved as-is
    models_count: int     # 0 if probe succeeded but model list was empty


# (label, base_url-with-/v1) tuples. Order matters — first match wins per port.
DEFAULT_PROBES: Final = [
    ("Ollama", "http://127.0.0.1:11434/v1"),
    ("LM Studio", "http://127.0.0.1:1234/v1"),
    ("llama.cpp", "http://127.0.0.1:8080/v1"),
]


async def _probe(label: str, base_url: str) -> DetectedEndpoint | None:
    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT) as client:
            r = await client.get(f"{base_url}/models")
    except httpx.HTTPError:
        return None
    if r.status_code != 200:
        return None
    try:
        data = r.json().get("data") or []
    except ValueError:
        return None
    return DetectedEndpoint(label=label, base_url=base_url, models_count=len(data))


async def detect_local_endpoints(
    probes: list[tuple[str, str]] | None = None,
) -> list[DetectedEndpoint]:
    """Probe DEFAULT_PROBES (or supplied list) in parallel; return reachable ones."""
    targets = probes if probes is not None else DEFAULT_PROBES
    results = await asyncio.gather(
        *(_probe(label, url) for label, url in targets),
        return_exceptions=False,
    )
    return [r for r in results if r is not None]
