"""Quality Report snapshot — pre-computed at job finalize to keep GET
/api/jobs/{id}/stats sub-100ms even on large (100k+) datasets.

Snapshot covers the three expensive aggregations: per-category token stats,
score distribution histogram, and generation efficiency. run_summary stays
on-the-fly in the router because merged jobs resolve their source configs
dynamically (and those sources can be edited/deleted after the snapshot).
"""
from __future__ import annotations

import json
import logging
import statistics
from typing import Optional

import aiosqlite

from app.models.jobs import (
    GenerationEfficiency,
    ProgressJson,
    ScoreBucket,
    ScoreDistribution,
    TokenStatsByCategory,
)

logger = logging.getLogger(__name__)


def _compute_score_buckets(scores: list[int]) -> list[ScoreBucket]:
    """Build histogram buckets with dynamic width based on score range.

    Mirrors the algorithm in app.routers.jobs._compute_score_buckets — kept
    duplicated here to avoid a cross-module import cycle (router imports this
    service). Any behavior change must be mirrored in both places.
    """
    if not scores:
        return []
    min_s, max_s = min(scores), max(scores)
    score_range = max_s - min_s
    if score_range <= 10:
        width = 1
    elif score_range <= 25:
        width = 5
    else:
        width = 10
    start = (min_s // width) * width
    buckets: list[ScoreBucket] = []
    while start <= max_s:
        end = min(start + width, max_s + 1)
        is_last = end > max_s
        count = (
            sum(1 for s in scores if start <= s < end)
            if not is_last
            else sum(1 for s in scores if start <= s <= max_s)
        )
        upper_label = min(start + width - 1, max_s)
        label = f"{start}-{upper_label}" if width > 1 else str(start)
        if count > 0:
            buckets.append(ScoreBucket(label=label, count=count))
        start += width
    return buckets


async def compute_stats_snapshot(
    db: aiosqlite.Connection,
    job_id: str,
    *,
    judge_enabled: bool,
    progress: Optional[ProgressJson],
) -> dict:
    """Compute the three aggregations for `job_id` and return a JSON-serializable dict.

    Safe to call multiple times — purely read-only against the DB.
    """
    # Token stats by category
    async with await db.execute(
        "SELECT "
        "  CASE WHEN category = '' THEN 'Unknown' ELSE category END AS cat, "
        "  COUNT(*) AS cnt, "
        "  ROUND(AVG(prompt_tokens + completion_tokens), 1) AS avg_tok, "
        "  MIN(prompt_tokens + completion_tokens) AS min_tok, "
        "  MAX(prompt_tokens + completion_tokens) AS max_tok "
        "FROM examples WHERE job_id = ? "
        "GROUP BY cat ORDER BY cat",
        (job_id,),
    ) as cursor:
        token_rows = await cursor.fetchall()
    token_stats = [
        {
            "category": r["cat"],
            "examples_count": r["cnt"],
            "avg_tokens": r["avg_tok"] or 0,
            "min_tokens": r["min_tok"] or 0,
            "max_tokens": r["max_tok"] or 0,
        }
        for r in token_rows
    ]

    # Score distribution (judge only)
    score_distribution: Optional[dict] = None
    if judge_enabled:
        async with await db.execute(
            "SELECT judge_score FROM examples "
            "WHERE job_id = ? AND judge_score IS NOT NULL",
            (job_id,),
        ) as cursor:
            score_rows = await cursor.fetchall()
        scores = [r["judge_score"] for r in score_rows]
        if scores:
            sorted_scores = sorted(scores)
            score_distribution = {
                "buckets": [
                    {"label": b.label, "count": b.count}
                    for b in _compute_score_buckets(scores)
                ],
                "total": len(scores),
                "min_score": sorted_scores[0],
                "max_score": sorted_scores[-1],
                "avg_score": round(statistics.mean(scores), 1),
                "median_score": int(statistics.median(sorted_scores)),
            }

    # Generation efficiency from progress_json
    efficiency: list[dict] = []
    if progress and progress.categories:
        for cat_name, cat_prog in progress.categories.items():
            total_attempts = cat_prog.completed + cat_prog.skipped
            rate = (cat_prog.completed / total_attempts * 100) if total_attempts > 0 else 100.0
            efficiency.append(
                {
                    "category": cat_name,
                    "target": cat_prog.target,
                    "completed": cat_prog.completed,
                    "skipped": cat_prog.skipped,
                    "success_rate": round(rate, 1),
                }
            )

    return {
        "token_stats": token_stats,
        "score_distribution": score_distribution,
        "generation_efficiency": efficiency,
    }


async def store_stats_snapshot(
    db: aiosqlite.Connection, job_id: str, snapshot: dict
) -> None:
    """Persist snapshot JSON to jobs.stats_json. Separate from compute so tests
    can exercise the pure-function path without DB writes."""
    await db.execute(
        "UPDATE jobs SET stats_json = ? WHERE id = ?",
        (json.dumps(snapshot), job_id),
    )
    await db.commit()


async def compute_and_store(
    db: aiosqlite.Connection,
    job_id: str,
    *,
    judge_enabled: bool,
    progress: Optional[ProgressJson],
) -> None:
    """Best-effort combined call — logs and swallows exceptions so callers
    (job finalize, merge task) never block completion on a stats failure."""
    try:
        snapshot = await compute_stats_snapshot(
            db, job_id, judge_enabled=judge_enabled, progress=progress
        )
        await store_stats_snapshot(db, job_id, snapshot)
    except Exception:
        logger.exception("stats snapshot failed for job %s (non-fatal)", job_id)


def snapshot_to_response_parts(
    snapshot: dict,
) -> tuple[
    list[TokenStatsByCategory],
    Optional[ScoreDistribution],
    list[GenerationEfficiency],
]:
    """Deserialize a stored snapshot back into pydantic models for GET /stats."""
    token_stats = [TokenStatsByCategory.model_validate(t) for t in snapshot.get("token_stats", [])]
    sd_data = snapshot.get("score_distribution")
    score_distribution = ScoreDistribution.model_validate(sd_data) if sd_data else None
    efficiency = [
        GenerationEfficiency.model_validate(e) for e in snapshot.get("generation_efficiency", [])
    ]
    return token_stats, score_distribution, efficiency
