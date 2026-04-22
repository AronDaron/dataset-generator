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
    # Cap the WAL file size so a crash / force-kill (no graceful close) can't
    # leave behind a multi-GB WAL that makes subsequent queries crawl. 64 MB
    # is large enough that normal operation never hits the limit, but small
    # enough that recovery scans stay snappy.
    await _db.execute("PRAGMA journal_size_limit = 67108864")
    await run_migrations(_db)
    # Mark ghost jobs (left running from a previous server session) as interrupted
    # — they can be resumed via POST /api/jobs/{id}/resume.
    await _db.execute(
        "UPDATE jobs SET status = 'interrupted' WHERE status IN ('pending', 'running', 'cancelling')"
    )
    await _db.commit()
    # Self-heal: if the last shutdown wasn't graceful (power loss, SIGKILL,
    # uvicorn --reload tearing a task mid-transaction), the WAL file may hold
    # committed pages that were never checkpointed into the main db file.
    # Running a TRUNCATE checkpoint here merges those pages and truncates the
    # WAL to zero — the next query is cheap instead of walking a giant log.
    try:
        await _db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except Exception:
        logger.exception("Startup WAL checkpoint failed (non-fatal)")

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
