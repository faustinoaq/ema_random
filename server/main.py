from __future__ import annotations

import json
import random
import os
import secrets
import time
from datetime import date, datetime, timedelta
from pathlib import Path

from apscheduler.schedulers.background import BackgroundScheduler
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .db import get_conn, init_db
from .schemas import ParticipantIn, StudyIn

app = FastAPI(title="EMA Study Admin", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "ui"
load_dotenv(BASE_DIR / ".env")
scheduler = BackgroundScheduler()
AUTH_USERNAME = os.getenv("APP_AUTH_USERNAME", "admin")
AUTH_PASSWORD = os.getenv("APP_AUTH_PASSWORD", "admin")
SESSION_COOKIE_NAME = "ema_session"
ACTIVE_SESSIONS: set[str] = set()
LOGIN_DELAY_SECONDS = 1


class LoginPayload(BaseModel):
    username: str
    password: str


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    public_paths = {"/", "/api/auth/login", "/api/auth/status"}
    if request.url.path in public_paths or request.url.path.startswith("/static/"):
        return await call_next(request)

    if request.url.path.startswith("/api/"):
        session_token = request.cookies.get(SESSION_COOKIE_NAME, "")
        if session_token not in ACTIVE_SESSIONS:
            return JSONResponse(status_code=401, content={"detail": "Unauthorized"})

    return await call_next(request)


@app.post("/api/auth/login")
def login(payload: LoginPayload, response: Response):
    time.sleep(LOGIN_DELAY_SECONDS)
    if not (
        secrets.compare_digest(payload.username, AUTH_USERNAME)
        and secrets.compare_digest(payload.password, AUTH_PASSWORD)
    ):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = secrets.token_urlsafe(32)
    ACTIVE_SESSIONS.add(token)
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 12,
    )
    return {"ok": True}


@app.get("/api/auth/status")
def auth_status(request: Request):
    session_token = request.cookies.get(SESSION_COOKIE_NAME, "")
    return {"authenticated": session_token in ACTIVE_SESSIONS}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    session_token = request.cookies.get(SESSION_COOKIE_NAME, "")
    if session_token in ACTIVE_SESSIONS:
        ACTIVE_SESSIONS.discard(session_token)
    response.delete_cookie(SESSION_COOKIE_NAME)
    return {"ok": True}


def log_event(event: str, details: str) -> None:
    conn = get_conn()
    conn.execute(
        "INSERT INTO logs (timestamp, event, details) VALUES (?, ?, ?)",
        (datetime.utcnow().isoformat(), event, details),
    )
    conn.commit()
    conn.close()


def random_time_first_30_minutes(start_hhmm: str, end_hhmm: str) -> datetime:
    today = date.today().isoformat()
    start_dt = datetime.fromisoformat(f"{today}T{start_hhmm}:00")
    end_dt = datetime.fromisoformat(f"{today}T{end_hhmm}:00")
    first_30_end = min(start_dt + timedelta(minutes=30), end_dt)
    delta = int((first_30_end - start_dt).total_seconds())
    if delta <= 0:
        return start_dt
    return start_dt.fromtimestamp(start_dt.timestamp() + random.randint(0, delta))


def validate_study_windows(payload: StudyIn) -> None:
    if len(payload.windows) < payload.prompts_per_day:
        raise HTTPException(
            status_code=400,
            detail="Number of windows must be at least prompts_per_day",
        )
    for idx, window in enumerate(payload.windows[: payload.prompts_per_day], start=1):
        if not str(window.link).strip():
            raise HTTPException(
                status_code=400,
                detail=f"Window {idx} link is required",
            )


def generate_daily_schedule() -> None:
    conn = get_conn()
    studies = conn.execute("SELECT * FROM studies ORDER BY id DESC").fetchall()
    if not studies:
        conn.close()
        return

    # Regenerate today's schedule by replacing only prompts not sent yet.
    conn.execute(
        """
        DELETE FROM prompts
        WHERE date(scheduled_time) = date('now') AND status != 'sent'
        """
    )

    total_scheduled = 0
    for study in studies:
        participant = conn.execute(
            "SELECT id FROM participants WHERE id = ? AND status = 'active'",
            (study["participant_id"],),
        ).fetchone()
        if not participant:
            continue

        windows = json.loads(study["windows_json"])
        if not windows:
            log_event("schedule_skipped", f"study_id={study['id']} has no windows")
            continue

        selected_windows = windows[: study["prompts_per_day"]]
        if len(selected_windows) < study["prompts_per_day"]:
            log_event("schedule_skipped", f"study_id={study['id']} has insufficient windows")
            continue
        daily_window_times = [
            random_time_first_30_minutes(w["start"], w["end"]).isoformat() for w in selected_windows
        ]

        for idx, window in enumerate(selected_windows):
            survey_link = (window.get("link") or "").strip()
            if not survey_link:
                log_event("schedule_skipped", f"study_id={study['id']} missing link for window {idx + 1}")
                continue
            conn.execute(
                """
                INSERT INTO prompts (participant_id, window_index, scheduled_time, status, survey_link)
                VALUES (?, ?, ?, 'scheduled', ?)
                """,
                (
                    participant["id"],
                    idx + 1,
                    daily_window_times[idx],
                    survey_link,
                ),
            )
            total_scheduled += 1
    conn.commit()
    conn.close()
    log_event("schedule_generated", f"Generated {total_scheduled} prompts")


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    scheduler.add_job(generate_daily_schedule, "cron", hour=0, minute=0, id="daily_generation")
    scheduler.start()


@app.on_event("shutdown")
def on_shutdown() -> None:
    if scheduler.running:
        scheduler.shutdown(wait=False)


@app.get("/api/participants")
def list_participants():
    conn = get_conn()
    rows = conn.execute("SELECT * FROM participants ORDER BY id DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/api/participants")
def create_participant(payload: ParticipantIn):
    conn = get_conn()
    try:
        cur = conn.execute(
            """
            INSERT INTO participants (participant_id, phone, redcap_record_id, status)
            VALUES (?, ?, ?, ?)
            """,
            (payload.participant_id, payload.phone, payload.redcap_record_id, payload.status),
        )
    except Exception:
        conn.close()
        raise HTTPException(status_code=400, detail="Participant ID must be unique")
    conn.commit()
    new_id = cur.lastrowid
    row = conn.execute("SELECT * FROM participants WHERE id = ?", (new_id,)).fetchone()
    conn.close()
    log_event("participant_created", f"id={new_id}")
    return dict(row)


@app.put("/api/participants/{participant_id}")
def update_participant(participant_id: int, payload: ParticipantIn):
    conn = get_conn()
    try:
        conn.execute(
            """
            UPDATE participants
            SET participant_id = ?, phone = ?, redcap_record_id = ?, status = ?
            WHERE id = ?
            """,
            (payload.participant_id, payload.phone, payload.redcap_record_id, payload.status, participant_id),
        )
    except Exception:
        conn.close()
        raise HTTPException(status_code=400, detail="Participant ID must be unique")
    conn.commit()
    row = conn.execute("SELECT * FROM participants WHERE id = ?", (participant_id,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Participant not found")
    log_event("participant_updated", f"id={participant_id}")
    return dict(row)


@app.delete("/api/participants/{participant_id}")
def delete_participant(participant_id: int):
    conn = get_conn()
    deleted = conn.execute("DELETE FROM participants WHERE id = ?", (participant_id,))
    conn.commit()
    conn.close()
    if deleted.rowcount == 0:
        raise HTTPException(status_code=404, detail="Participant not found")
    log_event("participant_deleted", f"id={participant_id}")
    return {"ok": True}


@app.get("/api/studies")
def list_studies():
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT s.*, p.participant_id AS participant_code
        FROM studies s
        LEFT JOIN participants p ON p.id = s.participant_id
        ORDER BY s.id DESC
        """
    ).fetchall()
    today_window_times = conn.execute(
        """
        SELECT
            participant_id,
            window_index,
            MIN(strftime('%H:%M', scheduled_time)) AS hhmm,
            MAX(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS is_sent
        FROM prompts
        WHERE date(scheduled_time) = date('now') AND window_index IS NOT NULL
        GROUP BY participant_id, window_index
        ORDER BY participant_id, window_index
        """
    ).fetchall()
    conn.close()
    today_time_by_key = {
        (r["participant_id"], r["window_index"]): {
            "time": r["hhmm"],
            "sent": bool(r["is_sent"]),
        }
        for r in today_window_times
    }
    output = []
    for row in rows:
        item = dict(row)
        item["windows"] = json.loads(item.pop("windows_json"))
        item["today_random_times"] = []
        for idx, _ in enumerate(item["windows"][: item["prompts_per_day"]], start=1):
            item["today_random_times"].append(
                today_time_by_key.get((item.get("participant_id"), idx), {"time": None, "sent": False})
            )
        output.append(item)
    return output


@app.post("/api/studies")
def create_study(payload: StudyIn):
    conn = get_conn()
    validate_study_windows(payload)
    participant = conn.execute("SELECT id FROM participants WHERE id = ?", (payload.participant_id,)).fetchone()
    if not participant:
        conn.close()
        raise HTTPException(status_code=400, detail="Participant not found")
    existing = conn.execute(
        "SELECT id FROM studies WHERE participant_id = ?",
        (payload.participant_id,),
    ).fetchone()
    if existing:
        conn.close()
        raise HTTPException(status_code=400, detail="This participant already has a study")
    cur = conn.execute(
        """
        INSERT INTO studies (participant_id, comments, start_date, end_date, prompts_per_day, windows_json)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            payload.participant_id,
            payload.comments,
            payload.start_date,
            payload.end_date,
            payload.prompts_per_day,
            json.dumps([{"start": w.start, "end": w.end, "link": str(w.link)} for w in payload.windows]),
        ),
    )
    conn.commit()
    new_id = cur.lastrowid
    row = conn.execute("SELECT * FROM studies WHERE id = ?", (new_id,)).fetchone()
    conn.close()
    log_event("study_created", f"id={new_id}")
    # New study should immediately receive today's generated random times.
    generate_daily_schedule()
    result = dict(row)
    result["windows"] = json.loads(result.pop("windows_json"))
    return result


@app.put("/api/studies/{study_id}")
def update_study(study_id: int, payload: StudyIn):
    conn = get_conn()
    validate_study_windows(payload)
    participant = conn.execute("SELECT id FROM participants WHERE id = ?", (payload.participant_id,)).fetchone()
    if not participant:
        conn.close()
        raise HTTPException(status_code=400, detail="Participant not found")
    existing = conn.execute(
        "SELECT id FROM studies WHERE participant_id = ? AND id != ?",
        (payload.participant_id, study_id),
    ).fetchone()
    if existing:
        conn.close()
        raise HTTPException(status_code=400, detail="This participant already has a study")
    updated = conn.execute(
        """
        UPDATE studies
        SET participant_id = ?, comments = ?, start_date = ?, end_date = ?, prompts_per_day = ?, windows_json = ?
        WHERE id = ?
        """,
        (
            payload.participant_id,
            payload.comments,
            payload.start_date,
            payload.end_date,
            payload.prompts_per_day,
            json.dumps([{"start": w.start, "end": w.end, "link": str(w.link)} for w in payload.windows]),
            study_id,
        ),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM studies WHERE id = ?", (study_id,)).fetchone()
    conn.close()
    if updated.rowcount == 0 or not row:
        raise HTTPException(status_code=404, detail="Study not found")
    log_event("study_updated", f"id={study_id}")
    result = dict(row)
    result["windows"] = json.loads(result.pop("windows_json"))
    return result


@app.delete("/api/studies/{study_id}")
def delete_study(study_id: int):
    conn = get_conn()
    deleted = conn.execute("DELETE FROM studies WHERE id = ?", (study_id,))
    conn.commit()
    conn.close()
    if deleted.rowcount == 0:
        raise HTTPException(status_code=404, detail="Study not found")
    log_event("study_deleted", f"id={study_id}")
    return {"ok": True}


@app.get("/api/logs")
def list_logs():
    conn = get_conn()
    rows = conn.execute("SELECT * FROM logs ORDER BY id DESC LIMIT 200").fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/api/scheduler/generate")
def manual_generate():
    generate_daily_schedule()
    return {"ok": True}


@app.get("/api/dashboard")
def dashboard():
    conn = get_conn()
    active_studies = conn.execute("SELECT COUNT(*) c FROM studies").fetchone()["c"]
    participants = conn.execute("SELECT COUNT(*) c FROM participants WHERE status='active'").fetchone()["c"]
    sent_today = conn.execute(
        """
        SELECT COUNT(*) c
        FROM prompts
        WHERE status='sent' AND date(sent_time) = date('now')
        """
    ).fetchone()["c"]
    total_prompts = conn.execute("SELECT COUNT(*) c FROM prompts").fetchone()["c"]
    sent_prompts = conn.execute("SELECT COUNT(*) c FROM prompts WHERE status='sent'").fetchone()["c"]
    conn.close()
    compliance = round((sent_prompts / total_prompts) * 100, 1) if total_prompts else 0.0
    return {
        "active_studies": active_studies,
        "participants_enrolled": participants,
        "messages_sent_today": sent_today,
        "compliance_percent": compliance,
    }


@app.get("/")
def root():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR / "static"), name="static")
