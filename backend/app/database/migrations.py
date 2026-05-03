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

BASE_SCHEMA = [CREATE_SETTINGS, CREATE_JOBS, CREATE_EXAMPLES,
               CREATE_INDEX_EXAMPLES_JOB_ID, CREATE_INDEX_EXAMPLES_JOB_CREATED, CREATE_INDEX_JOBS_CREATED]

CREATE_SCHEMA_VERSION = """
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
);
"""


async def _migration_v1(db: aiosqlite.Connection) -> None:
    """Add progress_json to jobs."""
    await db.execute("ALTER TABLE jobs ADD COLUMN progress_json TEXT")


async def _migration_v2(db: aiosqlite.Connection) -> None:
    """Add judge_score to examples."""
    await db.execute("ALTER TABLE examples ADD COLUMN judge_score INTEGER")


async def _migration_v3(db: aiosqlite.Connection) -> None:
    """Add token tracking columns to examples."""
    for col in [
        "prompt_tokens INTEGER NOT NULL DEFAULT 0",
        "completion_tokens INTEGER NOT NULL DEFAULT 0",
        "model TEXT NOT NULL DEFAULT ''",
        "judge_prompt_tokens INTEGER NOT NULL DEFAULT 0",
        "judge_completion_tokens INTEGER NOT NULL DEFAULT 0",
    ]:
        await db.execute(f"ALTER TABLE examples ADD COLUMN {col}")


async def _migration_v4(db: aiosqlite.Connection) -> None:
    """Add category to examples."""
    await db.execute("ALTER TABLE examples ADD COLUMN category TEXT NOT NULL DEFAULT ''")


async def _migration_v5(db: aiosqlite.Connection) -> None:
    """Add stats_json snapshot to jobs for pre-computed Quality Report."""
    await db.execute("ALTER TABLE jobs ADD COLUMN stats_json TEXT")


async def _migration_v6(db: aiosqlite.Connection) -> None:
    """Introduce `providers` table and migrate the legacy single OpenRouter key.

    Pre-v6 the only LLM endpoint was OpenRouter, configured by a single row
    `settings.openrouter_api_key`. v6 turns that into a generic registry so
    the same job runner can target Ollama / LM Studio / any OpenAI-compatible
    backend without touching settings semantics.

    Backfill rules:
      * If a legacy openrouter_api_key exists → INSERT it as the default,
        enabled openrouter provider, then DELETE the old row.
      * If no legacy key → INSERT a disabled placeholder so UI has something
        to show and edit instead of an entirely empty providers list.
    """
    await db.execute(
        """
        CREATE TABLE IF NOT EXISTS providers (
            id          TEXT PRIMARY KEY,
            kind        TEXT NOT NULL,
            name        TEXT NOT NULL,
            base_url    TEXT NOT NULL,
            api_key     TEXT,
            enabled     INTEGER NOT NULL DEFAULT 1,
            is_default  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        )
        """
    )
    await db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_providers_default "
        "ON providers(is_default) WHERE is_default = 1"
    )

    async with await db.execute(
        "SELECT value FROM settings WHERE key = 'openrouter_api_key'"
    ) as cur:
        row = await cur.fetchone()
    legacy_key = row[0] if row else None

    await db.execute(
        """
        INSERT OR IGNORE INTO providers
            (id, kind, name, base_url, api_key, enabled, is_default)
        VALUES
            (?, 'openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', ?, ?, 1)
        """,
        ("openrouter-default", legacy_key, 1 if legacy_key else 0),
    )

    if legacy_key:
        await db.execute("DELETE FROM settings WHERE key = 'openrouter_api_key'")


async def _migration_v7(db: aiosqlite.Connection) -> None:
    """Invalidate cached Quality Report snapshots so token stats agree with
    the per-example `tokens` column (output only) instead of summing
    prompt+completion. Next stats fetch recomputes from examples.
    """
    await db.execute("UPDATE jobs SET stats_json = NULL WHERE stats_json IS NOT NULL")


VERSIONED_MIGRATIONS = [
    _migration_v1,
    _migration_v2,
    _migration_v3,
    _migration_v4,
    _migration_v5,
    _migration_v6,
    _migration_v7,
]


async def _detect_existing_schema(db: aiosqlite.Connection) -> int:
    """Detect how many migrations were already applied on a pre-versioning database.

    Returns the version number to seed schema_version with (0 if fresh DB).
    """
    try:
        async with await db.execute("PRAGMA table_info(examples)") as cur:
            columns = {row[1] for row in await cur.fetchall()}
    except Exception:
        return 0

    job_columns = await _get_job_columns(db)
    if "stats_json" in job_columns:
        return 5
    if "category" in columns:
        return 4
    if "prompt_tokens" in columns:
        return 3
    if "judge_score" in columns:
        return 2
    if "progress_json" in job_columns:
        return 1
    return 0


async def _get_job_columns(db: aiosqlite.Connection) -> set[str]:
    try:
        async with await db.execute("PRAGMA table_info(jobs)") as cur:
            return {row[1] for row in await cur.fetchall()}
    except Exception:
        return set()


async def run_migrations(db: aiosqlite.Connection) -> None:
    # 1. Base schema (idempotent — all use IF NOT EXISTS)
    for stmt in BASE_SCHEMA:
        await db.execute(stmt)

    # 2. Schema version table
    await db.execute(CREATE_SCHEMA_VERSION)

    # 3. Determine current version
    async with await db.execute("SELECT COALESCE(MAX(version), 0) FROM schema_version") as cur:
        current = (await cur.fetchone())[0]

    # 4. Seed version for pre-versioning databases
    if current == 0:
        detected = await _detect_existing_schema(db)
        if detected > 0:
            for v in range(1, detected + 1):
                await db.execute("INSERT OR IGNORE INTO schema_version VALUES (?)", (v,))
            current = detected

    # 5. Run pending migrations
    for version, migration in enumerate(VERSIONED_MIGRATIONS, 1):
        if version > current:
            await migration(db)
            await db.execute("INSERT INTO schema_version VALUES (?)", (version,))

    await db.commit()
