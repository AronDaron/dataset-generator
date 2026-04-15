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

CREATE_INDEX_EXAMPLES_JOB_ID = "CREATE INDEX IF NOT EXISTS idx_examples_job_id ON examples(job_id);"
CREATE_INDEX_EXAMPLES_JOB_CREATED = "CREATE INDEX IF NOT EXISTS idx_examples_job_created ON examples(job_id, created_at);"
CREATE_INDEX_JOBS_CREATED = "CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);"

ALL_MIGRATIONS = [CREATE_SETTINGS, CREATE_JOBS, CREATE_EXAMPLES,
                  CREATE_INDEX_EXAMPLES_JOB_ID, CREATE_INDEX_EXAMPLES_JOB_CREATED, CREATE_INDEX_JOBS_CREATED]


async def run_migrations(db: aiosqlite.Connection) -> None:
    for stmt in ALL_MIGRATIONS:
        await db.execute(stmt)
    try:
        await db.execute("ALTER TABLE jobs ADD COLUMN progress_json TEXT")
    except Exception as e:
        if "duplicate column name" not in str(e).lower():
            raise
    try:
        await db.execute("ALTER TABLE examples ADD COLUMN judge_score INTEGER")
    except Exception as e:
        if "duplicate column name" not in str(e).lower():
            raise
    for col in [
        "prompt_tokens INTEGER NOT NULL DEFAULT 0",
        "completion_tokens INTEGER NOT NULL DEFAULT 0",
        "model TEXT NOT NULL DEFAULT ''",
        "judge_prompt_tokens INTEGER NOT NULL DEFAULT 0",
        "judge_completion_tokens INTEGER NOT NULL DEFAULT 0",
    ]:
        try:
            await db.execute(f"ALTER TABLE examples ADD COLUMN {col}")
        except Exception as e:
            if "duplicate column name" not in str(e).lower():
                raise
    await db.commit()
