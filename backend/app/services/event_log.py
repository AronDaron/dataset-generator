"""In-memory per-job activity event log.

Events live in a bounded deque per job_id (maxlen=MAX_EVENTS_PER_JOB=20). Produced by the
job pipeline (job_runner.py) and consumed by the SSE stream handler
(routers/jobs.py). Cleared when a job is hard-deleted.

Not persisted — events die with the process, same as the job itself.
"""
from __future__ import annotations

import collections
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel

Level = Literal["info", "warn", "error"]

MAX_EVENTS_PER_JOB = 20


class ActivityEvent(BaseModel):
    seq: int
    ts: str
    level: Level
    kind: str
    message: str
    category: str | None = None
    meta: dict = {}


_job_events: dict[str, collections.deque[ActivityEvent]] = {}
_event_seq: dict[str, int] = {}


# kind → (level, template). Template rendered via str.format(**meta) with
# a safe fallback to a raw repr when a key is missing.
_TEMPLATES: dict[str, tuple[Level, str]] = {
    "generation_api_error":          ("warn",  "{category} — API error (attempt {attempt})"),
    "generation_unexpected_error":   ("warn",  "{category} — unexpected error (attempt {attempt})"),
    "generation_empty_response":     ("warn",  "{category} — empty response from model"),
    "generation_json_parse_error":   ("warn",  "{category} — couldn't parse model output"),
    "generation_invalid_structure":  ("warn",  "{category} — example rejected (invalid format)"),
    "generation_over_token_budget":  ("warn",  "{category} — over token budget ({tokens}/{max_tokens})"),
    "topic_generation_start":        ("info",  "{category} — generating {count} topics…"),
    "topics_exhausted_regenerating": ("info",  "{category} — topics used up, generating {needed} more"),
    "topics_generation_failed":      ("error", "{category} — couldn't generate fresh topics, stopping"),
    "generation_failed_retrying":    ("warn",  '{category} — skipped "{topic}" ({attempt}/{max_attempts})'),
    "judge_no_score_retry":          ("warn",  'Judge retry {attempt}/{max_retries} — "{topic}"'),
    "judge_failed_all_retries":      ("error", 'Judge failed all retries — "{topic}"'),
    "judge_rejected_below_threshold":("warn",  'Judge rejected "{topic}" (score {score}<{threshold})'),
    "category_attempt_limit_reached":("error", "{category} — attempt limit reached ({completed}/{target})"),
    "example_accepted":              ("info",  "{category} — accepted (score {score})"),
    "example_accepted_no_judge":     ("info",  "{category} — accepted"),
    "job_completed":                 ("info",  "Generation complete — {completed} examples"),
    "job_resumed":                   ("info",  "Resumed from {completed}/{target} examples"),
    "merge_started":                 ("info",  "Merging {source_count} datasets — {total} examples"),
    "merge_copy_batch":              ("info",  "Copied {done}/{total} examples"),
    "merge_export_start":            ("info",  "Writing JSONL file"),
    "merge_stats_start":             ("info",  "Computing statistics"),
    "merge_completed":               ("info",  "Merge complete — {total} examples"),
    "merge_failed":                  ("error", "Merge failed: {error}"),
    "merge_shuffle_skipped_large":   ("warn",  "Shuffle skipped — {total} exceeds {threshold} limit"),
    "merge_strip_extra_keys":        ("warn",  "Stripped extra keys from {rows_affected} rows during merge"),
}


def _render(kind: str, meta: dict) -> tuple[Level, str]:
    tpl = _TEMPLATES.get(kind)
    if tpl is None:
        return "warn", f"{kind} {meta!r}"
    level, template = tpl
    try:
        return level, template.format(**meta)
    except (KeyError, IndexError):
        return level, f"{kind} {meta!r}"


def log_event(job_id: str, kind: str, **meta) -> None:
    """Append an event to the per-job deque. Safe to call from any coroutine."""
    level, message = _render(kind, meta)
    seq = _event_seq.get(job_id, 0) + 1
    _event_seq[job_id] = seq
    event = ActivityEvent(
        seq=seq,
        ts=datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        level=level,
        kind=kind,
        message=message,
        category=meta.get("category"),
        meta=meta,
    )
    q = _job_events.get(job_id)
    if q is None:
        q = collections.deque(maxlen=MAX_EVENTS_PER_JOB)
        _job_events[job_id] = q
    q.append(event)


def get_events(job_id: str, after_seq: int = 0) -> list[ActivityEvent]:
    """Return events for a job with seq > after_seq, in order."""
    q = _job_events.get(job_id)
    if q is None:
        return []
    if after_seq <= 0:
        return list(q)
    return [e for e in q if e.seq > after_seq]


def clear_events(job_id: str) -> None:
    _job_events.pop(job_id, None)
    _event_seq.pop(job_id, None)
