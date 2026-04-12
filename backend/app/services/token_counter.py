import tiktoken
from functools import lru_cache

ENCODING_NAME = "cl100k_base"
SAFETY_MARGIN = 0.10


@lru_cache(maxsize=1)
def _get_encoding() -> tiktoken.Encoding:
    return tiktoken.get_encoding(ENCODING_NAME)


def count_tokens(text: str) -> int:
    return len(_get_encoding().encode(text))


def effective_limit(max_tokens: int) -> int:
    """Returns token ceiling after applying 15% safety margin.

    Example: effective_limit(2048) == 1740
    """
    return int(max_tokens * (1 - SAFETY_MARGIN))


def fits_within_limit(text: str, max_tokens: int) -> bool:
    return count_tokens(text) <= effective_limit(max_tokens)
