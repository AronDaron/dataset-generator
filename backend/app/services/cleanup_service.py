"""Cleanup stage core — pure logic, no LLM calls (F1).

The cleanup stage sits between generation and judge and *fixes* format
defects (LaTeX, unclosed code fences, emoji, flattering openers, trailing
offers) instead of rejecting the example. Everything in this module is
offline-testable: collecting the texts of an example, splicing model output
back in, parsing the model's response and — most importantly — deciding
whether a returned text is an acceptable cleanup or a rewrite in disguise.

Structural safety is by construction: the model only ever sees one text and
returns one text. Keys, roles and turn counts never leave Python, so a cleanup
pass cannot corrupt the schema. The only thing the acceptance gates have to
defend against is the model changing the *content*.

Gate order is deliberate — cheap length checks reject the obvious failures
before the expensive token/fence analysis runs.
"""
from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass
from typing import Any

from app.services.example_schema import SUPPORTED_FORMATS

# ---------------------------------------------------------------------------
# Acceptance thresholds
# ---------------------------------------------------------------------------

GROWTH_LIMIT = 1.02   # len(after) > len(before) * GROWTH_LIMIT  -> "grew"
# Deliberately low. Measured on a Length-Constraints pilot: when a model wraps
# a 25-word answer in a preamble plus a numbered word-count verification, the
# real content is 5-18% of the text — so a *correct* cleanup shrinks the slot by
# 82-95%. A 0.60 floor reverted every one of those, leaving the dataset dirty
# while reporting "reverted". This gate now only catches a collapse (a model
# echoing two words instead of the text); paraphrase and truncation are the job
# of OVERLAP_MIN and the empty check.
SHRINK_FLOOR = 0.04   # len(after) < len(before) * SHRINK_FLOOR  -> "too_short"
OVERLAP_MIN = 0.95    # signature overlap below this            -> "paraphrase"

# Absolute slack on top of GROWTH_LIMIT. Closing an unclosed code fence — one
# of the defects this stage exists to fix — costs 3 to 5 characters ("```",
# "\n```", "\n```\n"), which is more than 2% of any slot shorter than ~200
# characters. Without the slack the growth gate would revert exactly the fix
# it was never meant to block. Kept small on purpose: 8 characters is too
# little for a sentence, so it buys no room for the model to add prose.
GROWTH_SLACK = 8

# Pre-filter is OFF by default: cleanup runs on every example so the rules
# behave exactly as written and nothing slips through. Flipping this constant
# is the escape hatch if generation time ever becomes the bottleneck.
CLEANUP_PREFILTER = False


# ---------------------------------------------------------------------------
# Text slots — collect / splice
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class TextSlot:
    """One text field of an example, in the order the model will see it.

    ``index`` is the 0-based position in the flat list sent to the model,
    ``role`` is a human-readable label for the prompt (``human``/``gpt``,
    ``user``/``assistant`` or ``instruction``/``input``/``output``).
    """

    index: int
    role: str
    text: str


# list_key, role_field, content_field for the conversation formats.
_CONVERSATION_TARGETS: dict[str, tuple[str, str, str]] = {
    "sharegpt": ("conversations", "from", "value"),
    "chatml": ("messages", "role", "content"),
}

# Alpaca is flat; `input` is conditional (see _slot_paths).
_ALPACA_FIELDS: tuple[str, ...] = ("instruction", "input", "output")


def _slot_paths(content: dict, fmt: str) -> list[tuple[tuple[Any, ...], str, str]]:
    """Return ``(path, role, text)`` for every text field of ``content``.

    ``path`` is a key/index chain into ``content`` (e.g.
    ``("conversations", 2, "value")`` or ``("instruction",)``). Both
    ``collect_texts`` and ``splice_texts`` walk this single list, which is
    what guarantees that slot *i* is read from and written to the same place.

    Non-string values and malformed turns are skipped rather than raising —
    a cleanup pass must never be the thing that breaks a job.
    """
    if not isinstance(content, dict) or fmt not in SUPPORTED_FORMATS:
        return []

    paths: list[tuple[tuple[Any, ...], str, str]] = []

    if fmt == "alpaca":
        for field in _ALPACA_FIELDS:
            if field not in content:
                continue
            value = content[field]
            if not isinstance(value, str):
                continue
            # `input` must stay an empty string per the generation contract
            # (prompt_builder), and the schema allows the key to be missing
            # altogether. Handing an empty string to the model would get a
            # non-empty one back and break the format.
            if field == "input" and not value.strip():
                continue
            paths.append(((field,), field, value))
        return paths

    list_key, role_field, content_field = _CONVERSATION_TARGETS[fmt]
    turns = content.get(list_key)
    if not isinstance(turns, list):
        return []
    for i, turn in enumerate(turns):
        if not isinstance(turn, dict):
            continue
        value = turn.get(content_field)
        if not isinstance(value, str):
            continue
        role = turn.get(role_field)
        paths.append(((list_key, i, content_field), role if isinstance(role, str) else "", value))
    return paths


def collect_texts(content: dict, fmt: str) -> list[TextSlot]:
    """Collect every text field of an example — user *and* assistant side.

    Defects show up on both sides (the generator writes the whole dialogue),
    so unlike ``example_schema._ASSISTANT_TARGETS`` this covers all slots.
    Returns an empty list for unsupported formats or malformed payloads.
    """
    return [
        TextSlot(index=i, role=role, text=text)
        for i, (_path, role, text) in enumerate(_slot_paths(content, fmt))
    ]


def splice_texts(content: dict, fmt: str, texts: list[str]) -> dict:
    """Return a deep copy of ``content`` with slot texts replaced by ``texts``.

    Only the string values at the exact coordinates reported by
    ``collect_texts`` are touched — keys, roles, ordering and turn count are
    copied verbatim. The input dict is never mutated.

    Raises ``ValueError`` when ``len(texts)`` does not match the number of
    slots, because a length mismatch means the caller (or the model) lost
    track of which text belongs where.
    """
    paths = _slot_paths(content, fmt)
    if len(texts) != len(paths):
        raise ValueError(
            f"splice_texts: got {len(texts)} text(s), expected {len(paths)} slot(s)"
        )

    spliced = copy.deepcopy(content)
    for (path, _role, _before), after in zip(paths, texts):
        target: Any = spliced
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = after
    return spliced


# ---------------------------------------------------------------------------
# Response parsing
# ---------------------------------------------------------------------------

_THINK_RE = re.compile(r"<think>[\s\S]*?</think>", re.IGNORECASE)


def _parse_json_array(raw: str) -> Any:
    """Parse JSON out of an LLM response, tolerating markdown fences.

    Mirrors ``job_runner._parse_json_response`` (kept local to avoid an import
    cycle once ``job_runner`` starts calling this module). Raises
    ``ValueError`` when nothing parses.
    """
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    fence_match = re.search(r"```(?:json)?\s*([\s\S]+?)\s*```", raw)
    if fence_match:
        try:
            return json.loads(fence_match.group(1))
        except json.JSONDecodeError:
            pass

    start, end = raw.find("["), raw.rfind("]")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(raw[start : end + 1])
        except json.JSONDecodeError:
            pass

    raise ValueError(f"Could not parse JSON from cleanup output: {raw[:200]!r}")


# Info tags a model uses when it wraps a *plain* answer in a fence. A tagged
# code fence (```python) is left alone: a slot whose whole text is one code
# block is legal content, and unwrapping it would be the corruption.
_WRAPPER_FENCE_TAGS = frozenset(
    {"", "text", "txt", "plain", "plaintext", "markdown", "md", "output", "response"}
)


def clean_slot_response(raw: str) -> str:
    """Sanitize the raw reply of a per-slot cleanup call into the slot text.

    With one text per request the model's answer *is* the result, so this is
    the only parsing left in the stage — and unlike ``parse_cleanup_response``
    it cannot fail: it always returns a string (possibly empty, which the
    ``empty`` gate in ``check_slot`` catches).

    Stripped, in order: a ``<think>`` block, a markdown fence wrapping the
    *whole* answer, and surrounding quotes. Fences inside the text are left
    untouched — they are the code the stage exists to protect.
    """
    text = _THINK_RE.sub("", raw or "").strip()
    text = _unwrap_fence(text)
    text = _unwrap_quotes(text)
    return text.strip()


def _unwrap_fence(text: str) -> str:
    """Drop a markdown fence that wraps the entire answer.

    Only a fence pair that opens on the first line, closes on the last one and
    is the *only* pair in the answer qualifies — anything else is a code block
    inside the text, not a wrapper around it.
    """
    if not text.startswith("```") or not text.endswith("```") or text.count("```") != 2:
        return text

    first_line, _, rest = text.partition("\n")
    if not rest:  # a single line like "```code```" — not a wrapper
        return text
    if first_line[3:].strip().lower() not in _WRAPPER_FENCE_TAGS:
        return text

    body = rest[: rest.rfind("```")]
    return body[:-1] if body.endswith("\n") else body


def _unwrap_quotes(text: str) -> str:
    """Drop the double quotes a model puts around the whole answer.

    A response that is a valid JSON string is decoded properly (so ``\\n``
    escapes become newlines); otherwise the outer quote characters are simply
    removed.
    """
    if len(text) < 2 or not text.startswith('"') or not text.endswith('"'):
        return text
    try:
        decoded = json.loads(text)
    except json.JSONDecodeError:
        return text[1:-1]
    return decoded if isinstance(decoded, str) else text


def parse_cleanup_response(
    raw: str, expected_n: int,
) -> tuple[list[str] | None, str | None]:
    """Parse a cleanup response into exactly ``expected_n`` non-empty strings.

    Returns ``(texts, None)`` on success, ``(None, reason)`` on failure with
    ``reason`` in ``json_parse_error`` / ``not_a_list`` / ``length_mismatch``
    / ``not_strings``. Same contract shape as
    ``reasoning_service._parse_and_validate_prose_list``: a failure is a
    transport/contract problem the caller may retry, never a silent partial
    result.
    """
    stripped = _THINK_RE.sub("", raw or "").strip()

    try:
        parsed = _parse_json_array(stripped)
    except ValueError:
        return None, "json_parse_error"

    if not isinstance(parsed, list):
        return None, "not_a_list"
    if len(parsed) != expected_n:
        return None, "length_mismatch"
    if any(not isinstance(item, str) or not item.strip() for item in parsed):
        return None, "not_strings"

    return parsed, None


# ---------------------------------------------------------------------------
# Acceptance gates
# ---------------------------------------------------------------------------

_SIG_RE = re.compile(r"[a-z0-9]{4,}")


def _signature(text: str) -> set[str]:
    """Lowercase alphanumeric tokens of 4+ characters — the content fingerprint.

    Deleting content can only ever shrink this set; rephrasing introduces
    tokens that were not in the original, which is exactly what the overlap
    gate measures.
    """
    return set(_SIG_RE.findall(text.lower()))


def _fence_bodies(text: str) -> tuple[list[str], int]:
    """Return ``(code block bodies, number of ``` markers)``.

    Bodies are stripped and have their language tag (``python`` etc.) removed
    so that dropping or adding a tag does not read as a code change. With an
    odd number of markers the last body is the unterminated tail.
    """
    parts = text.split("```")
    marker_count = len(parts) - 1
    bodies: list[str] = []
    for i in range(1, len(parts), 2):
        segment = parts[i]
        if "\n" in segment:
            first_line, rest = segment.split("\n", 1)
            tag = first_line.strip()
            if tag and " " not in tag:  # language tag, not code
                segment = rest
        bodies.append(segment.strip())
    return bodies, marker_count


def _code_changed(before: str, after: str) -> bool:
    """True when a code block body was altered or dropped.

    The set of bodies after cleanup must be a superset of the set before —
    deletion of prose around code is fine, touching the code is not.

    Exception: an odd marker count before and an even one after means the
    model closed an unclosed fence, which is one of the defects cleanup exists
    to fix. The unterminated tail body legitimately changes then (trailing
    prose ends up outside the block), so it is excluded from the comparison.
    """
    before_bodies, before_markers = _fence_bodies(before)
    after_bodies, after_markers = _fence_bodies(after)

    if before_markers % 2 == 1 and after_markers % 2 == 0 and before_bodies:
        before_bodies = before_bodies[:-1]

    return not set(before_bodies) <= set(after_bodies)


def check_slot(before: str, after: str) -> str | None:
    """Validate one cleaned text against its original.

    Returns ``None`` when the result is acceptable, otherwise the rejection
    reason: ``empty`` / ``grew`` / ``too_short`` / ``code_changed`` /
    ``paraphrase``. A rejected slot is reverted to ``before`` by the caller —
    the original already passed generation-time validation, so falling back to
    it is always safe.

    The growth gate allows the larger of ``GROWTH_LIMIT`` (relative) and
    ``GROWTH_SLACK`` (absolute) so that closing an unclosed fence in a short
    slot is not mistaken for the model adding prose.
    """
    if not after.strip():
        return "empty"
    if len(after) > max(len(before) * GROWTH_LIMIT, len(before) + GROWTH_SLACK):
        return "grew"
    if len(after) < len(before) * SHRINK_FLOOR:
        return "too_short"
    if _code_changed(before, after):
        return "code_changed"

    signature_after = _signature(after)
    if signature_after:
        overlap = len(signature_after & _signature(before)) / len(signature_after)
        if overlap < OVERLAP_MIN:
            return "paraphrase"

    return None


# ---------------------------------------------------------------------------
# Optional pre-filter
# ---------------------------------------------------------------------------

_LATEX_RES = (
    re.compile(r"\$\$?[^$\n]+\$\$?"),
    re.compile(r"\\[\(\[]"),
    re.compile(r"\\(frac|sum|int|alpha|beta|cdot|times|leq|geq|mathbb|text)\b"),
)
_EMOJI_RE = re.compile("[\U0001F300-\U0001FAFF\u2600-\u27bf\ufe0f]")


def needs_cleanup(texts: list[str]) -> bool:
    """Cheap regex pre-check: does any text carry a known format defect?

    Only consulted when ``CLEANUP_PREFILTER`` is enabled — with the flag off
    every example goes through the model, so rules that no regex can express
    (flattering openers, trailing offers) still apply.
    """
    for text in texts:
        if not text:
            continue
        if any(pattern.search(text) for pattern in _LATEX_RES):
            return True
        if text.count("```") % 2 == 1:
            return True
        if _EMOJI_RE.search(text):
            return True
    return False
