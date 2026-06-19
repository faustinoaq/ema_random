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
    if not cfg["host"]:
        raise RuntimeError("POSTGRESQL_SERVICE_HOST is not set")
    conn = psycopg.connect(**cfg, row_factory=dict_row)
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
            status TEXT NOT NULL DEFAULT 'active',
            wake_time TEXT NOT NULL DEFAULT '08:00'
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
            windows_json TEXT NOT NULL DEFAULT '[]'
        )
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
            survey_link TEXT
        )
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

    try:
        cur.execute("ALTER TABLE participants ADD COLUMN wake_time TEXT NOT NULL DEFAULT '08:00'")
    except Exception:
        pass

    conn.commit()
    conn.close()
