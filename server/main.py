from __future__ import annotations

import json
import hashlib
import random
import os
import secrets
import time
import threading
import base64
import urllib.error
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
from pydantic import BaseModel, HttpUrl

from .db import get_conn, init_db
from .schemas import ParticipantIn, StudyIn

app = FastAPI(title="EMA Admin", version="0.1.0")
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
scheduler = BackgroundScheduler(timezone=LOCAL_TZ)
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
PROMPT_DISPATCH_INTERVAL_SECONDS = max(15, int(os.getenv("PROMPT_DISPATCH_INTERVAL_SECONDS", "30")))
PROMPT_MAX_SEND_RETRIES = max(1, int(os.getenv("PROMPT_MAX_SEND_RETRIES", "3")))
FIXED_END_OF_DAY_TIME = "20:30"

SURVEY_TEMPLATE_KEYS = {
    "survey_template_window_1": "window_1",
    "survey_template_window_2": "window_2",
    "survey_template_window_3": "window_3",
    "survey_template_window_4": "window_4",
    "survey_template_morning": "morning",
    "survey_template_end_of_day": "end_of_day",
    "survey_template_dry_blood_spot": "dry_blood_spot",
}

DEFAULT_SURVEY_TEMPLATES = {
    "survey_template_window_1": "https://unc.az1.qualtrics.com/jfe/form/SV_ah2x6h9D99T3TMO",
    "survey_template_window_2": "https://unc.az1.qualtrics.com/jfe/form/SV_39nceO5WzEeTsKG",
    "survey_template_window_3": "https://unc.az1.qualtrics.com/jfe/form/SV_39nceO5WzEeTsKG",
    "survey_template_window_4": "https://unc.az1.qualtrics.com/jfe/form/SV_39nceO5WzEeTsKG",
    "survey_template_morning": "https://unc.az1.qualtrics.com/jfe/form/SV_3w7AgzHpYEYgbUG",
    "survey_template_end_of_day": "https://unc.az1.qualtrics.com/jfe/form/SV_9Hr3krARf8PC3KS",
    "survey_template_dry_blood_spot": "https://unc.az1.qualtrics.com/jfe/form/SV_b47bAEoLoUNCi8e",
}


class LoginPayload(BaseModel):
    username: str
    password: str


class SurveyTemplatesPayload(BaseModel):
    window_1: HttpUrl
    window_2: HttpUrl
    window_3: HttpUrl
    window_4: HttpUrl
    morning: HttpUrl
    end_of_day: HttpUrl
    dry_blood_spot: HttpUrl


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


@app.get("/api/settings/survey-templates")
def get_survey_template_settings():
    conn = get_conn()
    templates = get_survey_templates(conn)
    conn.close()
    return templates


@app.put("/api/settings/survey-templates")
def update_survey_template_settings(payload: SurveyTemplatesPayload):
    conn = get_conn()
    upsert_setting(conn, "survey_template_window_1", str(payload.window_1))
    upsert_setting(conn, "survey_template_window_2", str(payload.window_2))
    upsert_setting(conn, "survey_template_window_3", str(payload.window_3))
    upsert_setting(conn, "survey_template_window_4", str(payload.window_4))
    upsert_setting(conn, "survey_template_morning", str(payload.morning))
    upsert_setting(conn, "survey_template_end_of_day", str(payload.end_of_day))
    upsert_setting(conn, "survey_template_dry_blood_spot", str(payload.dry_blood_spot))
    conn.commit()
    conn.close()
    log_event("settings_updated", "survey_template_links")
    conn2 = get_conn()
    templates = get_survey_templates(conn2)
    conn2.close()
    return templates


def log_event(event: str, details: str) -> None:
    timestamp = datetime.now(LOCAL_TZ).isoformat()
    print(f"[{timestamp}] {event}: {details}")
    conn = get_conn()
    conn.execute(
        "INSERT INTO logs (timestamp, event, details) VALUES (%s, %s, %s)",
        (timestamp, event, details),
    )
    conn.commit()
    conn.close()


def get_setting(conn, key: str) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key = %s", (key,)).fetchone()
    return row["value"] if row else None


def append_pid_to_url(url: str, pid: str) -> str:
    if not pid:
        return url
    parsed = urllib.parse.urlparse(url)
    query_items = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query_items.append(("pid", pid))
    query = urllib.parse.urlencode(query_items, doseq=True)
    return urllib.parse.urlunparse(parsed._replace(query=query))


def upsert_setting(conn, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        (key, value),
    )


def ensure_default_settings(conn) -> None:
    for key, value in DEFAULT_SURVEY_TEMPLATES.items():
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (%s, %s) ON CONFLICT (key) DO NOTHING",
            (key, value),
        )


def get_survey_templates(conn) -> dict[str, str]:
    result = {
        "window_1": DEFAULT_SURVEY_TEMPLATES["survey_template_window_1"],
        "window_2": DEFAULT_SURVEY_TEMPLATES["survey_template_window_2"],
        "window_3": DEFAULT_SURVEY_TEMPLATES["survey_template_window_3"],
        "window_4": DEFAULT_SURVEY_TEMPLATES["survey_template_window_4"],
        "morning": DEFAULT_SURVEY_TEMPLATES["survey_template_morning"],
        "end_of_day": DEFAULT_SURVEY_TEMPLATES["survey_template_end_of_day"],
        "dry_blood_spot": DEFAULT_SURVEY_TEMPLATES["survey_template_dry_blood_spot"],
    }
    keys = list(DEFAULT_SURVEY_TEMPLATES.keys())
    placeholders = ", ".join(["%s"] * len(keys))
    rows = conn.execute(
        f"SELECT key, value FROM settings WHERE key IN ({placeholders})",
        tuple(keys),
    ).fetchall()
    for row in rows:
        mapped_key = SURVEY_TEMPLATE_KEYS.get(row["key"])
        if mapped_key:
            result[mapped_key] = row["value"]
    return result


def get_default_survey_template_for_window_index(conn, index: int) -> str | None:
    if index == 1:
        return get_setting(conn, "survey_template_window_1")
    if index in (2, 3, 4):
        return get_setting(conn, f"survey_template_window_{index}")
    return None


def get_default_setting_values(conn) -> dict[str, str]:
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    return {row["key"]: row["value"] for row in rows}


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
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            if res.status >= 300:
                raise HTTPException(status_code=502, detail="Twilio SMS send failed")
    except urllib.error.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Twilio SMS send failed: {exc.reason}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Twilio SMS send failed: {exc}") from exc


def prompt_delivery_enabled() -> bool:
    return bool(TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and (TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID))


def build_prompt_sms_body(survey_link: str) -> str:
    return f"Please complete your survey: {survey_link}"


def random_time_within_range(start_dt: datetime, end_dt: datetime) -> datetime:
    delta = int((end_dt - start_dt).total_seconds())
    if delta <= 0:
        return start_dt
    return start_dt + timedelta(seconds=random.randint(0, delta))


def random_time_within_range_for_day(day: date, start_hhmm: str, end_hhmm: str) -> datetime:
    day_str = day.isoformat()
    start_dt = datetime.fromisoformat(f"{day_str}T{start_hhmm}:00").replace(tzinfo=LOCAL_TZ)
    end_dt = datetime.fromisoformat(f"{day_str}T{end_hhmm}:00").replace(tzinfo=LOCAL_TZ)
    return random_time_within_range(start_dt, end_dt)


def window_bounds_for_day(day: date, start_hhmm: str, end_hhmm: str) -> tuple[datetime, datetime]:
    day_str = day.isoformat()
    start_dt = datetime.fromisoformat(f"{day_str}T{start_hhmm}:00").replace(tzinfo=LOCAL_TZ)
    end_dt = datetime.fromisoformat(f"{day_str}T{end_hhmm}:00").replace(tzinfo=LOCAL_TZ)
    if end_dt < start_dt:
        end_dt = start_dt
    return start_dt, end_dt


def windows_can_support_gap(window_bounds: list[tuple[datetime, datetime]], gap_seconds: int) -> bool:
    if not window_bounds:
        return True

    scheduled = window_bounds[0][0]
    if scheduled > window_bounds[0][1]:
        return False

    for start_dt, end_dt in window_bounds[1:]:
        scheduled = max(start_dt, scheduled + timedelta(seconds=gap_seconds))
        if scheduled > end_dt:
            return False
    return True


def random_times_for_windows_with_gap(
    window_bounds: list[tuple[datetime, datetime]], gap_seconds: int
) -> list[datetime] | None:
    if not window_bounds:
        return []

    latest_feasible = [bounds[1] for bounds in window_bounds]
    for idx in range(len(window_bounds) - 2, -1, -1):
        constrained_latest = latest_feasible[idx + 1] - timedelta(seconds=gap_seconds)
        latest_feasible[idx] = min(window_bounds[idx][1], constrained_latest)
        if latest_feasible[idx] < window_bounds[idx][0]:
            return None

    scheduled: list[datetime] = []
    for idx, (start_dt, _end_dt) in enumerate(window_bounds):
        earliest = start_dt
        if idx > 0:
            earliest = max(earliest, scheduled[idx - 1] + timedelta(seconds=gap_seconds))
        latest = latest_feasible[idx]
        if earliest > latest:
            return None
        scheduled.append(random_time_within_range(earliest, latest))

    return scheduled


def compute_effective_window_spacing_seconds(window_bounds: list[tuple[datetime, datetime]]) -> int | None:
    if len(window_bounds) < 2:
        return 0

    target_gap_seconds = 90 * 60
    floor_gap_seconds = 45 * 60
    interval_count = len(window_bounds) - 1

    total_span_seconds = int((window_bounds[-1][1] - window_bounds[0][0]).total_seconds())
    total_span_seconds = max(0, total_span_seconds)
    if total_span_seconds >= interval_count * target_gap_seconds:
        desired_gap_seconds = target_gap_seconds
    else:
        desired_gap_seconds = max(floor_gap_seconds, total_span_seconds // interval_count)

    if windows_can_support_gap(window_bounds, desired_gap_seconds):
        return desired_gap_seconds
    if windows_can_support_gap(window_bounds, floor_gap_seconds):
        return floor_gap_seconds
    return None


def schedule_window_times_for_day(
    window_bounds: list[tuple[datetime, datetime]],
) -> tuple[list[datetime], int, str | None]:
    if not window_bounds:
        return [], 0, None

    spacing_seconds = compute_effective_window_spacing_seconds(window_bounds)
    if spacing_seconds is not None:
        scheduled_times = random_times_for_windows_with_gap(window_bounds, spacing_seconds)
        if scheduled_times is not None:
            return scheduled_times, spacing_seconds, None

    # If 45-minute floor cannot be satisfied for all windows, schedule as many as possible.
    floor_gap_seconds = 45 * 60
    max_windows_supported = 0
    for count in range(len(window_bounds), 0, -1):
        if count == 1 or windows_can_support_gap(window_bounds[:count], floor_gap_seconds):
            max_windows_supported = count
            break

    if max_windows_supported == 1:
        scheduled_times = [random_time_within_range(window_bounds[0][0], window_bounds[0][1])]
        warning = (
            "Insufficient interval for 4 EMA prompts with minimum 45-minute spacing; "
            "scheduled only 1 EMA prompt."
        )
        return scheduled_times, 0, warning

    scheduled_times = random_times_for_windows_with_gap(window_bounds[:max_windows_supported], floor_gap_seconds)
    if scheduled_times is None:
        scheduled_times = [bounds[0] for bounds in window_bounds[:max_windows_supported]]
    warning = (
        "Insufficient interval for 4 EMA prompts with minimum 45-minute spacing; "
        f"scheduled only {max_windows_supported} EMA prompts."
    )
    return scheduled_times, floor_gap_seconds, warning


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


def validate_hhmm(value: str, label: str) -> None:
    parts = (value or "").split(":")
    if len(parts) != 2:
        raise HTTPException(status_code=400, detail=f"{label} must use HH:MM format")
    try:
        hh = int(parts[0])
        mm = int(parts[1])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"{label} must use HH:MM format") from exc
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        raise HTTPException(status_code=400, detail=f"{label} is out of range")


def validate_additional_daily_surveys(payload: StudyIn) -> None:
    expected_types = {"morning", "end_of_day", "dry_blood_spot"}
    provided_types = {item.survey_type for item in payload.additional_surveys}
    if provided_types != expected_types:
        raise HTTPException(
            status_code=400,
            detail="additional_surveys must include morning, end_of_day and dry_blood_spot",
        )
    for survey in payload.additional_surveys:
        if survey.survey_type in {"morning", "dry_blood_spot"}:
            validate_hhmm(survey.time, f"{survey.survey_type} time")
        if not str(survey.link).strip():
            raise HTTPException(
                status_code=400,
                detail=f"{survey.survey_type} link is required",
            )


def study_date_range(study_row) -> list[date]:
    start = date.fromisoformat(study_row["start_date"])
    end = date.fromisoformat(study_row["end_date"])
    if end < start:
        return []
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


def scheduled_datetime_for_day_time(day: date, hhmm: str) -> datetime:
    validate_hhmm(hhmm, "additional survey time")
    return datetime.fromisoformat(f"{day.isoformat()}T{hhmm}:00").replace(tzinfo=LOCAL_TZ)


def normalize_additional_surveys(additional_surveys: list[dict]) -> list[dict]:
    normalized: list[dict] = []
    for survey in additional_surveys:
        item = dict(survey)
        if item.get("survey_type") == "end_of_day":
            item["time"] = FIXED_END_OF_DAY_TIME
        normalized.append(item)
    return normalized


def regenerate_study_schedule(conn, study_row, overwrite_unsent: bool = True) -> int:
    participant = conn.execute(
        "SELECT id, participant_id FROM participants WHERE id = %s AND status = 'active'",
        (study_row["participant_id"],),
    ).fetchone()
    if not participant:
        return 0

    participant_pid = (participant["participant_id"] or "").strip()
    if not participant_pid:
        log_event("schedule_skipped", f"study_id={study_row['id']} missing participant_id for pid")
        return 0

    windows = json.loads(study_row["windows_json"])
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

    additional_surveys = json.loads(study_row.get("additional_surveys_json") or "[]")
    survey_index_map = {"morning": 7, "end_of_day": 5, "dry_blood_spot": 6}

    scheduled_count = 0
    skipped_same_day_past_count = 0
    for day in days:
        now_local = datetime.now(LOCAL_TZ)
        if overwrite_unsent:
            conn.execute(
                """
                DELETE FROM prompts
                WHERE participant_id = %s
                                    AND (scheduled_time::timestamptz AT TIME ZONE %s)::date = %s
                                    AND status = 'scheduled'
                """,
                                (participant["id"], APP_TIMEZONE, day.isoformat()),
            )

        window_bounds = [
            window_bounds_for_day(day, window["start"], window["end"])
            for window in selected_windows
        ]
        scheduled_times, spacing_seconds, warning_message = schedule_window_times_for_day(window_bounds)
        if spacing_seconds >= 45 * 60 and spacing_seconds < 90 * 60:
            log_event(
                "schedule_spacing_reduced",
                f"study_id={study_row['id']} day={day.isoformat()} gap_seconds={spacing_seconds}",
            )
        if warning_message:
            log_event(
                "schedule_warning",
                f"study_id={study_row['id']} day={day.isoformat()} message={warning_message}",
            )

        for idx, (window, scheduled_dt_obj) in enumerate(zip(selected_windows, scheduled_times)):
            survey_link = (window.get("link") or "").strip()
            if not survey_link:
                default_link = (get_default_survey_template_for_window_index(conn, idx + 1) or "").strip()
                if default_link:
                    survey_link = default_link
                    log_event(
                        "schedule_window_default_link",
                        f"study_id={study_row['id']} day={day.isoformat()} window_index={idx + 1}",
                    )
                else:
                    log_event("schedule_skipped", f"study_id={study_row['id']} missing link for window {idx + 1}")
                    continue

            sent_exists = conn.execute(
                """
                SELECT id FROM prompts
                WHERE participant_id = %s
                  AND window_index = %s
                  AND status = 'sent'
                  AND (scheduled_time::timestamptz AT TIME ZONE %s)::date = %s
                LIMIT 1
                """,
                (participant["id"], idx + 1, APP_TIMEZONE, day.isoformat()),
            ).fetchone()
            if sent_exists:
                continue

            if not overwrite_unsent:
                existing = conn.execute(
                    """
                    SELECT id FROM prompts
                                        WHERE participant_id = %s
                                            AND window_index = %s
                                            AND (scheduled_time::timestamptz AT TIME ZONE %s)::date = %s
                    LIMIT 1
                    """,
                                        (participant["id"], idx + 1, APP_TIMEZONE, day.isoformat()),
                ).fetchone()
                if existing:
                    continue

            # Do not send old same-day prompts created after their intended time.
            if scheduled_dt_obj.date() == now_local.date() and scheduled_dt_obj <= now_local:
                full_link = append_pid_to_url(survey_link, participant_pid)
                conn.execute(
                    """
                    INSERT INTO prompts (participant_id, window_index, scheduled_time, status, survey_link)
                    VALUES (%s, %s, %s, 'skipped', %s)
                    """,
                    (participant["id"], idx + 1, scheduled_dt_obj.isoformat(), full_link),
                )
                skipped_same_day_past_count += 1
                continue

            scheduled_dt = scheduled_dt_obj.isoformat()
            full_link = append_pid_to_url(survey_link, participant_pid)
            conn.execute(
                """
                INSERT INTO prompts (participant_id, window_index, scheduled_time, status, survey_link)
                VALUES (%s, %s, %s, 'scheduled', %s)
                """,
                (participant["id"], idx + 1, scheduled_dt, full_link),
            )
            scheduled_count += 1

        for survey in additional_surveys:
            survey_type = (survey.get("survey_type") or "").strip()
            time_hhmm = (survey.get("time") or "").strip()
            if survey_type == "end_of_day":
                time_hhmm = FIXED_END_OF_DAY_TIME
            survey_link = (survey.get("link") or "").strip()
            prompt_index = survey_index_map.get(survey_type)
            if not prompt_index:
                continue
            if not survey_link or not time_hhmm:
                log_event("schedule_skipped", f"study_id={study_row['id']} missing {survey_type} link/time")
                continue

            sent_exists = conn.execute(
                """
                SELECT id FROM prompts
                WHERE participant_id = %s
                  AND window_index = %s
                  AND status = 'sent'
                  AND (scheduled_time::timestamptz AT TIME ZONE %s)::date = %s
                LIMIT 1
                """,
                (participant["id"], prompt_index, APP_TIMEZONE, day.isoformat()),
            ).fetchone()
            if sent_exists:
                continue

            if not overwrite_unsent:
                existing = conn.execute(
                    """
                    SELECT id FROM prompts
                                        WHERE participant_id = %s
                                            AND window_index = %s
                                            AND (scheduled_time::timestamptz AT TIME ZONE %s)::date = %s
                    LIMIT 1
                    """,
                                        (participant["id"], prompt_index, APP_TIMEZONE, day.isoformat()),
                ).fetchone()
                if existing:
                    continue

            try:
                scheduled_dt_obj = scheduled_datetime_for_day_time(day, time_hhmm)
            except HTTPException:
                log_event("schedule_skipped", f"study_id={study_row['id']} invalid {survey_type} time={time_hhmm}")
                continue

            # Do not send old same-day prompts created after their intended time.
            if scheduled_dt_obj.date() == now_local.date() and scheduled_dt_obj <= now_local:
                full_link = append_pid_to_url(survey_link, participant_pid)
                conn.execute(
                    """
                    INSERT INTO prompts (participant_id, window_index, scheduled_time, status, survey_link)
                    VALUES (%s, %s, %s, 'skipped', %s)
                    """,
                    (participant["id"], prompt_index, scheduled_dt_obj.isoformat(), full_link),
                )
                skipped_same_day_past_count += 1
                continue

            scheduled_dt = scheduled_dt_obj.isoformat()

            full_link = append_pid_to_url(survey_link, participant_pid)
            conn.execute(
                """
                INSERT INTO prompts (participant_id, window_index, scheduled_time, status, survey_link)
                VALUES (%s, %s, %s, 'scheduled', %s)
                """,
                (participant["id"], prompt_index, scheduled_dt, full_link),
            )
            scheduled_count += 1

    if skipped_same_day_past_count:
        log_event(
            "schedule_same_day_past_skipped",
            f"study_id={study_row['id']} skipped={skipped_same_day_past_count}",
        )
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


def claim_due_prompts(conn, limit: int = 50) -> list[dict]:
    rows = conn.execute(
        """
        WITH due AS (
            SELECT p.id, pr.phone, pr.participant_id AS participant_code, p.retry_count
            FROM prompts p
            JOIN participants pr ON pr.id = p.participant_id
            WHERE p.status = 'scheduled'
              AND p.retry_count < %s
              AND pr.status = 'active'
              AND p.scheduled_time::timestamptz <= CURRENT_TIMESTAMP
            ORDER BY p.scheduled_time::timestamptz, p.id
            FOR UPDATE SKIP LOCKED
            LIMIT %s
        )
        UPDATE prompts p
        SET status = 'sending'
        FROM due
        WHERE p.id = due.id
        RETURNING p.id, p.participant_id, p.window_index, p.scheduled_time, p.survey_link, p.retry_count, due.phone, due.participant_code
        """,
        (PROMPT_MAX_SEND_RETRIES, limit),
    ).fetchall()
    return [dict(row) for row in rows]


def mark_prompt_send_failed(prompt_id: int) -> dict | None:
    conn = get_conn()
    row = conn.execute(
        """
        UPDATE prompts
        SET retry_count = retry_count + 1,
            status = CASE
                WHEN retry_count + 1 >= %s THEN 'failed'
                ELSE 'scheduled'
            END
        WHERE id = %s AND status = 'sending'
        RETURNING retry_count, status
        """,
        (PROMPT_MAX_SEND_RETRIES, prompt_id),
    ).fetchone()
    conn.commit()
    conn.close()
    return dict(row) if row else None


def mark_prompt_as_sent(prompt_id: int, sent_at: str) -> None:
    conn = get_conn()
    conn.execute(
        "UPDATE prompts SET status = 'sent', sent_time = %s WHERE id = %s AND status = 'sending'",
        (sent_at, prompt_id),
    )
    conn.commit()
    conn.close()


def mark_prompt_as_skipped(prompt_id: int) -> None:
    conn = get_conn()
    conn.execute(
        "UPDATE prompts SET status = 'skipped' WHERE id = %s AND status IN ('scheduled', 'sending')",
        (prompt_id,),
    )
    conn.commit()
    conn.close()


def skip_stale_scheduled_prompts() -> int:
    conn = get_conn()
    rows = conn.execute(
        """
        WITH stale AS (
            SELECT id
            FROM prompts
            WHERE status = 'scheduled'
              AND (scheduled_time::timestamptz AT TIME ZONE %s)::date < (CURRENT_TIMESTAMP AT TIME ZONE %s)::date
        )
        UPDATE prompts p
        SET status = 'skipped'
        FROM stale
        WHERE p.id = stale.id
        RETURNING p.id
        """,
        (APP_TIMEZONE, APP_TIMEZONE),
    ).fetchall()
    conn.commit()
    conn.close()
    return len(rows)


def already_sent_same_window_day(participant_id: int, window_index: int, day_iso: str, exclude_prompt_id: int) -> bool:
    conn = get_conn()
    row = conn.execute(
        """
        SELECT id
        FROM prompts
        WHERE participant_id = %s
          AND window_index = %s
          AND status = 'sent'
          AND id <> %s
          AND (scheduled_time::timestamptz AT TIME ZONE %s)::date = %s
        LIMIT 1
        """,
        (participant_id, window_index, exclude_prompt_id, APP_TIMEZONE, day_iso),
    ).fetchone()
    conn.close()
    return row is not None


def dispatch_due_prompts() -> int:
    if not prompt_delivery_enabled():
        print("[prompt_dispatch] skipped: Twilio credentials or sender configuration missing")
        return 0

    stale_skipped = skip_stale_scheduled_prompts()
    if stale_skipped:
        print(f"[prompt_dispatch] skipped {stale_skipped} stale prompt(s) from previous days")
        log_event("prompt_stale_skipped", f"count={stale_skipped}")

    conn = get_conn()
    claimed_prompts = claim_due_prompts(conn)
    conn.commit()
    conn.close()

    if claimed_prompts:
        print(f"[prompt_dispatch] claimed {len(claimed_prompts)} due prompt(s)")

    sent_count = 0
    for prompt in claimed_prompts:
        prompt_id = prompt["id"]
        prompt_day = (
            datetime.fromisoformat(str(prompt["scheduled_time"]).replace("Z", "+00:00"))
            .astimezone(LOCAL_TZ)
            .date()
            .isoformat()
        )
        if already_sent_same_window_day(
            prompt["participant_id"],
            prompt["window_index"],
            prompt_day,
            prompt_id,
        ):
            print(
                "[prompt_dispatch] skipped duplicate "
                f"prompt_id={prompt_id} participant_id={prompt['participant_id']} "
                f"window_index={prompt['window_index']} day={prompt_day}"
            )
            mark_prompt_as_skipped(prompt_id)
            log_event(
                "prompt_duplicate_skipped",
                f"prompt_id={prompt_id} participant_id={prompt['participant_id']} window_index={prompt['window_index']} day={prompt_day}",
            )
            continue
        print(
            "[prompt_dispatch] sending "
            f"prompt_id={prompt_id} participant_id={prompt['participant_id']} "
            f"participant_code={prompt['participant_code']} window_index={prompt['window_index']} "
            f"scheduled_time={prompt['scheduled_time']} phone={prompt['phone']}"
        )
        try:
            send_sms_message(prompt["phone"], build_prompt_sms_body(prompt["survey_link"]))
        except HTTPException as exc:
            print(f"[prompt_dispatch] failed prompt_id={prompt_id}: {exc.detail}")
            failure_state = mark_prompt_send_failed(prompt_id)
            if failure_state and failure_state["status"] == "failed":
                log_event(
                    "prompt_send_failed_final",
                    f"prompt_id={prompt_id} participant_id={prompt['participant_id']} retries={failure_state['retry_count']} detail={exc.detail}",
                )
            else:
                log_event(
                    "prompt_send_failed",
                    f"prompt_id={prompt_id} participant_id={prompt['participant_id']} retries={failure_state['retry_count'] if failure_state else 'unknown'} detail={exc.detail}",
                )
            continue
        except Exception as exc:
            print(f"[prompt_dispatch] failed prompt_id={prompt_id}: {exc}")
            failure_state = mark_prompt_send_failed(prompt_id)
            if failure_state and failure_state["status"] == "failed":
                log_event(
                    "prompt_send_failed_final",
                    f"prompt_id={prompt_id} participant_id={prompt['participant_id']} retries={failure_state['retry_count']} detail={exc}",
                )
            else:
                log_event(
                    "prompt_send_failed",
                    f"prompt_id={prompt_id} participant_id={prompt['participant_id']} retries={failure_state['retry_count'] if failure_state else 'unknown'} detail={exc}",
                )
            continue

        sent_at = datetime.now(LOCAL_TZ).isoformat()
        mark_prompt_as_sent(prompt_id, sent_at)
        print(f"[prompt_dispatch] sent prompt_id={prompt_id} at {sent_at}")
        log_event(
            "prompt_sent",
            f"prompt_id={prompt_id} participant_id={prompt['participant_id']} window_index={prompt['window_index']}",
        )
        sent_count += 1

    return sent_count


def run_prompt_dispatch() -> None:
    print(f"[prompt_dispatch] tick at {datetime.now(LOCAL_TZ).isoformat()}")
    sent_count = dispatch_due_prompts()
    if sent_count:
        log_event("prompt_dispatch_run", f"sent={sent_count}")


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    conn = get_conn()
    ensure_default_settings(conn)
    conn.commit()
    conn.close()
    scheduler.add_job(generate_daily_schedule, "cron", hour=0, minute=0, id="daily_generation")
    scheduler.add_job(
        run_prompt_dispatch,
        "interval",
        seconds=PROMPT_DISPATCH_INTERVAL_SECONDS,
        id="prompt_dispatch",
        max_instances=1,
        coalesce=True,
    )
    print(
        "Prompt dispatch worker configured "
        f"interval={PROMPT_DISPATCH_INTERVAL_SECONDS}s enabled={prompt_delivery_enabled()}"
    )
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
            VALUES (%s, %s, %s, %s)
            RETURNING id
            """,
            (payload.participant_id, payload.phone, payload.redcap_record_id, payload.status),
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
            SET participant_id = %s, phone = %s, redcap_record_id = %s, status = %s
            WHERE id = %s
            """,
            (payload.participant_id, payload.phone, payload.redcap_record_id, payload.status, participant_id),
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
    participant = conn.execute("SELECT id FROM participants WHERE id = %s", (participant_id,)).fetchone()
    if not participant:
        conn.close()
        raise HTTPException(status_code=404, detail="Participant not found")

    # Remove dependent rows first to satisfy FK constraints.
    conn.execute("DELETE FROM prompts WHERE participant_id = %s", (participant_id,))
    conn.execute("DELETE FROM studies WHERE participant_id = %s", (participant_id,))
    conn.execute("DELETE FROM participants WHERE id = %s", (participant_id,))
    conn.commit()
    conn.close()
    log_event("participant_deleted", f"id={participant_id}")
    return {"ok": True}


class SmsPayload(BaseModel):
    body: str


@app.post("/api/participants/{participant_id}/sms")
def send_participant_sms(participant_id: int, payload: SmsPayload):
    conn = None
    try:
        conn = get_conn()
        row = conn.execute(
            "SELECT participant_id, phone FROM participants WHERE id = %s",
            (participant_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Participant not found")
        message_body = payload.body.strip()
        if not message_body:
            raise HTTPException(status_code=400, detail="Message body is required")
        send_sms_message(row["phone"], message_body)
        log_event("sms_sent", f"participant_id={participant_id}")
        return {"ok": True}
    except HTTPException:
        raise
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected server error while sending SMS: {exc}") from exc
    finally:
        if conn is not None:
            conn.close()


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
        item["additional_surveys"] = normalize_additional_surveys(
            json.loads(item.pop("additional_surveys_json") or "[]")
        )
        schedules = conn.execute(
            """
            WITH localized_prompts AS (
                SELECT
                    window_index,
                    (scheduled_time::timestamptz AT TIME ZONE %s) AS local_time,
                    status
                FROM prompts
                WHERE participant_id = %s
            )
            SELECT
                window_index,
                local_time::date AS day,
                to_char(local_time, 'HH24:MI') AS hhmm,
                MAX(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS is_sent
            FROM localized_prompts
            WHERE local_time::date BETWEEN %s AND %s
            GROUP BY
                window_index,
                local_time::date,
                to_char(local_time, 'HH24:MI')
            ORDER BY day, window_index
            """,
            (
                APP_TIMEZONE,
                item["participant_id"],
                item["start_date"],
                item["end_date"],
            ),
        ).fetchall()
        by_window: dict[str, list[dict]] = {}
        for s in schedules:
            key = str(s["window_index"])
            by_window.setdefault(key, []).append(
                {"date": s["day"], "time": s["hhmm"], "sent": bool(s["is_sent"])}
            )
        item["window_schedules"] = by_window

        additional_schedule_labels = {5: "end_of_day", 6: "dry_blood_spot", 7: "morning"}
        additional_schedules: dict[str, list[dict]] = {
            "morning": [],
            "end_of_day": [],
            "dry_blood_spot": [],
        }
        for s in schedules:
            label = additional_schedule_labels.get(s["window_index"])
            if not label:
                continue
            additional_schedules[label].append(
                {"date": s["day"], "time": s["hhmm"], "sent": bool(s["is_sent"])}
            )
        item["additional_schedules"] = additional_schedules
        output.append(item)
    conn.close()
    return output


@app.post("/api/studies")
def create_study(payload: StudyIn):
    conn = get_conn()
    validate_study_windows(payload)
    validate_additional_daily_surveys(payload)
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
        INSERT INTO studies (participant_id, comments, start_date, end_date, prompts_per_day, windows_json, additional_surveys_json)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
        (
            payload.participant_id,
            payload.comments,
            payload.start_date,
            payload.end_date,
            payload.prompts_per_day,
            json.dumps([{"start": w.start, "end": w.end, "link": str(w.link)} for w in payload.windows]),
            json.dumps(
                [
                    {
                        "survey_type": s.survey_type,
                        "time": FIXED_END_OF_DAY_TIME if s.survey_type == "end_of_day" else s.time,
                        "link": str(s.link),
                    }
                    for s in payload.additional_surveys
                ]
            ),
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
    result["additional_surveys"] = normalize_additional_surveys(
        json.loads(result.pop("additional_surveys_json") or "[]")
    )
    return result


@app.put("/api/studies/{study_id}")
def update_study(study_id: int, payload: StudyIn):
    conn = get_conn()
    validate_study_windows(payload)
    validate_additional_daily_surveys(payload)
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
            SET participant_id = %s, comments = %s, start_date = %s, end_date = %s, prompts_per_day = %s, windows_json = %s, additional_surveys_json = %s
            WHERE id = %s
            """,
        (
            payload.participant_id,
            payload.comments,
            payload.start_date,
            payload.end_date,
            payload.prompts_per_day,
            json.dumps([{"start": w.start, "end": w.end, "link": str(w.link)} for w in payload.windows]),
            json.dumps(
                [
                    {
                        "survey_type": s.survey_type,
                        "time": FIXED_END_OF_DAY_TIME if s.survey_type == "end_of_day" else s.time,
                        "link": str(s.link),
                    }
                    for s in payload.additional_surveys
                ]
            ),
            study_id,
        ),
    )
    row = conn.execute("SELECT * FROM studies WHERE id = %s", (study_id,)).fetchone()
    if updated.rowcount == 0 or not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Study not found")

    generated = regenerate_study_schedule(conn, row, overwrite_unsent=True)
    conn.commit()
    conn.close()
    log_event("study_updated", f"id={study_id}")
    log_event("schedule_generated", f"study_id={study_id} prompts_generated={generated}")
    result = dict(row)
    result["windows"] = json.loads(result.pop("windows_json"))
    result["additional_surveys"] = normalize_additional_surveys(
        json.loads(result.pop("additional_surveys_json") or "[]")
    )
    return result


@app.delete("/api/studies/{study_id}")
def delete_study(study_id: int):
    conn = get_conn()
    study = conn.execute(
        "SELECT participant_id FROM studies WHERE id = %s", (study_id,)
    ).fetchone()
    if study is None:
        conn.close()
        raise HTTPException(status_code=404, detail="Study not found")
    cancelled = conn.execute(
        "UPDATE prompts SET status = 'cancelled' WHERE participant_id = %s AND status = 'scheduled'",
        (study["participant_id"],),
    )
    conn.execute("DELETE FROM studies WHERE id = %s", (study_id,))
    conn.commit()
    conn.close()
    log_event("study_deleted", f"id={study_id} cancelled_prompts={cancelled.rowcount}")
    return {"ok": True}


@app.get("/api/logs")
def list_logs():
    conn = get_conn()
    rows = conn.execute("SELECT * FROM logs ORDER BY id DESC LIMIT 200").fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/api/scheduler/generate/{participant_id}")
def manual_generate(participant_id: int):
    conn = get_conn()
    studies = conn.execute(
        "SELECT * FROM studies WHERE participant_id = %s ORDER BY id DESC",
        (participant_id,),
    ).fetchall()
    if not studies:
        conn.close()
        raise HTTPException(status_code=404, detail="No study found for this participant")
    total = 0
    for study in studies:
        total += regenerate_study_schedule(conn, study, overwrite_unsent=True)
    conn.commit()
    conn.close()
    log_event("schedule_generated", f"manual participant_id={participant_id} prompts_generated={total}")
    return {"ok": True, "participant_id": participant_id, "generated": total}


@app.get("/api/dashboard")
def dashboard():
    conn = get_conn()
    total_studies = conn.execute("SELECT COUNT(*) c FROM studies").fetchone()["c"]
    participants = conn.execute("SELECT COUNT(*) c FROM participants WHERE status='active'").fetchone()["c"]
    sent_today = conn.execute(
        """
        SELECT COUNT(*) c
        FROM logs
        WHERE event = 'prompt_sent'
          AND (timestamp::timestamptz AT TIME ZONE %s)::date = (CURRENT_TIMESTAMP AT TIME ZONE %s)::date
        """,
        (APP_TIMEZONE, APP_TIMEZONE),
    ).fetchone()["c"]
    completed_studies = conn.execute(
        """
        SELECT COUNT(*) c
        FROM (
            SELECT
                s.id,
                s.prompts_per_day,
                GREATEST((s.end_date::date - s.start_date::date + 1), 0) AS day_count,
                jsonb_array_length(COALESCE(NULLIF(s.additional_surveys_json, ''), '[]')::jsonb) AS additional_count,
                COALESCE(
                    (
                        SELECT COUNT(*)
                        FROM prompts p
                        WHERE p.participant_id = s.participant_id
                          AND p.status = 'sent'
                          AND (
                              p.window_index BETWEEN 1 AND s.prompts_per_day
                              OR p.window_index IN (5, 6)
                          )
                          AND (p.scheduled_time::timestamptz AT TIME ZONE %s)::date
                              BETWEEN s.start_date::date AND s.end_date::date
                    ),
                    0
                ) AS sent_count
            FROM studies s
        ) study_status
        WHERE study_status.day_count > 0
          AND study_status.sent_count >= study_status.day_count * (study_status.prompts_per_day + study_status.additional_count)
        """,
        (APP_TIMEZONE,),
    ).fetchone()["c"]
    active_studies = max(total_studies - completed_studies, 0)
    conn.close()
    return {
        "active_studies": active_studies,
        "participants_enrolled": participants,
        "messages_sent_today": sent_today,
        "completed_studies": completed_studies,
    }


@app.get("/")
def root():
    return FileResponse(STATIC_DIR / "landing.html")


@app.get("/admin")
def admin_root():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/privacy-policy")
def privacy_policy_page():
    return FileResponse(STATIC_DIR / "privacy.html")


@app.get("/terms-and-conditions")
def terms_and_conditions_page():
    return FileResponse(STATIC_DIR / "terms.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR / "static"), name="static")
