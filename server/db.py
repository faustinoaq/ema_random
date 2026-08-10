from __future__ import annotations

import os

import psycopg
from psycopg.rows import dict_row


def _db_config() -> dict[str, str]:
    host = os.getenv("POSTGRESQL_SERVICE_HOST", "")
    port = os.getenv("POSTGRESQL_SERVICE_PORT", "5432")
    return {
        "dbname": os.getenv("POSTGRESQL_DATABASE", ""),
        "user": os.getenv("POSTGRESQL_USER", ""),
        "password": os.getenv("POSTGRESQL_PASSWORD", ""),
        "host": host,
        "port": port,
    }


def get_conn() -> psycopg.Connection:
    cfg = _db_config()
    missing = [key for key in ("dbname", "user", "password", "host") if not cfg[key]]
    if missing:
        raise RuntimeError(
            "Database configuration is incomplete. Set POSTGRESQL_DATABASE, POSTGRESQL_USER, "
            "POSTGRESQL_PASSWORD, and POSTGRESQL_SERVICE_HOST."
        )
    try:
        conn = psycopg.connect(**cfg, row_factory=dict_row)
    except Exception as exc:
        raise RuntimeError(f"Could not connect to PostgreSQL: {exc}") from exc
    return conn


def init_db() -> None:
    conn = get_conn()
    cur = conn.cursor()

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS participants (
            id BIGSERIAL PRIMARY KEY,
            participant_id TEXT UNIQUE,
            phone TEXT NOT NULL,
            redcap_record_id TEXT,
            status TEXT NOT NULL DEFAULT 'active'
        )
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS studies (
            id BIGSERIAL PRIMARY KEY,
            participant_id BIGINT UNIQUE REFERENCES participants (id),
            comments TEXT NOT NULL DEFAULT '',
            start_date TEXT NOT NULL,
            end_date TEXT NOT NULL,
            prompts_per_day INTEGER NOT NULL DEFAULT 4,
            windows_json TEXT NOT NULL DEFAULT '[]',
            additional_surveys_json TEXT NOT NULL DEFAULT '[]'
        )
        """
    )

    cur.execute(
        """
        ALTER TABLE studies
        ADD COLUMN IF NOT EXISTS additional_surveys_json TEXT NOT NULL DEFAULT '[]'
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS prompts (
            id BIGSERIAL PRIMARY KEY,
            participant_id BIGINT NOT NULL REFERENCES participants (id),
            window_index INTEGER,
            scheduled_time TEXT NOT NULL,
            sent_time TEXT,
            status TEXT NOT NULL DEFAULT 'scheduled',
            retry_count INTEGER NOT NULL DEFAULT 0,
            survey_link TEXT
        )
        """
    )

    cur.execute(
        """
        ALTER TABLE prompts
        ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS logs (
            id BIGSERIAL PRIMARY KEY,
            timestamp TEXT NOT NULL,
            event TEXT NOT NULL,
            details TEXT NOT NULL
        )
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )

    conn.commit()
    conn.close()
