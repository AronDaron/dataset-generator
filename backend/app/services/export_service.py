from __future__ import annotations

import logging
from pathlib import Path

import aiosqlite

from app.config import settings
from app.services.example_schema import (
    attach_metadata,
    build_metadata_block,
    serialize_for_jsonl,
    serialize_with_reasoning,
)

logger = logging.getLogger(__name__)


# Columns required when composing the metadata block. Kept in sync with
# build_metadata_block — if the block grows new fields, extend this list and
# the SELECT below picks them up automatically.
_METADATA_COLUMNS = (
    "category", "model", "judge_score",
    "prompt_tokens", "completion_tokens", "reasoning_model_used",
)


def _select_clause(*, include_metadata: bool, reasoning_format: str | None) -> str:
    cols = ["content_json", "format"]
    if reasoning_format:
        cols.append("reasoning")
    if include_metadata:
        cols.extend(_METADATA_COLUMNS)
    return ", ".join(cols)


async def _export_job_to_path(
    job_id: str,
    db: aiosqlite.Connection,
    out_path: Path,
    *,
    include_metadata: bool,
) -> Path:
    """Stream examples for ``job_id`` into ``out_path`` as JSONL.

    Shared core for ``export_job`` (no metadata) and ``export_job_with_metadata``.
    Honours the job's ``reasoning_format`` (if set) so reasoning prose is
    composed into the JSONL on the fly. When ``include_metadata`` is True a
    top-level ``metadata`` block is appended to every line after the
    defensive strip — metadata is write-path only and never touches the
    schema validator.
    """
    settings.datasets_dir.mkdir(parents=True, exist_ok=True)

    async with await db.execute(
        "SELECT reasoning_format FROM jobs WHERE id = ?", (job_id,)
    ) as cursor:
        job_row = await cursor.fetchone()
    reasoning_format = job_row["reasoning_format"] if job_row else None

    select = _select_clause(
        include_metadata=include_metadata,
        reasoning_format=reasoning_format,
    )
    sql = (
        f"SELECT {select} FROM examples "
        "WHERE job_id = ? ORDER BY created_at ASC"
    )
    async with await db.execute(sql, (job_id,)) as cursor:
        rows = await cursor.fetchall()

    if not rows:
        raise RuntimeError(f"No examples found for job {job_id}")

    stripped_rows = 0
    total_dropped = 0
    sample_paths: list[str] = []
    with out_path.open("w", encoding="utf-8") as fh:
        for row in rows:
            if reasoning_format:
                line, dropped = serialize_with_reasoning(
                    row["content_json"], row["format"], row["reasoning"], reasoning_format,
                )
            else:
                line, dropped = serialize_for_jsonl(row["content_json"], row["format"])
            if include_metadata:
                line = attach_metadata(line, build_metadata_block(dict(row)))
            fh.write(line + "\n")
            if dropped:
                stripped_rows += 1
                total_dropped += len(dropped)
                if len(sample_paths) < 5:
                    sample_paths.extend(dropped[: 5 - len(sample_paths)])

    if stripped_rows:
        logger.warning(
            "Export %s: stripped extra keys from %d/%d rows "
            "(dropped %d paths total, sample=%s)",
            job_id, stripped_rows, len(rows), total_dropped, sample_paths,
        )

    logger.info(
        "Exported %d examples for job %s → %s (metadata=%s)",
        len(rows), job_id, out_path, include_metadata,
    )
    return out_path


async def export_job(job_id: str, db: aiosqlite.Connection) -> Path:
    """
    Fetch all examples for job_id from the DB and write them as JSONL to
    datasets_dir/{job_id}.jsonl.  Returns the output Path.

    Creates datasets_dir if it does not exist yet.
    Overwrites any previously exported file for the same job (idempotent).
    Raises RuntimeError if no examples exist for the job.

    Each row is passed through ``serialize_for_jsonl`` which strips extra
    top-level and per-turn keys not in the format whitelist. This is a no-op
    for rows produced by the strict validator (post-fix); for legacy rows
    that snuck through the old liberal validator it ensures every emitted
    line shares the same Arrow/HF schema.

    For reasoning jobs (``jobs.reasoning_format`` is set) each row goes through
    ``serialize_with_reasoning`` instead — the per-example ``reasoning`` column
    is composed into the JSONL on the fly (inline ``<think>...</think>`` or a
    top-level ``reasoning`` field). The DB ``content_json`` is never mutated,
    so re-running reasoning with a different format on the same source is a
    clean new job.
    """
    out_path = settings.datasets_dir / f"{job_id}.jsonl"
    return await _export_job_to_path(job_id, db, out_path, include_metadata=False)


async def export_job_with_metadata(job_id: str, db: aiosqlite.Connection) -> Path:
    """Like ``export_job`` but appends a per-example ``metadata`` block.

    Output lands in ``datasets_dir/{job_id}_with_metadata.jsonl`` (separate
    file from the no-metadata export so HF upload of either flavour stays
    deterministic and backwards-compatible). Always overwrites — delete-example
    could have mutated the source rows since the last run.
    """
    out_path = settings.datasets_dir / f"{job_id}_with_metadata.jsonl"
    return await _export_job_to_path(job_id, db, out_path, include_metadata=True)
