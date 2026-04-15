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
    """Compute pairwise cosine similarity using numpy."""
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


async def find_duplicates(
    db: aiosqlite.Connection,
    job_id: str,
    threshold: float = 0.85,
    api_key: str = "",
    embedding_model: str = "openai/text-embedding-3-small",
) -> list[DuplicatePairResponse]:
    """Find duplicate example pairs using embedding cosine similarity."""

    async with await db.execute(
        "SELECT id, content_json, format, tokens, judge_score "
        "FROM examples WHERE job_id = ? ORDER BY created_at ASC",
        (job_id,),
    ) as cursor:
        rows = await cursor.fetchall()

    if len(rows) < 2:
        return []

    texts = [extract_text(row["content_json"], row["format"]) for row in rows]

    # Get embeddings from API
    embeddings = await get_embeddings(api_key, embedding_model, texts)

    # Compute cosine similarity in a thread to avoid blocking event loop
    sim_matrix = await asyncio.to_thread(_cosine_similarity_matrix, embeddings)
    raw_pairs = _find_pairs_above_threshold(sim_matrix, threshold)

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
