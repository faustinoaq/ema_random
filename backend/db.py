from __future__ import annotations

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "study.db"


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = get_conn()
    cur = conn.cursor()

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS participants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
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
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            participant_id INTEGER UNIQUE,
            comments TEXT NOT NULL DEFAULT '',
            start_date TEXT NOT NULL,
            end_date TEXT NOT NULL,
            prompts_per_day INTEGER NOT NULL DEFAULT 4,
            windows_json TEXT NOT NULL DEFAULT '[]',
            FOREIGN KEY (participant_id) REFERENCES participants (id)
        )
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS prompts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            participant_id INTEGER NOT NULL,
            window_index INTEGER,
            scheduled_time TEXT NOT NULL,
            sent_time TEXT,
            status TEXT NOT NULL DEFAULT 'scheduled',
            survey_link TEXT,
            FOREIGN KEY (participant_id) REFERENCES participants (id)
        )
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
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

    # Lightweight migration for existing DBs.
    try:
        cur.execute("ALTER TABLE prompts ADD COLUMN window_index INTEGER")
    except sqlite3.OperationalError:
        pass

    try:
        cur.execute("ALTER TABLE studies ADD COLUMN participant_id INTEGER")
    except sqlite3.OperationalError:
        pass

    try:
        cur.execute("ALTER TABLE participants ADD COLUMN participant_id TEXT")
    except sqlite3.OperationalError:
        pass

    try:
        cur.execute("ALTER TABLE studies ADD COLUMN comments TEXT NOT NULL DEFAULT ''")
    except sqlite3.OperationalError:
        pass

    participant_cols = {
        row[1] for row in cur.execute("PRAGMA table_info(participants)").fetchall()
    }
    if "name" in participant_cols:
        cur.execute(
            """
            UPDATE participants
            SET participant_id = COALESCE(participant_id, name, ('P-' || id))
            WHERE participant_id IS NULL OR participant_id = ''
            """
        )
    else:
        cur.execute(
            """
            UPDATE participants
            SET participant_id = COALESCE(participant_id, ('P-' || id))
            WHERE participant_id IS NULL OR participant_id = ''
            """
        )

    cur.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_participant_code
        ON participants(participant_id)
        WHERE participant_id IS NOT NULL
        """
    )

    cur.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_study_participant
        ON studies(participant_id)
        WHERE participant_id IS NOT NULL
        """
    )

    conn.commit()
    conn.close()
