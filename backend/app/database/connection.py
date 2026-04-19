import logging

import aiosqlite
from app.config import settings
from app.database.migrations import run_migrations

logger = logging.getLogger(__name__)

_db: aiosqlite.Connection | None = None


async def init_db() -> None:
    global _db
    _db = await aiosqlite.connect(str(settings.db_path))
    _db.row_factory = aiosqlite.Row
    await _db.execute("PRAGMA foreign_keys = ON")
    await _db.execute("PRAGMA journal_mode = WAL")
    await _db.execute("PRAGMA synchronous = NORMAL")
    await run_migrations(_db)
    # Mark ghost jobs (left running from a previous server session) as interrupted
    # — they can be resumed via POST /api/jobs/{id}/resume.
    await _db.execute(
        "UPDATE jobs SET status = 'interrupted' WHERE status IN ('pending', 'running', 'cancelling')"
    )
    await _db.commit()

    # Remove orphaned JSONL files — files in datasets_dir with no matching job in DB.
    datasets_dir = settings.datasets_dir
    if datasets_dir.exists():
        async with await _db.execute("SELECT id FROM jobs") as cursor:
            known_ids = {row[0] for row in await cursor.fetchall()}
        removed = 0
        for f in datasets_dir.glob("*.jsonl"):
            if f.stem not in known_ids:
                try:
                    f.unlink()
                    removed += 1
                except Exception:
                    logger.exception("Failed to remove orphaned file: %s", f)
        if removed:
            logger.info("Removed %d orphaned JSONL file(s) from %s", removed, datasets_dir)


async def close_db() -> None:
    global _db
    if _db:
        await _db.close()
        _db = None


async def get_db() -> aiosqlite.Connection:
    if _db is None:
        raise RuntimeError("Database not initialized")
    return _db
