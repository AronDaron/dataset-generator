import aiosqlite

CREATE_SETTINGS = """
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
"""

CREATE_JOBS = """
CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    status      TEXT NOT NULL DEFAULT 'pending',
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
"""

CREATE_EXAMPLES = """
CREATE TABLE IF NOT EXISTS examples (
    id           TEXT PRIMARY KEY,
    job_id       TEXT NOT NULL REFERENCES jobs(id),
    content_json TEXT NOT NULL DEFAULT '{}',
    format       TEXT NOT NULL DEFAULT 'sharegpt',
    tokens       INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
"""

ALL_MIGRATIONS = [CREATE_SETTINGS, CREATE_JOBS, CREATE_EXAMPLES]


async def run_migrations(db: aiosqlite.Connection) -> None:
    for stmt in ALL_MIGRATIONS:
        await db.execute(stmt)
    try:
        await db.execute("ALTER TABLE jobs ADD COLUMN progress_json TEXT")
    except Exception:
        pass  # column already exists
    try:
        await db.execute("ALTER TABLE examples ADD COLUMN judge_score INTEGER")
    except Exception:
        pass  # column already exists
    await db.commit()
