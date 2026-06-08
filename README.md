# EMA Study Admin

Minimal EMA study admin app:
- FastAPI (`server`)
- SQLite
- APScheduler
- UI served by FastAPI (`ui`)

## Run

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn server.main:app --reload
```

Open: `http://127.0.0.1:8000`

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
