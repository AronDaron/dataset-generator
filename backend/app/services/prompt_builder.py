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
) -> list[dict[str, str]]:
    outline_text = "\n".join(f"- {p}" for p in outline_points)
    token_guideline = int(max_tokens * 0.70)
    format_instructions = _format_instructions(output_format)

    system = (
        "You are an expert AI training data creator. "
        "You generate realistic, high-quality question-and-answer pairs or multi-turn "
        "conversations that will be used to fine-tune language models. "
        "Your output must be valid JSON and nothing else — no markdown, no explanation."
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


def _format_instructions(fmt: Literal["sharegpt", "alpaca", "chatml"]) -> str:
    if fmt == "sharegpt":
        return (
            "Output format: ShareGPT multi-turn conversation with 2-3 exchanges.\n"
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
            "- 2 to 3 human turns (4-6 total entries)\n"
            "- Human messages form a natural, coherent dialogue\n"
            "- GPT replies are thorough, accurate, and educational"
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
    return (
        "Output format: ChatML multi-turn conversation with 2-3 exchanges.\n"
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
        "- 2 to 3 user turns\n"
        "- Assistant replies are detailed and educationally valuable"
    )
