from __future__ import annotations

from typing import Literal


def build_topic_generation_prompt(
    category_name: str,
    category_description: str,
    count: int,
) -> list[dict[str, str]]:
    system = (
        "You are an expert dataset curator. "
        "Your task is to generate a list of highly specific, diverse, and non-overlapping topics "
        "that will be used to create training examples for an AI language model. "
        "Each topic must be self-contained and lead naturally to a meaningful instructional conversation."
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
) -> list[dict[str, str]]:
    system = (
        "You are an expert instructional designer. "
        "Given a topic, produce a concise 2–4 point outline of what a high-quality "
        "question-and-answer training example on that topic should cover."
    )
    user = (
        f"Create a brief outline for a training example on the following topic.\n\n"
        f"Category: {category_name}\n"
        f"Topic: {topic}\n\n"
        "Requirements:\n"
        "- 2 to 4 bullet points maximum\n"
        "- Each point describes a key aspect or subtopic to address in the example\n"
        "- Output ONLY a valid JSON array of short strings\n"
        '- Example format: ["Explain concept X", "Show a practical example", "Mention common pitfall"]\n\n'
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
) -> list[dict[str, str]]:
    outline_text = "\n".join(f"- {p}" for p in outline_points)
    token_guideline = int(max_tokens * 0.70)
    format_instructions = _format_instructions(output_format, conversation_turns)

    system = (
        "You are an expert AI training data creator. "
        "You generate realistic, high-quality question-and-answer pairs or multi-turn "
        "conversations that will be used to fine-tune language models. "
        "Your output must be valid JSON and nothing else — no markdown, no explanation.\n\n"
        "Critical rules:\n"
        "- For technical topics (programming, code, frameworks, tools): assistant responses MUST "
        "include practical, working code snippets. Code goes inside the conversation content as "
        "plain text with inline formatting (e.g. ```python ... ```).\n"
        "- Write the entire conversation (user and assistant messages) in the same language as "
        "the Topic. Do not switch languages mid-example.\n"
        "- Make the user's question realistic — something a real developer would actually ask."
    )
    user = (
        f"Generate ONE training example for fine-tuning a language model.\n\n"
        f"Category: {category_name}\n"
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
