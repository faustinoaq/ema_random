# EMA Study Admin (Minimal)

Simple stack for a 6-day EMA study:

- FastAPI backend
- SQLite database
- APScheduler for daily random prompt generation
- Single lightweight frontend served by FastAPI
- Accent color: `#d8d1e8`

## Run

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.main:app --reload
```

Open: `http://127.0.0.1:8000`

## Included API

- `GET /api/participants`
- `POST /api/participants`
- `PUT /api/participants/{id}`
- `DELETE /api/participants/{id}`
- `GET /api/studies`
- `POST /api/studies`
- `GET /api/logs`
- `POST /api/scheduler/generate`
- `GET /api/dashboard`
