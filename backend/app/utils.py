from datetime import datetime, timezone

import aiosqlite
from fastapi import HTTPException


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


async def get_api_key(db: aiosqlite.Connection) -> str:
    """Read the OpenRouter key out of the providers table.

    Pre-v6 the key lived in `settings.openrouter_api_key`. The migration moves
    it into a `providers` row keyed `openrouter-default`; this helper preserves
    the legacy call shape so settings.py / openrouter.py shims still work.
    """
    async with await db.execute(
        "SELECT api_key FROM providers WHERE id = 'openrouter-default'"
    ) as cursor:
        row = await cursor.fetchone()
    if not row or not row["api_key"]:
        raise HTTPException(status_code=422, detail="OpenRouter API key not configured")
    return row["api_key"]
