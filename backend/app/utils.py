from datetime import datetime, timezone

import aiosqlite
from fastapi import HTTPException


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


async def get_api_key(db: aiosqlite.Connection) -> str:
    async with await db.execute(
        "SELECT value FROM settings WHERE key = 'openrouter_api_key'"
    ) as cursor:
        row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=422, detail="OpenRouter API key not configured")
    return row["value"]
