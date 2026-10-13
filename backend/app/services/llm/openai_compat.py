"""OpenAICompatProvider — generic adapter for any OpenAI-compatible endpoint.

Works against Ollama (`/v1/*` aliases since 0.1.31), LM Studio, llama.cpp
server, vLLM, text-generation-inference, and self-hosted gateways. Pricing is
always zero (these are user-hosted), provider routing is not supported, and
reasoning multipliers are skipped — local models don't surface reasoning_tokens
in their usage payload.

Auth model: api_key may be empty (Ollama default) or set (LM Studio "lm-studio",
custom gateway tokens). Sent as `Authorization: Bearer …` only when present so
endpoints that reject any auth header still work.
"""

from __future__ import annotations

import asyncio
import logging
import re
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
    message_reasoning,
)
from app.services.token_counter import count_tokens

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT: Final = 480.0
EMBEDDING_TIMEOUT: Final = 60.0
EMBEDDING_BATCH_SIZE: Final = 100
HEALTH_TIMEOUT: Final = 5.0
STATUS_TIMEOUT: Final = 5.0
RETRYABLE_CODES: Final = {429, 500, 502, 503, 504}

# Reasoning-effort support is discovered per endpoint, not assumed per model:
# Unsloth Studio publishes `reasoning_effort_levels` on /v1/status, plain Ollama
# and llama.cpp have no such endpoint. Cached by base_url because the answer is
# a property of the server build, and providers are constructed per request.
# Value is the advertised level list; [] means "endpoint said nothing — send no
# reasoning_effort", which keeps unknown backends byte-identical to before.
_EFFORT_LEVELS_CACHE: dict[str, list[str]] = {}

OPENAI_COMPAT_CAPABILITIES: Final = ProviderCapabilities(
    supports_provider_routing=False,
    # Treat as reasoning-capable so the API multiplier is ×2 — same behaviour
    # as OpenRouter. Non-reasoning local models don't pay for the larger
    # ceiling (max_tokens is upper bound, not target), and reasoning models
    # finally have room for <think> blocks. Whether the response actually
    # used reasoning is detected downstream by counting tokens in the
    # post-strip content rather than trusting `usage.reasoning_tokens` (which
    # Ollama doesn't emit).
    supports_reasoning=True,
    requires_api_key=False,
    has_pricing=False,
    supports_embeddings=True,
    # Local backends that serve several requests at once (llama.cpp-style
    # `parallel_slots`, Unsloth Studio) handle the fan-out fine: measured on a
    # 3700-example dataset the heaviest single cleanup call is ~9.8k tokens
    # against a 65k per-slot budget, i.e. 15%. The old default serialized every
    # gated stage behind one lock, which is only right for a small single-GPU
    # box with no slot splitting — that case belongs in a per-provider setting,
    # not in a class constant. TODO: expose as a provider field in Settings.
    supports_parallel=True,
)


class OpenAICompatProvider(LLMProvider):
    kind = "openai_compat"
    capabilities = OPENAI_COMPAT_CAPABILITIES

    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        *,
        provider_id: str | None = None,
    ) -> None:
        super().__init__(provider_id=provider_id)
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or None  # normalise empty string → None

    def _headers(self) -> dict[str, str]:
        h = {
            "Content-Type": "application/json",
            "X-Title": "DatasetGenerator",
        }
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    async def chat(
        self,
        model: str,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.7,
        max_tokens: int | None = 2048,
        max_retries: int = 3,
        retry_cooldown: int = 15,
        provider_route: str | None = None,
        reasoning_effort: str | None = None,
        disable_thinking: bool = False,
    ) -> ChatResult:
        # provider_route silently ignored — routing is OpenRouter-specific.
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
        }
        if max_tokens is not None:
            # None = no ceiling: the field is omitted and the backend generates
            # until EOS. Used by passes whose output size the prompt already
            # bounds (reasoning), where a thinking model's thought channel
            # would otherwise eat any cap we could pick.
            payload["max_tokens"] = max_tokens
        if disable_thinking:
            # Two spellings because backends disagree: `chat_template_kwargs` is
            # the vLLM/Qwen convention, the top-level flag is what several
            # llama.cpp-based servers read. Both verified against Unsloth Studio;
            # a backend that knows neither ignores unknown JSON fields.
            payload["chat_template_kwargs"] = {"enable_thinking": False}
            payload["enable_thinking"] = False
        if reasoning_effort:
            # Only forward a level the endpoint itself advertises for THIS model.
            # Sending an unknown field to a backend that validates its request
            # body would turn a working setup into a hard 400.
            levels = await self.supported_reasoning_efforts(model)
            if reasoning_effort in levels:
                payload["reasoning_effort"] = reasoning_effort
            else:
                logger.debug(
                    "[%s] reasoning_effort=%s not advertised (levels=%s) — omitted",
                    self.base_url, reasoning_effort, levels or "none",
                )
        last_error: LLMError | None = None
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            for attempt in range(max_retries):
                try:
                    r = await client.post(
                        f"{self.base_url}/chat/completions",
                        headers=self._headers(),
                        json=payload,
                    )
                except httpx.TimeoutException:
                    logger.warning(
                        "[%s] chat timed out (attempt %d/%d, model=%s)",
                        self.base_url, attempt + 1, max_retries, model,
                    )
                    last_error = self._error(408, f"Request timed out after {REQUEST_TIMEOUT:.0f}s")
                    if attempt < max_retries - 1:
                        await asyncio.sleep(retry_cooldown)
                    continue
                except httpx.NetworkError as exc:
                    logger.warning(
                        "[%s] chat network error (attempt %d/%d, model=%s): %s",
                        self.base_url, attempt + 1, max_retries, model, exc,
                    )
                    last_error = self._error(503, f"Network error: {exc}")
                    if attempt < max_retries - 1:
                        await asyncio.sleep(retry_cooldown)
                    continue

                if r.status_code == 200:
                    return _normalise_chat_response(r.json())
                if r.status_code in RETRYABLE_CODES:
                    last_error = self._error(r.status_code, r.text)
                    if attempt < max_retries - 1:
                        await asyncio.sleep(retry_cooldown)
                    continue
                logger.error(
                    "[%s] non-retryable %d (model=%s): %s",
                    self.base_url, r.status_code, model, r.text[:200],
                )
                raise self._error(r.status_code, r.text)
        assert last_error is not None
        raise last_error

    async def list_models(self) -> list[ModelInfo]:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.get(f"{self.base_url}/models", headers=self._headers())
        except httpx.TimeoutException:
            raise self._error(408, "Model list request timed out")
        except httpx.NetworkError as exc:
            raise self._error(503, f"Network error: {exc}")
        if r.status_code != 200:
            raise self._error(r.status_code, r.text)
        return [_to_model_info(m) for m in r.json().get("data", [])]

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
        # Some local servers (older Ollama) return one embedding per call rather
        # than handling batched `input`. Try batched first; if the shape comes
        # back malformed, retry per-text. Always honour OpenAI-shaped response.
        payload = {"model": model, "input": texts}
        try:
            r = await client.post(
                f"{self.base_url}/embeddings", headers=self._headers(), json=payload,
            )
        except httpx.TimeoutException:
            raise self._error(408, f"Embedding request timed out after {EMBEDDING_TIMEOUT:.0f}s")
        except httpx.NetworkError as exc:
            raise self._error(503, f"Network error: {exc}")

        if r.status_code != 200:
            raise self._error(r.status_code, r.text)

        data = r.json()
        items = sorted(data.get("data") or [], key=lambda x: x.get("index", 0))
        if len(items) == len(texts):
            return [item["embedding"] for item in items]

        # Fallback: per-text loop for endpoints that ignored the batched input.
        embeddings: list[list[float]] = []
        for txt in texts:
            r2 = await client.post(
                f"{self.base_url}/embeddings",
                headers=self._headers(),
                json={"model": model, "input": txt},
            )
            if r2.status_code != 200:
                raise self._error(r2.status_code, r2.text)
            d = r2.json()
            single = (d.get("data") or [{}])[0].get("embedding")
            if not single:
                raise self._error(502, "Embedding response missing 'data[0].embedding'")
            embeddings.append(single)
        return embeddings

    async def supported_reasoning_efforts(self, model: str | None = None) -> list[str]:
        """Ask the endpoint which reasoning-effort levels it accepts for `model`.

        Unsloth Studio answers /v1/status with `supports_reasoning` plus
        `reasoning_effort_levels`. Ollama and llama.cpp have no such route, so
        the 404 (or connection error) resolves to [] and nothing changes for
        them. Cached per (endpoint, model) — one probe per model per process,
        not one per generated example.

        The reply describes the *currently loaded* model, and Unsloth holds one
        at a time. So an answer collected while a different model was resident
        says nothing about this one: swapping a reasoning model for a plain one
        would otherwise keep sending it a reasoning_effort it never advertised.
        """
        cache_key = (self.base_url, model or "")
        cached = _EFFORT_LEVELS_CACHE.get(cache_key)
        if cached is not None:
            return cached

        levels: list[str] = []
        endpoint_answered = False
        describes_this_model = True
        try:
            async with httpx.AsyncClient(timeout=STATUS_TIMEOUT) as client:
                r = await client.get(f"{self.base_url}/status", headers=self._headers())
            if r.status_code == 200:
                endpoint_answered = True
                data = r.json() if isinstance(r.json(), dict) else {}
                active = data.get("active_model")
                if model and active and str(active) != model:
                    # Answer is about some other model — don't trust it, don't
                    # store it. The model we want loads on the first chat call,
                    # and the next probe describes it correctly.
                    describes_this_model = False
                    logger.debug(
                        "[%s] /status describes %s, not %s — skipping effort probe",
                        self.base_url, active, model,
                    )
                elif data.get("supports_reasoning"):
                    levels = [
                        str(lvl) for lvl in (data.get("reasoning_effort_levels") or [])
                    ]
        except (httpx.HTTPError, ValueError):
            pass  # no capability endpoint — treat as unsupported

        # Cache a "no" only when the endpoint is genuinely absent. Unsloth
        # reports no reasoning support while no model is loaded (it idle-unloads,
        # and the model loads on the first chat call), so caching that answer
        # would disable effort control for an entire run that started cold.
        if describes_this_model and (levels or not endpoint_answered):
            _EFFORT_LEVELS_CACHE[cache_key] = levels
        if levels:
            logger.info(
                "[%s] model %s advertises reasoning_effort levels: %s",
                self.base_url, model or "?", levels,
            )
        return levels

    async def health_check(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=HEALTH_TIMEOUT) as client:
                r = await client.get(f"{self.base_url}/models", headers=self._headers())
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


_THINK_RE = re.compile(r"<think>[\s\S]*?</think>", re.IGNORECASE)


def _normalise_chat_response(raw: dict[str, Any]) -> ChatResult:
    """Ensure response carries the keys job_runner expects.

    OpenAI-compatible servers vary: Ollama populates `usage` only on newer
    builds, llama.cpp omits it entirely, LM Studio nests fields slightly
    differently. We don't synthesise missing data — just guarantee a `usage`
    dict so `_extract_usage` returns zeros instead of crashing.

    Local reasoning fix: when the model emitted `<think>...</think>` blocks,
    `usage.completion_tokens` reports the full think+content figure (Ollama
    doesn't break out reasoning_tokens like OpenRouter does). Downstream
    `_extract_content` strips the think payload, so the kept response is
    much smaller than the reported usage — and the budget check would
    always trip. Recount the post-strip text with tiktoken and write that
    number back into `usage.completion_tokens`. tiktoken is an estimate
    (not the model's native tokenizer) but it's the only signal we have
    when the provider doesn't surface a breakdown.

    OpenRouterProvider does NOT call this helper — its `usage` is exact
    (native count + reasoning_tokens broken out), so we leave it alone.
    """
    if "usage" not in raw or raw["usage"] is None:
        raw["usage"] = {"prompt_tokens": 0, "completion_tokens": 0}
    msg = (raw.get("choices") or [{}])[0].get("message") or {}
    content = msg.get("content") or ""
    if _THINK_RE.search(content):
        # Format A — DeepSeek-R1-style inline `<think>...</think>` blocks
        # in `content`. Strip and recount.
        kept = _THINK_RE.sub("", content).strip()
        raw["usage"]["completion_tokens"] = count_tokens(kept)
    elif message_reasoning(msg) and content and not _reasoning_tokens_reported(raw):
        # Format B — Qwen3-style separate reasoning field with the kept response
        # in `content` (`reasoning` on Ollama, `reasoning_content` on LM Studio
        # and Unsloth Studio). These backends bill usage.completion_tokens as
        # (reasoning + content) without breaking out the split — Unsloth even
        # reports reasoning_tokens: 0 alongside a 30k-character think block — so
        # DB and cost/Quality-Report values would over-report by ~10×, and a
        # short answer could trip the budget check. Recount on the kept content
        # alone so the numbers match reality.
        #
        # Skipped when the backend DID break out reasoning_tokens (LM Studio):
        # job_runner._extract_usage already subtracts that figure, and recounting
        # here as well would subtract the thinking twice and floor tokens at 0.
        raw["usage"]["completion_tokens"] = count_tokens(content)
    return raw


def _reasoning_tokens_reported(raw: dict[str, Any]) -> int:
    """Reasoning tokens the backend itself broke out (0 when it didn't)."""
    usage = raw.get("usage") or {}
    return (usage.get("completion_tokens_details") or {}).get("reasoning_tokens", 0) or 0


def _to_model_info(raw: dict[str, Any]) -> ModelInfo:
    ctx = raw.get("context_length") or raw.get("max_model_len")
    return ModelInfo(
        id=str(raw.get("id") or ""),
        name=str(raw.get("name") or raw.get("id") or ""),
        context_length=int(ctx) if ctx else None,
        pricing=Pricing(),
        raw=raw,
    )
