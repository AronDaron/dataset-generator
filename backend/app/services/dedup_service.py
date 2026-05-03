"""Embedding-based duplicate detection for dataset examples."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import aiosqlite
import numpy as np

from app.models.jobs import DuplicatePairResponse
from app.services.embedding_service import get_embeddings

logger = logging.getLogger(__name__)

PREVIEW_LENGTH = 120


def extract_text(content_json: str, fmt: str) -> str:
    """Extract plain text from example content for embedding."""
    try:
        data: dict[str, Any] = json.loads(content_json)
    except (json.JSONDecodeError, TypeError):
        return ""

    try:
        if fmt == "sharegpt":
            return " ".join(
                conv.get("value", "") for conv in data.get("conversations", [])
            )
        if fmt == "alpaca":
            return " ".join(
                filter(
                    None,
                    [
                        data.get("instruction", ""),
                        data.get("input", ""),
                        data.get("output", ""),
                    ],
                )
            )
        if fmt == "chatml":
            return " ".join(
                msg.get("content", "") for msg in data.get("messages", [])
            )
    except (AttributeError, TypeError):
        return ""

    return ""


_ROLE_MAP_SHAREGPT = {"human": "USER", "gpt": "ASSISTANT", "system": "SYSTEM"}
_ROLE_MAP_CHATML = {"user": "USER", "assistant": "ASSISTANT", "system": "SYSTEM"}


def format_text_with_turns(content_json: str, fmt: str) -> str:
    """Format example content with role labels for display in the UI."""
    try:
        data: dict[str, Any] = json.loads(content_json)
    except (json.JSONDecodeError, TypeError):
        return content_json

    try:
        if fmt == "sharegpt":
            lines = []
            for conv in data.get("conversations", []):
                role = _ROLE_MAP_SHAREGPT.get(conv.get("from", ""), conv.get("from", ""))
                lines.append(f"{role}: {conv.get('value', '')}")
            return "\n\n".join(lines)

        if fmt == "alpaca":
            parts = []
            if data.get("instruction"):
                parts.append(f"INSTRUCTION: {data['instruction']}")
            if data.get("input"):
                parts.append(f"INPUT: {data['input']}")
            if data.get("output"):
                parts.append(f"OUTPUT: {data['output']}")
            return "\n\n".join(parts)

        if fmt == "chatml":
            lines = []
            for msg in data.get("messages", []):
                role = _ROLE_MAP_CHATML.get(msg.get("role", ""), msg.get("role", ""))
                lines.append(f"{role}: {msg.get('content', '')}")
            return "\n\n".join(lines)
    except (AttributeError, TypeError):
        return content_json

    return content_json


def _cosine_similarity_matrix(embeddings: np.ndarray) -> np.ndarray:
    """Compute pairwise cosine similarity using numpy.

    Allocates an N×N float matrix — use only for small N (<2000).
    For larger N, go through _find_pairs_blockwise which streams blocks
    of block_size × N scores.
    """
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms = np.maximum(norms, 1e-10)  # avoid division by zero
    normalized = embeddings / norms
    return normalized @ normalized.T


def _find_pairs_above_threshold(
    sim_matrix: np.ndarray, threshold: float
) -> list[tuple[int, int, float]]:
    """Extract (i, j, score) pairs from upper triangle of similarity matrix."""
    i_idx, j_idx = np.triu_indices(sim_matrix.shape[0], k=1)
    scores = sim_matrix[i_idx, j_idx]
    mask = scores >= threshold
    pairs = list(zip(i_idx[mask].tolist(), j_idx[mask].tolist(), scores[mask].tolist()))
    pairs.sort(key=lambda p: p[2], reverse=True)
    return pairs


# Full-matrix path is kept for small N (< FULL_MATRIX_CUTOFF). Above that we
# switch to block-wise which never allocates an N×N matrix.
FULL_MATRIX_CUTOFF = 2000


def _choose_block_size(n: int, max_bytes: int = 500_000_000) -> int:
    """Pick a block size for the (block, N) score slices. Caps block memory
    to ~`max_bytes` (default 500 MB) so even a 500k-row dedup stays bounded.
    """
    if n <= 0:
        return 1
    bytes_per_row = n * 4  # float32
    target = max(1, max_bytes // bytes_per_row)
    return max(128, min(1000, target))


def _find_pairs_blockwise(
    embeddings: np.ndarray,
    threshold: float,
    block_size: int | None = None,
) -> list[tuple[int, int, float]]:
    """Equivalent to _find_pairs_above_threshold(_cosine_similarity_matrix(e))
    without materializing the full N×N matrix. Memory peak per iteration is
    roughly block_size × N × 4 bytes.

    Input is NOT assumed to be normalized — this function normalizes in place
    on a copy. Output pairs are sorted by score descending, same as the
    full-matrix path.
    """
    n = embeddings.shape[0]
    if n < 2:
        return []
    if block_size is None:
        block_size = _choose_block_size(n)

    # Normalize — match the full-matrix behavior byte-for-byte.
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms = np.maximum(norms, 1e-10)
    normed = embeddings / norms

    pairs: list[tuple[int, int, float]] = []
    for i0 in range(0, n, block_size):
        i1 = min(i0 + block_size, n)
        # Slice shape: (block, n); we only keep the upper triangle j > i.
        block_scores = normed[i0:i1] @ normed.T
        block_rows = block_scores.shape[0]
        for local_i in range(block_rows):
            global_i = i0 + local_i
            # Upper triangle: j > global_i
            start_j = global_i + 1
            if start_j >= n:
                continue
            row = block_scores[local_i, start_j:]
            hits = np.nonzero(row >= threshold)[0]
            if hits.size == 0:
                continue
            for off in hits:
                j = start_j + int(off)
                pairs.append((global_i, j, float(row[off])))

    pairs.sort(key=lambda p: p[2], reverse=True)
    return pairs


async def find_duplicates(
    db: aiosqlite.Connection,
    job_id: str,
    threshold: float = 0.85,
    *,
    provider=None,
    embedding_model: str = "openai/text-embedding-3-small",
) -> list[DuplicatePairResponse]:
    """Find duplicate example pairs using embedding cosine similarity.

    `provider` is an LLMProvider instance — pass the one resolved from
    `embedding_provider_id` setting (or the default). Required for any non-empty
    job; only the early-return below skips it.
    """

    async with await db.execute(
        "SELECT id, content_json, format, tokens, judge_score "
        "FROM examples WHERE job_id = ? ORDER BY created_at ASC",
        (job_id,),
    ) as cursor:
        rows = await cursor.fetchall()

    if len(rows) < 2:
        return []

    if provider is None:
        raise ValueError("dedup requires an LLMProvider for embeddings")

    texts = [extract_text(row["content_json"], row["format"]) for row in rows]

    embeddings = await get_embeddings(provider, embedding_model, texts)

    # Small N: full N×N matrix (lower overhead). Large N: block-wise avoids
    # allocating N² memory.
    if embeddings.shape[0] < FULL_MATRIX_CUTOFF:
        sim_matrix = await asyncio.to_thread(_cosine_similarity_matrix, embeddings)
        raw_pairs = _find_pairs_above_threshold(sim_matrix, threshold)
    else:
        raw_pairs = await asyncio.to_thread(
            _find_pairs_blockwise, embeddings, threshold
        )

    result: list[DuplicatePairResponse] = []
    for i, j, score in raw_pairs:
        row_a = rows[i]
        row_b = rows[j]

        text_a = extract_text(row_a["content_json"], row_a["format"])
        text_b = extract_text(row_b["content_json"], row_b["format"])

        result.append(
            DuplicatePairResponse(
                example_id_a=row_a["id"],
                example_id_b=row_b["id"],
                similarity=round(score, 4),
                preview_a=text_a[:PREVIEW_LENGTH] + ("…" if len(text_a) > PREVIEW_LENGTH else ""),
                preview_b=text_b[:PREVIEW_LENGTH] + ("…" if len(text_b) > PREVIEW_LENGTH else ""),
                content_a=json.loads(row_a["content_json"]),
                content_b=json.loads(row_b["content_json"]),
                format_a=row_a["format"],
                format_b=row_b["format"],
                tokens_a=row_a["tokens"],
                tokens_b=row_b["tokens"],
                judge_score_a=row_a["judge_score"],
                judge_score_b=row_b["judge_score"],
            )
        )

    return result
