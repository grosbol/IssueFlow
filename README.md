# IssueFlow

IssueFlow is a small, on-prem friendly issue tracker inspired by Jira, Trello, and Linear.

## What is included

- `backend/`: Express + TypeScript API with PostgreSQL schema and workflow transition validation
- `frontend/`: React + TypeScript board UI with issue detail panel
- `docker-compose.yml`: local app + Postgres setup

## MVP features

- Projects
- Issues
- Status workflow with guarded transitions
- Assignee support
- Comments
- History timeline
- Kanban board
- Issue detail view

## Local development

### 1. Create env files

```bash
cp .env.example .env
cp frontend/.env.example frontend/.env
cp backend/.env.example backend/.env
```

### 2. Start Postgres and the API

```bash
docker compose up --build
```

The API will be available on `http://localhost:4000`.

### 3. Run the frontend locally

```bash
cd frontend
npm install
npm run dev
```

The UI will be available on `http://localhost:5173`.

### 4. Run the backend locally without Docker

```bash
cd backend
npm install
npm run migrate
npm run seed
npm run dev
```

## Database migrations

The backend now uses tracked SQL migrations in `backend/sql/migrations`.

Commands:

- `npm run migrate`: creates the schema and records applied migrations
- `npm run seed`: inserts demo data idempotently

This is a safer base for production than re-running one large bootstrap script.

## Key API endpoints

- `GET /health`
- `GET /api/projects`
- `GET /api/projects/:projectId/board`
- `GET /api/issues/:issueId`
- `POST /api/issues`
- `PATCH /api/issues/:issueId/status`
- `POST /api/issues/:issueId/comments`

## Product choices

- Each project uses one workflow
- Allowed next states are enforced in the backend
- The UI only exposes valid status moves
- Scope stays intentionally tight to preserve speed and clarity

## CI

GitHub Actions is configured in `.github/workflows/ci.yml`.

It installs dependencies and runs:

- backend TypeScript build
- frontend TypeScript + Vite build

## Production notes

- Copy `.env.example` values into environment-specific secrets before deployment
- Replace demo credentials and seed data before exposing the app
- Put the frontend behind a reverse proxy and lock down CORS to the deployed origin
- Add backups for the Postgres volume before treating the instance as durable
