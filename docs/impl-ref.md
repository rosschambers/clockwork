# Clockwork — Implementation Reference

Read this file to get the full picture of existing code. Do NOT re-read the source files.

## Conventions
- Bun + TypeScript, ES modules
- `function` declarations top-level, explicit return types on exports
- No nested ternaries, tabs indentation
- `bun test` is the gate — red-green-refactor only
- SQLite (WAL) via native `bun:sqlite`, foreign keys enabled, cascade deletes
- UUIDs everywhere (`crypto.randomUUID()`)
- Auth: optional `Authorization: Bearer <token>`, config via `CLOCKWORK_TOKEN` env var

---

## Completed: Phase 1 + Phase 2 (Steps 1-6)

### src/db.ts — DbStore

Interfaces: `DbProject`, `DbColumn`, `DbCard`, `DbAttempt`, `DbCardThreadEntry`, plus CRUD input types.

Key methods:
- `createProject(input)`, `getProject(id)`, `getAllProjects()`, `updateProject(id, input)`, `deleteProject(id)`
- `createColumn(projectId, input)`, `getColumns(projectId)`, `getColumn(id)`, `updateColumn(id, input)`, `deleteColumn(id)`
- `createCard(projectId, input)`, `getCard(id)`, `getCards(projectId, filter?)`, `updateCard(id, input)`, `deleteCard(id)`
- `claimCard(cardId, workerId)`, `unclaimCard(cardId)`, `lockCard(cardId)`
- `moveCard(cardId, toColumnId, actor?, reason?)` — records thread entry with reason
- `incrementRetryCount(cardId)` — increments retryCount
- `createAttempt(cardId, input)`, `getAttempts(cardId)`
- `addCardThreadEntry(cardId, input)`
- `getFreeCardsByColumn(columnId)` — free cards, not locked, retry < 3
- `getNextPosition(columnId)` — returns max position + 1

### src/api.ts — HTTP server via `Bun.serve`

Exports: `ServerConfig` (`dbStore`, `broker`, `token`), `ServerHandle` (`stop()`, `baseUrl`).

Endpoints:
- `GET /api/projects` — list all projects
- `POST /api/projects` — create (body: `{name, description?, github_repo?, branch?}`)
- `GET /api/projects/:id` — get project with columns
- `PUT /api/projects/:id` — update
- `DELETE /api/projects/:id` — delete (cascade)
- `GET /api/projects/:id/columns` — list columns
- `POST /api/projects/:id/columns` — create (body: `{name, prompt, skills?, model?, position?, extras?}`)
- `PUT /api/columns/:id` — update
- `DELETE /api/columns/:id` — delete
- `GET /api/projects/:id/cards` — list cards (`?column_id=...` filter)
- `POST /api/projects/:id/cards` — create (body: `{column_id, title, body?}`)
- `GET /api/cards/:id` — get card with threads + attempts
- `PUT /api/cards/:id` — update
- `DELETE /api/cards/:id` — delete
- `POST /api/cards/:id/move` — move (body: `{to_column_id, actor?, reason?}`), increments retryCount on kickback
- `POST /api/cards/:id/attempts` — record attempt (body: `{transcript_path?, verdict?}`)
- `GET /api/cards/:id/attempts` — list attempts
- `POST /api/projects/:id/claim` — claim next free card
- `POST /api/cards/:id/unclaim` — release card

### src/ws.ts — WebSocket broker

Exports: `WSMessage` type (13 event types), `WsBroker` class, `wsHandler`.

Events: `card.{created,updated,deleted,moved,claimed,unclaimed}`, `attempt.recorded`, `column.{created,updated,deleted}`, `project.{created,updated,deleted}`. All include `timestamp`.

Client subscribes via `{"type":"subscribe","projectId":"..."}`. Unsubscribed clients see all events.

### src/context.ts — Context assembler (pure function)

Exports: `ContextAssemblerOptions`, `PlanSlice`, `ThreadEntry`, `AssembledContext`, `ContextAssembler` class, `assembleContext()`.

`assembleContext(options)` assembles in order: PROJECT.md (from disk), plan slices (filtered by cardId), thread (truncated oldest-first), column extras. Token budget: ~4 chars/token. Returns `systemPrompt`, `tokenCount`, `truncated`.

### src/verdict.ts — Verdict parser

Exports: `Verdict` interface (`verdict: 'pass'|'fail'|'blocked'`, `feedback`, `artifacts`), `parseVerdict()`.

`parseVerdict(output)` scans from end for last JSON object, validates verdict shape. Returns `{verdict:'blocked'}` if malformed/missing.

### src/worker.ts — Worker loop

Exports: `WorkerConfig`, `WorkerEvent`, `PiResult`, `invokePi()`, `Worker` class.

`WorkerConfig`: `dbStore`, `projectId`, `token`, `workerId`, `piCommand?`, `maxRetries?` (default 3), `pollIntervalMs?` (default 5000), `projectRoot`, `onEvent?`.

`Worker.start()`: polls for cards, claims, runs pi via `invokePi`, parses verdict, moves card: pass→forward, fail→kickback, blocked→stay, retry≥max→needsHuman.

`Worker.stop()`: stops loop.

---

## Remaining: Phase 2 Step 7 → Phase 6

### Step 7: Repo workspace handling
- Clone/pull project repo into volume
- Per-card branch
- Session cwd inside clone for implementation columns
- Commit with card id
- Need to track branch state per card (add field to DbCard or DbAttempt)

### Step 8: Web board UI
- Served by same Bun server (static + live via websockets)
- Columns + cards view, draggable or button-based moves
- Card detail: threads, attempts, transcripts, artifacts
- Live updates via WebSocket events from `src/ws.ts`
- Plain HTML/CSS/JS, no framework, glance-able
- Manual card moves call the `/api/cards/:id/move` endpoint

### Step 9: Notifications
- Fire existing `async-workload-complete` webhook on:
  - Card enters needs-human / needs-director
  - Retry-exhausted
  - Deploy/done transitions
- Read webhook URL/token from `CLOCKWORK_NOTIFY_URL` and `CLOCKWORK_NOTIFY_TOKEN` env vars (mirror exocortex's `automation/notify.md`)
- Integrate into the `moveCard` path: check destination column name, fire webhook if applicable

### Step 10: Serve compose + deploy
- Dockerfile for Bun app
- `docker-compose.yml` with volumes: db, repos, transcripts, artifacts
- `deploy.sh` with SOPS secrets (git deploy key, webhook token)
- Tailnet-only binding
- Fold into serve's backup pattern
- Acceptance: board reachable, worker loops, real card flows end-to-end on toy project

### Step 11: First real use (director-driven)
- Fable creates first project via API (PROJECT.md, columns with prompts, plan + cards)
- Watch first tens of cards, tune column prompts as data
- THEN scope mobile-game tenant

---

## Key design constraints (from design doc, DO NOT RELITIGATE)
- Machinery stays DUMB — intelligence in column prompts (data), not orchestrator code
- Workers never self-certify; verdicts drive movement; malformed = blocked
- Sessions short, assembled fresh, token-budgeted context
- Kickback = back one column + feedback + retry counter (3) → needs-human
- Model calls via frame-arbiter LOW ports
- exocortex brain/graph is OUT OF BOUNDS — clockwork has its own per-project markdown
- Single worker (frame serializes anyway)
- Tailnet-only, no auth in v1
- SQLite WAL, server-owned
