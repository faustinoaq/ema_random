# EMA Study Admin

Minimal EMA study admin app:
- FastAPI (`server`)
- SQLite
- APScheduler
- UI served by FastAPI (`ui`)
- Simple session auth using env username/password

## Architecture Flow

```text
Research Staff (Browser)
          │
          │  Manage participants/studies, set window links, trigger generate
          ▼
┌──────────────────────────────┐
│ UI (served by FastAPI)       │
│ /                            │
│ /static                      │
└───────────────┬──────────────┘
                │ REST (/api/*)
                ▼
┌──────────────────────────────────────────┐
│ FastAPI Server (server.main)            │
│ - Participant CRUD                       │
│ - Study CRUD                             │
│ - Dashboard + logs                       │
│ - Scheduler trigger endpoint             │
└───────────────┬──────────────────────────┘
                │
                ├──────────────► SQLite (study.db)
                │                participants/studies/prompts/logs
                │
                └──────────────► APScheduler
                                 (daily + manual random time generation)
                                              │
                                              │ send SMS (implementation hook)
                                              ▼
                                      Twilio SMS API
                                              │
                                              ▼
                                       Participant Phone
                                              │
                                              │ opens study-specific REDCap link
                                              ▼
                                         REDCap Survey
```

## Run

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn server.main:app --reload
```

Open: `http://127.0.0.1:8000`

## Auth

API routes are protected with session auth (`/api/*` except auth endpoints).
The UI shows a sign-in modal and creates an authenticated session cookie.

Set credentials in `.env`:

```env
APP_AUTH_USERNAME=admin
APP_AUTH_PASSWORD=change_me
```

## API

```text
GET    /api/participants
POST   /api/participants
PUT    /api/participants/{id}
DELETE /api/participants/{id}

GET    /api/studies
POST   /api/studies
PUT    /api/studies/{id}
DELETE /api/studies/{id}

GET    /api/logs
GET    /api/dashboard
POST   /api/scheduler/generate
```
