from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Literal, Sequence

from app.services.token_counter import count_tokens

if TYPE_CHECKING:  # pragma: no cover - typing only
    # Import guarded so this module stays free of runtime service imports:
    # `app.models.jobs` pulls DEFAULT_CLEANUP_RULES from here, and a runtime
    # edge to cleanup_service would drag the whole services layer into the
    # model layer. `TextSlot` is only ever read (index/role/text).
    from app.services.cleanup_service import TextSlot

# Default rules injected into the cleanup prompt when the user leaves the
# field empty. One rule per line — the cleanup model reads them verbatim, so
# every line must describe something to DELETE or minimally reformat, never
# something to rewrite. Encodes the format defects measured on generated
# datasets (LaTeX, unclosed fences, emoji, sycophantic openers, trailing
# offers, meta-commentary).
DEFAULT_CLEANUP_RULES = """\
Remove LaTeX math delimiters ($, $$, \\( \\), \\[ \\]) and LaTeX macros — write math as plain text.
Close every unclosed code fence; remove stray or duplicated ``` markers.
Remove all emoji and decorative unicode symbols.
Remove flattering openers ("Great question!", "Certainly!", "Thanks for the context") — start with the substance.
Remove trailing offers of further help ("Let me know if…", "Would you like…", "Hope this helps!").
Remove meta-commentary about the prompt, the constraints, or the example itself."""


def build_topic_generation_prompt(
    category_name: str,
    category_description: str,
    count: int,
) -> list[dict[str, str]]:
    system = (
        "You are an expert dataset curator. "
        "Your task is to generate a list of highly specific, diverse, and non-overlapping topics "
        "that will be used to create training examples for an AI language model. "
        "Each topic must be self-contained and faithful to the Category Description — "
        "the description is the authoritative instruction for the style and framing of the topics "
        "(e.g., if the description indicates problem-posing, each topic should be phrased as a "
        "concrete problem to solve, not as a concept to explain)."
    )
    user = (
        f"Generate exactly {count} unique topics for the following category.\n\n"
        f"Category: {category_name}\n"
        f"Description: {category_description}\n\n"
        "Requirements:\n"
        "- Each topic must be specific and actionable (not vague like 'basics')\n"
        "- Topics must be diverse — avoid repetition in concept or phrasing\n"
        "- Write topics in the same language as the Category Description above\n"
        "- Output ONLY a valid JSON array of strings, no explanations, no markdown fences\n"
        '- Example format: ["Topic one here", "Topic two here", "Topic three here"]\n\n'
        "Output the JSON array now:"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def build_outline_generation_prompt(
    category_name: str,
    topic: str,
    category_description: str = "",
) -> list[dict[str, str]]:
    system = (
        "You are an expert dataset designer. "
        "Given a category description and a topic, produce a concise 2–4 point outline "
        "of what a training example on that topic should cover. "
        "The outline must match the style and format implied by the Category Description — "
        "for a problem-solving category, the points describe solution stages "
        "(problem framing, approach, implementation, complexity); "
        "for an explanatory category, the points describe concept stages."
    )
    desc_block = f"Category description: {category_description}\n" if category_description else ""
    user = (
        f"Create a brief outline for a training example on the following topic.\n\n"
        f"Category: {category_name}\n"
        f"{desc_block}"
        f"Topic: {topic}\n\n"
        "Requirements:\n"
        "- 2 to 4 bullet points maximum\n"
        "- Each point describes a key aspect to address, phrased consistently with the "
        "Category Description style\n"
        "- Output ONLY a valid JSON array of short strings\n"
        '- Example format: ["First aspect", "Second aspect", "Third aspect"]\n\n'
        "Output the JSON array now:"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def build_example_generation_prompt(
    category_name: str,
    topic: str,
    outline_points: list[str],
    output_format: Literal["sharegpt", "alpaca", "chatml"],
    max_tokens: int,
    conversation_turns: int = 2,
    category_description: str = "",
) -> list[dict[str, str]]:
    outline_text = "\n".join(f"- {p}" for p in outline_points)
    token_guideline = int(max_tokens * 0.70)
    format_instructions = _format_instructions(output_format, conversation_turns)

    system = (
        "You are an expert AI training data creator. "
        "You generate realistic, high-quality training examples "
        "that will be used to fine-tune language models. "
        "Your output must be valid JSON and nothing else — no markdown, no explanation.\n\n"
        "Critical rules:\n"
        "- The Category Description (when provided) is the AUTHORITATIVE instruction for the "
        "framing, style, and format of BOTH the user message(s) and the assistant response(s). "
        "Follow every constraint it states literally — including any like 'return only the solution', "
        "'no top-level print or usage demo', 'contest-style problem', 'reply with the function only'.\n"
        "- The user's first message style MUST match the Category Description. "
        "If the description indicates problem-posing (e.g., 'user poses a problem', "
        "'contest-style', 'user gives a signature and spec'), the user MUST state a concrete, "
        "self-contained problem directly. DO NOT open with 'Could you explain...', "
        "'How does X work?', 'I've been studying...', or any other tutorial/learner framing "
        "unless the description explicitly asks for it.\n"
        "- For technical topics (programming, code, frameworks, tools): assistant responses MUST "
        "include practical, working code snippets inside ```...``` fences.\n"
        "- Write the entire conversation (user and assistant messages) in the same language as "
        "the Topic. Do not switch languages mid-example."
    )
    desc_block = f"Category description: {category_description}\n" if category_description else ""
    user = (
        f"Generate ONE training example for fine-tuning a language model.\n\n"
        f"Category: {category_name}\n"
        f"{desc_block}"
        f"Topic: {topic}\n"
        f"Outline to cover:\n{outline_text}\n\n"
        f"Target length: approximately {token_guideline} tokens of combined content.\n"
        f"Format instructions:\n{format_instructions}\n\n"
        "Output ONLY the JSON object now:"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def _turns_description(turns: int, role: str) -> str:
    """Return a human-readable instruction for the required number of turns."""
    if turns == 1:
        return f"exactly 1 exchange (one {role} message and one assistant response)"
    if turns == 2:
        return f"exactly 2 exchanges (two {role} messages and two assistant responses)"
    return (
        f"exactly {turns} exchanges ({turns} {role} messages and {turns} assistant responses), "
        "maintaining coherent context throughout the conversation"
    )


def _coherence_rule(turns: int) -> str:
    """Extra coherence rule injected for conversations with 3+ turns."""
    if turns >= 3:
        return (
            "\n- Each turn must naturally follow from the previous context — "
            "do not repeat information already covered, do not introduce facts that contradict earlier turns"
        )
    return ""


def _format_instructions(fmt: Literal["sharegpt", "alpaca", "chatml"], turns: int = 2) -> str:
    if fmt == "sharegpt":
        total_entries = turns * 2
        return (
            f"Output format: ShareGPT multi-turn conversation with {_turns_description(turns, 'human')}.\n"
            "Schema:\n"
            '{\n'
            '  "conversations": [\n'
            '    {"from": "human", "value": "<user message 1>"},\n'
            '    {"from": "gpt",   "value": "<assistant reply 1>"},\n'
            '    {"from": "human", "value": "<user follow-up>"},\n'
            '    {"from": "gpt",   "value": "<assistant reply 2>"}\n'
            '  ]\n'
            '}\n'
            "Rules:\n"
            "- Must start with 'human' and alternate human/gpt\n"
            f"- The array must contain exactly {total_entries} entries ({turns} human + {turns} gpt)\n"
            "- Human messages form a natural, coherent dialogue\n"
            "- GPT replies are thorough, accurate, and educational"
            f"{_coherence_rule(turns)}"
        )
    if fmt == "alpaca":
        return (
            "Output format: Alpaca instruction-following.\n"
            "Schema:\n"
            '{\n'
            '  "instruction": "<clear task or question>",\n'
            '  "input": "",\n'
            '  "output": "<detailed, accurate answer>"\n'
            '}\n'
            "Rules:\n"
            '- "instruction" should be standalone and self-contained\n'
            '- "input" MUST be an empty string ""\n'
            '- "output" should be thorough and directly answer the instruction'
        )
    # chatml
    total_entries = turns * 2
    return (
        f"Output format: ChatML multi-turn conversation with {_turns_description(turns, 'user')}.\n"
        "Schema:\n"
        '{\n'
        '  "messages": [\n'
        '    {"role": "user",      "content": "<user message 1>"},\n'
        '    {"role": "assistant", "content": "<assistant reply 1>"},\n'
        '    {"role": "user",      "content": "<user follow-up>"},\n'
        '    {"role": "assistant", "content": "<assistant reply 2>"}\n'
        '  ]\n'
        '}\n'
        "Rules:\n"
        "- Must start with role 'user' and alternate user/assistant\n"
        f"- The array must contain exactly {total_entries} entries ({turns} user + {turns} assistant)\n"
        "- Assistant replies are detailed and educationally valuable"
        f"{_coherence_rule(turns)}"
    )


# ---------------------------------------------------------------------------
# Cleanup stage
# ---------------------------------------------------------------------------

# max_tokens for a cleanup call is derived from the payload, not from the job
# config: the task is delete-only, so the output is at most about as long as
# the input. Since cleanup runs one slot per request, the payload is a single
# text — the budget scales down with it on its own. The ratio leaves room for
# tokenizer drift, the headroom for a reasoning block before the answer.
CLEANUP_TOKEN_RATIO = 2.0
CLEANUP_TOKEN_HEADROOM = 2048
CLEANUP_MIN_TOKENS = 2048

_FORMAT_LABELS: dict[str, str] = {
    "sharegpt": "ShareGPT",
    "alpaca": "Alpaca",
    "chatml": "ChatML",
}


def build_cleanup_prompt(
    slots: Sequence["TextSlot"],
    cleanup_rules: str,
    fmt: Literal["sharegpt", "alpaca", "chatml"],
    full_example: dict[str, Any],
) -> list[dict[str, str]]:
    """LEGACY batch variant: N texts in, one JSON array of N cleaned texts out.

    Superseded by ``build_cleanup_slot_prompt``, which asks for one text per
    request and takes JSON out of the loop entirely. Measured on gemma-4-E4B,
    this prompt breaks down on long examples: the model has to keep a single
    JSON array of several long strings — code, quotes, escaped newlines —
    syntactically intact, and a 4-slot ShareGPT example produced 8871 valid
    characters and then closed the array as `"}]`, with ``finish_reason:
    stop``. It is not truncation, so a larger budget does not help; the longer
    the example, the likelier the corruption. Kept for compatibility and for
    the tests that pin the old contract — not used by the pipeline.

    The model never sees the example's structure as something it may edit —
    it gets a flat, numbered list of texts and must return a JSON array of the
    same length in the same order. `full_example` is passed as read-only
    context so the model can tell a user turn from an assistant turn and keep
    references between turns intact.

    `cleanup_rules` is injected verbatim (one rule per line) — it is the only
    user-authored part of the prompt and defines what counts as a defect.
    """
    n = len(slots)
    format_label = _FORMAT_LABELS.get(fmt, fmt)
    rules = cleanup_rules.strip() or DEFAULT_CLEANUP_RULES

    system = (
        "You are a format normalizer, not an editor.\n\n"
        "You do NOT rewrite, rephrase, translate, summarize, expand, improve, or answer "
        "anything. You only DELETE offending fragments or minimally reformat them.\n"
        "Preserve every code block byte-for-byte. The only permitted change to code is "
        "closing an unclosed fence.\n"
        "Preserve all facts, numbers, identifiers, ordering and paragraph structure.\n"
        "Preserve the original language of every text.\n"
        "If a text already conforms to the rules, return it verbatim, character for "
        "character.\n\n"
        f"Rules:\n{rules}\n\n"
        "Output contract:\n"
        f"- Return ONLY a JSON array of exactly {n} strings — no markdown fences, no "
        "commentary, no object wrapper.\n"
        f"- Entry i of the array is the cleaned version of input text [i], for all "
        f"{n} texts, in the same order.\n"
        "- Never merge, split, drop or reorder entries; an empty string is never a "
        "valid entry.\n"
        '- Format: ["cleaned text 1", "cleaned text 2", ...]'
    )

    numbered = "\n\n".join(
        f"[{slot.index}] ({slot.role or 'text'}):\n{slot.text}" for slot in slots
    )
    user = (
        f"Output format of this example: {format_label}.\n\n"
        "Full example, for context only — do NOT return it:\n"
        f"{json.dumps(full_example, ensure_ascii=False)}\n\n"
        f"Texts to clean ({n} in total):\n\n"
        f"{numbered}\n\n"
        f"Return a JSON array of exactly {n} cleaned string(s), in the same order as "
        "the numbered texts above. Output the JSON array now:"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


# Markers around the single text handed to the model. Explicit boundaries keep
# a text that itself ends in a code fence or a quote from bleeding into the
# instructions, and give the model an unambiguous answer to "where does the
# text I must return start?".
CLEANUP_TEXT_START = "--- TEXT START ---"
CLEANUP_TEXT_END = "--- TEXT END ---"


def build_cleanup_slot_prompt(
    slot: "TextSlot",
    cleanup_rules: str,
    fmt: Literal["sharegpt", "alpaca", "chatml"],
    full_example: dict[str, Any],
) -> list[dict[str, str]]:
    """Build the cleanup-stage prompt for ONE text: text in, plain text out.

    The reply *is* the result — no JSON array, no quoting, no escaping — so
    there is nothing left for the model to corrupt structurally. Everything
    the batch variant got wrong on long examples (see ``build_cleanup_prompt``)
    disappears with the array; the caller only has to strip the wrappers a
    chatty model may add (``cleanup_service.clean_slot_response``).

    `full_example` is still passed as read-only context so the model can tell
    a user turn from an assistant turn and keep references between turns
    intact; `slot` marks which of those texts it must actually return.

    `cleanup_rules` is injected verbatim (one rule per line) — it is the only
    user-authored part of the prompt and defines what counts as a defect.
    """
    format_label = _FORMAT_LABELS.get(fmt, fmt)
    rules = cleanup_rules.strip() or DEFAULT_CLEANUP_RULES
    role = slot.role or "text"

    system = (
        "You are a format normalizer, not an editor.\n\n"
        "You do NOT rewrite, rephrase, translate, summarize, expand, improve, or answer "
        "anything. You only DELETE offending fragments or minimally reformat them.\n"
        "Preserve every code block byte-for-byte. The only permitted change to code is "
        "closing an unclosed fence.\n"
        "Preserve all facts, numbers, identifiers, ordering and paragraph structure.\n"
        "Preserve the original language of the text.\n\n"
        f"Rules:\n{rules}\n\n"
        "Output contract:\n"
        "- Return ONLY the cleaned text. No JSON, no quotes around it, no markdown "
        "fence, no commentary, no preamble.\n"
        "- Your entire answer is used as the text, character for character.\n"
        "- Return exactly one text: the one marked below, never the other texts of "
        "the example and never its JSON structure.\n"
        "- If the text already conforms, return it verbatim, character for character."
    )

    user = (
        f"Output format of this example: {format_label}.\n\n"
        "Full example, for context only — do NOT return it:\n"
        f"{json.dumps(full_example, ensure_ascii=False)}\n\n"
        f"Clean the {role} text below (text {slot.index} of the example). It is "
        "everything between the two marker lines; the markers themselves are not "
        "part of it.\n"
        f"{CLEANUP_TEXT_START}\n"
        f"{slot.text}\n"
        f"{CLEANUP_TEXT_END}\n\n"
        "Output the cleaned text now, as plain text:"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def cleanup_max_tokens(slot_text: str, config_max_tokens: int) -> int:
    """Token budget for one cleanup call, derived from the payload.

    ``max(count_tokens(joined) * 2 + 2048, 2048)`` — deliberately generous and
    **not** capped by the job's own `max_tokens`.

    Two reasons. First, a reasoning model spends the same completion budget on
    its thinking block as on the answer; measured on gemma-4-E4B a ~110-token
    reply came with ~314 tokens of reasoning, and Unsloth reports
    ``reasoning_tokens: 0`` so the cost is invisible in usage. A tight budget
    truncates the answer and the slot is reverted for nothing. Second, this
    budget has nothing to guard: cleanup only echoes back text that already
    exists, and over-long examples are rejected earlier, at generation time.

    ``slot_text`` is the text of a *single* slot — one call cleans one text.
    """
    return max(
        int(count_tokens(slot_text) * CLEANUP_TOKEN_RATIO) + CLEANUP_TOKEN_HEADROOM,
        CLEANUP_MIN_TOKENS,
    )
