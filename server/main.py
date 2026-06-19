from __future__ import annotations

import json
import hashlib
import random
import os
import secrets
import time
import threading
import base64
import urllib.parse
import urllib.request
import time as time_module
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

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
APP_TIMEZONE = os.getenv("APP_TIMEZONE", "America/New_York")
LOCAL_TZ = ZoneInfo(APP_TIMEZONE)
os.environ.setdefault("TZ", APP_TIMEZONE)
if hasattr(time_module, "tzset"):
    time_module.tzset()
scheduler = BackgroundScheduler()
AUTH_USERNAME = os.getenv("APP_AUTH_USERNAME", "admin")
AUTH_PASSWORD_HASH = os.getenv("APP_AUTH_PASSWORD_HASH")
AUTH_PASSWORD = os.getenv("APP_AUTH_PASSWORD", "admin")
print(f"Using auth username: {AUTH_USERNAME}")
print(f"Using auth password hash: {AUTH_PASSWORD_HASH}")
if not AUTH_PASSWORD_HASH:
    AUTH_PASSWORD_HASH = hashlib.sha256(AUTH_PASSWORD.encode("utf-8")).hexdigest()
SESSION_COOKIE_NAME = "ema_session"
ACTIVE_SESSIONS: set[str] = set()
LOGIN_DELAY_SECONDS = 3
LOGIN_MIN_INTERVAL_SECONDS = 5
LOGIN_ATTEMPT_LOCK = threading.Lock()
LAST_LOGIN_ATTEMPT_BY_IP: dict[str, float] = {}
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_FROM_NUMBER = os.getenv("TWILIO_FROM_NUMBER", "")
TWILIO_MESSAGING_SERVICE_SID = os.getenv("TWILIO_MESSAGING_SERVICE_SID", "")


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
def login(payload: LoginPayload, request: Request, response: Response):
    client_ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    last_attempt = LAST_LOGIN_ATTEMPT_BY_IP.get(client_ip, 0.0)
    if now - last_attempt < LOGIN_MIN_INTERVAL_SECONDS:
        retry_after = max(1, int(LOGIN_MIN_INTERVAL_SECONDS - (now - last_attempt)))
        raise HTTPException(
            status_code=429,
            detail="Too many login attempts. Please wait and try again.",
            headers={"Retry-After": str(retry_after)},
        )

    if not LOGIN_ATTEMPT_LOCK.acquire(blocking=False):
        raise HTTPException(
            status_code=429,
            detail="Login already in progress. Please wait and try again.",
        )

    LAST_LOGIN_ATTEMPT_BY_IP[client_ip] = now
    try:
        time.sleep(LOGIN_DELAY_SECONDS)
        provided_password_hash = hashlib.sha256(payload.password.encode("utf-8")).hexdigest()
        print(f"Login attempt from {client_ip} with username '{payload.username}' and password hash '{provided_password_hash}'")
        print(f"Expected username: '{AUTH_USERNAME}' and password hash: '{AUTH_PASSWORD_HASH}'")
        if not secrets.compare_digest(payload.username, AUTH_USERNAME) or not secrets.compare_digest(
            provided_password_hash, AUTH_PASSWORD_HASH
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
    finally:
        LOGIN_ATTEMPT_LOCK.release()


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
        "INSERT INTO logs (timestamp, event, details) VALUES (%s, %s, %s)",
        (datetime.now(LOCAL_TZ).isoformat(), event, details),
    )
    conn.commit()
    conn.close()


def send_sms_message(to_number: str, body: str) -> None:
    if not TWILIO_ACCOUNT_SID or not TWILIO_AUTH_TOKEN:
        raise HTTPException(status_code=400, detail="Twilio credentials are not configured")
    if not TWILIO_FROM_NUMBER and not TWILIO_MESSAGING_SERVICE_SID:
        raise HTTPException(status_code=400, detail="Twilio sender is not configured")

    url = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json"
    payload = {"To": to_number, "Body": body}
    if TWILIO_MESSAGING_SERVICE_SID:
        payload["MessagingServiceSid"] = TWILIO_MESSAGING_SERVICE_SID
    else:
        payload["From"] = TWILIO_FROM_NUMBER

    data = urllib.parse.urlencode(payload).encode("utf-8")
    auth = base64.b64encode(f"{TWILIO_ACCOUNT_SID}:{TWILIO_AUTH_TOKEN}".encode("utf-8")).decode("ascii")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        if res.status >= 300:
            raise HTTPException(status_code=502, detail="Twilio SMS send failed")


def random_time_first_30_minutes(start_hhmm: str, end_hhmm: str) -> datetime:
    today = datetime.now(LOCAL_TZ).date().isoformat()
    start_dt = datetime.fromisoformat(f"{today}T{start_hhmm}:00")
    end_dt = datetime.fromisoformat(f"{today}T{end_hhmm}:00")
    first_30_end = min(start_dt + timedelta(minutes=30), end_dt)
    delta = int((first_30_end - start_dt).total_seconds())
    if delta <= 0:
        return start_dt
    return start_dt.fromtimestamp(start_dt.timestamp() + random.randint(0, delta))


def random_time_first_30_minutes_for_day(day: date, start_hhmm: str, end_hhmm: str) -> datetime:
    day_str = day.isoformat()
    start_dt = datetime.fromisoformat(f"{day_str}T{start_hhmm}:00")
    end_dt = datetime.fromisoformat(f"{day_str}T{end_hhmm}:00")
    first_30_end = min(start_dt + timedelta(minutes=30), end_dt)
    delta = int((first_30_end - start_dt).total_seconds())
    if delta <= 0:
        return start_dt
    return start_dt.fromtimestamp(start_dt.timestamp() + random.randint(0, delta))


def adjust_windows_for_wake_time(windows: list[dict], wake_time_hhmm: str) -> list[dict]:
    if not windows or not wake_time_hhmm:
        return windows
    try:
        base_start = datetime.fromisoformat(f"2000-01-01T{windows[0]['start']}:00")
        wake_start = datetime.fromisoformat(f"2000-01-01T{wake_time_hhmm}:00")
    except ValueError:
        return windows
    offset = wake_start - base_start
    adjusted_windows: list[dict] = []
    for window in windows:
        try:
            start_dt = datetime.fromisoformat(f"2000-01-01T{window['start']}:00") + offset
            end_dt = datetime.fromisoformat(f"2000-01-01T{window['end']}:00") + offset
        except ValueError:
            continue
        adjusted_windows.append(
            {
                "start": start_dt.strftime("%H:%M"),
                "end": end_dt.strftime("%H:%M"),
                "link": window.get("link"),
            }
        )
    return adjusted_windows


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


def study_date_range(study_row) -> list[date]:
    start = date.fromisoformat(study_row["start_date"])
    end = date.fromisoformat(study_row["end_date"])
    if end < start:
        return []
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


def regenerate_study_schedule(conn, study_row, overwrite_unsent: bool = True) -> int:
    participant = conn.execute(
        "SELECT id, wake_time FROM participants WHERE id = %s AND status = 'active'",
        (study_row["participant_id"],),
    ).fetchone()
    if not participant:
        return 0

    windows = json.loads(study_row["windows_json"])
    windows = adjust_windows_for_wake_time(windows, participant.get("wake_time", "08:00"))
    if not windows:
        log_event("schedule_skipped", f"study_id={study_row['id']} has no windows")
        return 0

    selected_windows = windows[: study_row["prompts_per_day"]]
    if len(selected_windows) < study_row["prompts_per_day"]:
        log_event("schedule_skipped", f"study_id={study_row['id']} has insufficient windows")
        return 0

    days = study_date_range(study_row)
    if not days:
        log_event("schedule_skipped", f"study_id={study_row['id']} has invalid date range")
        return 0

    scheduled_count = 0
    for day in days:
        if overwrite_unsent:
            conn.execute(
                """
                DELETE FROM prompts
                WHERE participant_id = %s
                  AND scheduled_time::date = %s
                  AND status != 'sent'
                """,
                (participant["id"], day.isoformat()),
            )

        for idx, window in enumerate(selected_windows):
            survey_link = (window.get("link") or "").strip()
            if not survey_link:
                log_event("schedule_skipped", f"study_id={study_row['id']} missing link for window {idx + 1}")
                continue

            if not overwrite_unsent:
                existing = conn.execute(
                    """
                    SELECT id FROM prompts
                    WHERE participant_id = %s AND window_index = %s AND scheduled_time::date = %s
                    LIMIT 1
                    """,
                    (participant["id"], idx + 1, day.isoformat()),
                ).fetchone()
                if existing:
                    continue

            scheduled_dt = random_time_first_30_minutes_for_day(day, window["start"], window["end"]).isoformat()
            conn.execute(
                """
                INSERT INTO prompts (participant_id, window_index, scheduled_time, status, survey_link)
                VALUES (%s, %s, %s, 'scheduled', %s)
                """,
                (participant["id"], idx + 1, scheduled_dt, survey_link),
            )
            scheduled_count += 1

    return scheduled_count


def generate_daily_schedule() -> None:
    # Cron job: only top-up missing prompts, do not overwrite existing.
    conn = get_conn()
    studies = conn.execute("SELECT * FROM studies ORDER BY id DESC").fetchall()
    if not studies:
        conn.close()
        return
    total_scheduled = 0
    for study in studies:
        total_scheduled += regenerate_study_schedule(conn, study, overwrite_unsent=False)
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
            INSERT INTO participants (participant_id, phone, redcap_record_id, status, wake_time)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id
            """,
            (payload.participant_id, payload.phone, payload.redcap_record_id, payload.status, payload.wake_time),
        )
    except Exception:
        conn.close()
        raise HTTPException(status_code=400, detail="Participant ID must be unique")
    conn.commit()
    new_id = cur.fetchone()["id"]
    row = conn.execute("SELECT * FROM participants WHERE id = %s", (new_id,)).fetchone()
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
            SET participant_id = %s, phone = %s, redcap_record_id = %s, status = %s, wake_time = %s
            WHERE id = %s
            """,
            (payload.participant_id, payload.phone, payload.redcap_record_id, payload.status, payload.wake_time, participant_id),
        )
    except Exception:
        conn.close()
        raise HTTPException(status_code=400, detail="Participant ID must be unique")
    conn.commit()
    row = conn.execute("SELECT * FROM participants WHERE id = %s", (participant_id,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Participant not found")
    log_event("participant_updated", f"id={participant_id}")
    return dict(row)


@app.delete("/api/participants/{participant_id}")
def delete_participant(participant_id: int):
    conn = get_conn()
    deleted = conn.execute("DELETE FROM participants WHERE id = %s", (participant_id,))
    conn.commit()
    conn.close()
    if deleted.rowcount == 0:
        raise HTTPException(status_code=404, detail="Participant not found")
    log_event("participant_deleted", f"id={participant_id}")
    return {"ok": True}


class SmsPayload(BaseModel):
    body: str


@app.post("/api/participants/{participant_id}/sms")
def send_participant_sms(participant_id: int, payload: SmsPayload):
    conn = get_conn()
    row = conn.execute(
        "SELECT participant_id, phone FROM participants WHERE id = %s",
        (participant_id,),
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Participant not found")
    message_body = payload.body.strip()
    if not message_body:
        raise HTTPException(status_code=400, detail="Message body is required")
    send_sms_message(row["phone"], message_body)
    log_event("sms_sent", f"participant_id={participant_id}")
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
    output = []
    for row in rows:
        item = dict(row)
        item["windows"] = json.loads(item.pop("windows_json"))
        schedules = conn.execute(
            """
            SELECT
                window_index,
                scheduled_time::date AS day,
                to_char(scheduled_time::timestamp, 'HH24:MI') AS hhmm,
                MAX(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS is_sent
            FROM prompts
            WHERE participant_id = %s
              AND scheduled_time::date BETWEEN %s AND %s
            GROUP BY window_index, scheduled_time::date, scheduled_time::timestamp
            ORDER BY day, window_index
            """,
            (item["participant_id"], item["start_date"], item["end_date"]),
        ).fetchall()
        by_window: dict[str, list[dict]] = {}
        for s in schedules:
            key = str(s["window_index"])
            by_window.setdefault(key, []).append(
                {"date": s["day"], "time": s["hhmm"], "sent": bool(s["is_sent"])}
            )
        item["window_schedules"] = by_window
        output.append(item)
    conn.close()
    return output


@app.post("/api/studies")
def create_study(payload: StudyIn):
    conn = get_conn()
    validate_study_windows(payload)
    participant = conn.execute("SELECT id FROM participants WHERE id = %s", (payload.participant_id,)).fetchone()
    if not participant:
        conn.close()
        raise HTTPException(status_code=400, detail="Participant not found")
    existing = conn.execute(
        "SELECT id FROM studies WHERE participant_id = %s",
        (payload.participant_id,),
    ).fetchone()
    if existing:
        conn.close()
        raise HTTPException(status_code=400, detail="This participant already has a study")
    cur = conn.execute(
        """
        INSERT INTO studies (participant_id, comments, start_date, end_date, prompts_per_day, windows_json)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id
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
    new_id = cur.fetchone()["id"]
    row = conn.execute("SELECT * FROM studies WHERE id = %s", (new_id,)).fetchone()
    conn.close()
    log_event("study_created", f"id={new_id}")
    conn = get_conn()
    study_for_schedule = conn.execute("SELECT * FROM studies WHERE id = %s", (new_id,)).fetchone()
    if study_for_schedule:
        created = regenerate_study_schedule(conn, study_for_schedule, overwrite_unsent=True)
        log_event("schedule_generated", f"study_id={new_id} prompts_generated={created}")
    conn.commit()
    conn.close()
    result = dict(row)
    result["windows"] = json.loads(result.pop("windows_json"))
    return result


@app.put("/api/studies/{study_id}")
def update_study(study_id: int, payload: StudyIn):
    conn = get_conn()
    validate_study_windows(payload)
    participant = conn.execute("SELECT id FROM participants WHERE id = %s", (payload.participant_id,)).fetchone()
    if not participant:
        conn.close()
        raise HTTPException(status_code=400, detail="Participant not found")
    existing = conn.execute(
        "SELECT id FROM studies WHERE participant_id = %s AND id != %s",
        (payload.participant_id, study_id),
    ).fetchone()
    if existing:
        conn.close()
        raise HTTPException(status_code=400, detail="This participant already has a study")
    updated = conn.execute(
        """
        UPDATE studies
            SET participant_id = %s, comments = %s, start_date = %s, end_date = %s, prompts_per_day = %s, windows_json = %s
            WHERE id = %s
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
    row = conn.execute("SELECT * FROM studies WHERE id = %s", (study_id,)).fetchone()
    conn.close()
    if updated.rowcount == 0 or not row:
        raise HTTPException(status_code=404, detail="Study not found")
    log_event("study_updated", f"id={study_id}")
    result = dict(row)
    result["windows"] = json.loads(result.pop("windows_json"))
    conn = get_conn()
    study_for_schedule = conn.execute("SELECT * FROM studies WHERE id = %s", (study_id,)).fetchone()
    if study_for_schedule:
        created = regenerate_study_schedule(conn, study_for_schedule, overwrite_unsent=True)
        log_event("schedule_generated", f"study_id={study_id} prompts_generated={created}")
    conn.commit()
    conn.close()
    return result


@app.delete("/api/studies/{study_id}")
def delete_study(study_id: int):
    conn = get_conn()
    deleted = conn.execute("DELETE FROM studies WHERE id = %s", (study_id,))
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
    conn = get_conn()
    studies = conn.execute("SELECT * FROM studies ORDER BY id DESC").fetchall()
    total = 0
    for study in studies:
        total += regenerate_study_schedule(conn, study, overwrite_unsent=True)
    conn.commit()
    conn.close()
    log_event("schedule_generated", f"manual prompts_generated={total}")
    return {"ok": True, "generated": total}


@app.get("/api/dashboard")
def dashboard():
    conn = get_conn()
    active_studies = conn.execute("SELECT COUNT(*) c FROM studies").fetchone()["c"]
    participants = conn.execute("SELECT COUNT(*) c FROM participants WHERE status='active'").fetchone()["c"]
    sent_today = conn.execute(
        """
        SELECT COUNT(*) c
        FROM prompts
        WHERE status='sent' AND sent_time::date = CURRENT_DATE
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
