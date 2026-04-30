"""Single source of truth for example structure validation and JSONL cleanup.

Two independent operations on the same schema:

- ``validate_example`` enforces strict shape at generation time. A row that
  passes is guaranteed to produce a JSONL line whose top-level key set is
  identical to every other passing row of the same format. Used by
  ``job_runner`` to reject malformed model outputs before they enter the DB.

- ``strip_to_schema`` defensively prunes extra keys from already-stored
  content during JSONL export. It does not validate types or values — it
  only ensures the on-disk JSONL has a stable Arrow/HF schema even when DB
  rows contain legacy garbage from before the strict validator landed.
"""
from __future__ import annotations

import json
from typing import Any, TypedDict


SUPPORTED_FORMATS: frozenset[str] = frozenset({"alpaca", "sharegpt", "chatml"})

_ALPACA_TOP_KEYS: frozenset[str] = frozenset({"instruction", "input", "output"})
_ALPACA_REQUIRED_TOP_KEYS: frozenset[str] = frozenset({"instruction", "output"})

_SHAREGPT_TOP_KEYS: frozenset[str] = frozenset({"conversations"})
_SHAREGPT_TURN_KEYS: frozenset[str] = frozenset({"from", "value"})
_SHAREGPT_ROLES: tuple[str, str] = ("human", "gpt")

_CHATML_TOP_KEYS: frozenset[str] = frozenset({"messages"})
_CHATML_TURN_KEYS: frozenset[str] = frozenset({"role", "content"})
_CHATML_ROLES: tuple[str, str] = ("user", "assistant")


class ValidationResult(TypedDict):
    ok: bool
    reason: str | None
    detail: str | None


def _ok() -> ValidationResult:
    return {"ok": True, "reason": None, "detail": None}


def _fail(reason: str, detail: str) -> ValidationResult:
    return {"ok": False, "reason": reason, "detail": detail}


def validate_example(parsed: Any, fmt: str) -> ValidationResult:
    """Strictly validate that ``parsed`` matches the schema for ``fmt``.

    On success the example is guaranteed to share top-level keys (and turn
    keys, where applicable) with every other passing example of the same
    format — safe to write to JSONL without breaking Arrow column unification.
    """
    if not isinstance(parsed, dict):
        return _fail("not_dict", f"parsed payload is {type(parsed).__name__}, expected dict")

    if fmt not in SUPPORTED_FORMATS:
        return _fail("unknown_format", f"format {fmt!r} is not supported")

    if fmt == "alpaca":
        return _validate_alpaca(parsed)
    if fmt == "sharegpt":
        return _validate_conversation(
            parsed,
            top_keys=_SHAREGPT_TOP_KEYS,
            list_key="conversations",
            turn_keys=_SHAREGPT_TURN_KEYS,
            roles=_SHAREGPT_ROLES,
            role_field="from",
            content_field="value",
        )
    if fmt == "chatml":
        return _validate_conversation(
            parsed,
            top_keys=_CHATML_TOP_KEYS,
            list_key="messages",
            turn_keys=_CHATML_TURN_KEYS,
            roles=_CHATML_ROLES,
            role_field="role",
            content_field="content",
        )

    return _fail("unknown_format", f"format {fmt!r} is not supported")


def _validate_alpaca(parsed: dict) -> ValidationResult:
    keys = set(parsed.keys())
    extra = keys - _ALPACA_TOP_KEYS
    if extra:
        return _fail("extra_top_keys", f"extra top-level keys: {sorted(extra)}")
    missing = _ALPACA_REQUIRED_TOP_KEYS - keys
    if missing:
        return _fail("missing_required", f"missing required keys: {sorted(missing)}")

    instruction = parsed["instruction"]
    if not isinstance(instruction, str):
        return _fail("wrong_type", f"instruction is {type(instruction).__name__}, expected str")
    if not instruction.strip():
        return _fail("empty_value", "instruction is empty")

    output = parsed["output"]
    if not isinstance(output, str):
        return _fail("wrong_type", f"output is {type(output).__name__}, expected str")
    if not output.strip():
        return _fail("empty_value", "output is empty")

    if "input" in parsed and not isinstance(parsed["input"], str):
        return _fail("wrong_type", f"input is {type(parsed['input']).__name__}, expected str")

    return _ok()


def _validate_conversation(
    parsed: dict,
    *,
    top_keys: frozenset[str],
    list_key: str,
    turn_keys: frozenset[str],
    roles: tuple[str, str],
    role_field: str,
    content_field: str,
) -> ValidationResult:
    keys = set(parsed.keys())
    extra = keys - top_keys
    if extra:
        return _fail("extra_top_keys", f"extra top-level keys: {sorted(extra)}")
    missing = top_keys - keys
    if missing:
        return _fail("missing_required", f"missing required keys: {sorted(missing)}")

    turns = parsed[list_key]
    if not isinstance(turns, list):
        return _fail("wrong_type", f"{list_key} is {type(turns).__name__}, expected list")
    if len(turns) < 2:
        return _fail("too_few_turns", f"{list_key} has {len(turns)} turn(s), need at least 2")

    for i, turn in enumerate(turns):
        if not isinstance(turn, dict):
            return _fail("wrong_type", f"{list_key}[{i}] is {type(turn).__name__}, expected dict")
        turn_key_set = set(turn.keys())
        extra_turn = turn_key_set - turn_keys
        if extra_turn:
            return _fail(
                "extra_turn_keys",
                f"{list_key}[{i}] has extra keys: {sorted(extra_turn)}",
            )
        missing_turn = turn_keys - turn_key_set
        if missing_turn:
            return _fail(
                "missing_required",
                f"{list_key}[{i}] missing keys: {sorted(missing_turn)}",
            )

        role = turn[role_field]
        content = turn[content_field]
        if not isinstance(role, str):
            return _fail(
                "wrong_type",
                f"{list_key}[{i}].{role_field} is {type(role).__name__}, expected str",
            )
        if not isinstance(content, str):
            return _fail(
                "wrong_type",
                f"{list_key}[{i}].{content_field} is {type(content).__name__}, expected str",
            )
        if role not in roles:
            return _fail(
                "role_mismatch",
                f"{list_key}[{i}].{role_field}={role!r} not in {list(roles)}",
            )
        expected = roles[i % 2]
        if role != expected:
            return _fail(
                "role_mismatch",
                f"{list_key}[{i}].{role_field}={role!r}, expected {expected!r}",
            )
        if not content.strip():
            return _fail("empty_value", f"{list_key}[{i}].{content_field} is empty")

    return _ok()


def is_valid_example(parsed: Any, fmt: str) -> bool:
    return validate_example(parsed, fmt)["ok"]


def strip_to_schema(parsed: dict, fmt: str) -> tuple[dict, list[str]]:
    """Prune extra top-level and per-turn keys from ``parsed``.

    Idempotent for clean inputs (returns ``(parsed_copy, [])``). For
    ``fmt`` outside ``SUPPORTED_FORMATS`` returns ``(parsed, [])`` unchanged
    — strip cannot fix what the schema does not recognize.

    Does not validate types or values: a turn that is not a dict is kept
    verbatim, list/dict mismatches are not "fixed". Use ``validate_example``
    for that.
    """
    if not isinstance(parsed, dict) or fmt not in SUPPORTED_FORMATS:
        return parsed, []

    if fmt == "alpaca":
        return _strip_flat(parsed, _ALPACA_TOP_KEYS)

    if fmt == "sharegpt":
        return _strip_conversation(
            parsed,
            top_keys=_SHAREGPT_TOP_KEYS,
            list_key="conversations",
            turn_keys=_SHAREGPT_TURN_KEYS,
        )

    if fmt == "chatml":
        return _strip_conversation(
            parsed,
            top_keys=_CHATML_TOP_KEYS,
            list_key="messages",
            turn_keys=_CHATML_TURN_KEYS,
        )

    return parsed, []


def _strip_flat(parsed: dict, allowed: frozenset[str]) -> tuple[dict, list[str]]:
    cleaned: dict = {}
    dropped: list[str] = []
    for k, v in parsed.items():
        if k in allowed:
            cleaned[k] = v
        else:
            dropped.append(k)
    return cleaned, dropped


def _strip_conversation(
    parsed: dict,
    *,
    top_keys: frozenset[str],
    list_key: str,
    turn_keys: frozenset[str],
) -> tuple[dict, list[str]]:
    cleaned, dropped = _strip_flat(parsed, top_keys)

    turns = cleaned.get(list_key)
    if not isinstance(turns, list):
        return cleaned, dropped

    new_turns: list = []
    for i, turn in enumerate(turns):
        if not isinstance(turn, dict):
            new_turns.append(turn)
            continue
        new_turn: dict = {}
        for tk, tv in turn.items():
            if tk in turn_keys:
                new_turn[tk] = tv
            else:
                dropped.append(f"{list_key}[{i}].{tk}")
        new_turns.append(new_turn)
    cleaned[list_key] = new_turns
    return cleaned, dropped


def serialize_for_jsonl(content_json: str, fmt: str) -> tuple[str, list[str]]:
    """Parse ``content_json``, defensively strip extra keys, return minified JSON.

    Returns ``(jsonl_line_without_trailing_newline, dropped_paths)``.
    Idempotent: clean input → ``dropped == []`` and the output is a minified
    re-encoding of the same data (which also removes any embedded ``\\n``).

    For unsupported ``fmt`` (or non-dict payload) the strip step is skipped,
    but the round-trip through ``json.loads``/``json.dumps`` still happens
    so the output is guaranteed to be a single line.
    """
    parsed = json.loads(content_json)
    if isinstance(parsed, dict) and fmt in SUPPORTED_FORMATS:
        cleaned, dropped = strip_to_schema(parsed, fmt)
        return json.dumps(cleaned, ensure_ascii=False), dropped
    return json.dumps(parsed, ensure_ascii=False), []
