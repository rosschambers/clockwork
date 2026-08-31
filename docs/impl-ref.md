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

Interfaces: `DbProject`, `DbColumn`, `DbCard`, `DbAttempt`, `DbCardThreadEntry`, plus CRUD input types. `DbCard` includes `dependsOn: string | null` (a prerequisite card id; additive `depends_on` column with an ALTER-TABLE migration for pre-existing databases).

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
- `POST /api/projects/:id/cards` — create (body: `{column_id, title, body?, depends_on?}`; `depends_on` = a card id the scheduler must see reach Done before claiming this card — see AGENTS.md "Authoring cards")
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

`WorkerConfig`: `dbStore`, `projectId`, `token`, `workerId`, `piCommand?`, `maxRetries?` (default 3), `pollIntervalMs?` (default 5000), `projectRoot`, `transcriptsDir`, `tokenBudget?`, `piProvider?` (default `frame-dense-low`), `onEvent?`, `notifyUrl?`/`notifyToken?` (clockwork event webhook, Bearer), `smsUrl?`/`smsToken?` (SMS-to-Ross via exocortex `async-workload-complete`, `{token,message}` body), `milestoneLabel?`, `buildCopyCommand?`. Injectable (setter) hooks: `worker.invokePi` and `worker.repoWorkspace` (a `RepoWorkspaceLike`).

`Worker.start()`: polls, claims (see claim rules below), then per card: prepare a per-card git workspace → run pi via `invokePi` in that workspace → parse verdict (with a grammar-constrained extraction retry on a parse-failure blocked) → commit the card's work on its branch → move card. Movement: pass→forward, fail→kickback (back one column, +1 retry), blocked→kickback (resolves the card, does NOT stay/stall), retry≥max→needsHuman.

**Claim rules (`claimCard`):** never claims a card that is claimed, retry≥max, in a park column (needs-human/director) or the terminal Done column, OR whose `dependsOn` card has not yet reached Done (dependency gate; dangling dep = satisfied).

**Per-card git (via injected `RepoWorkspace`, only when the project has a `githubRepo`):** `prepareCardWorkspace` checks out `card/<id>` off the default branch (idempotent — reuses the branch across the card's stages so earlier stages' commits survive); pi runs with `cwd` = that clone; `commitCardWork` commits after any non-blocked stage; on a card entering the terminal Done column, `mergeCardToMain` merges `card/<id>` into the default branch (so later/dependent cards see the work). No repo configured → runs in the shared `projectRoot`, no branch/commit (fallback).

**SMS + milestone (when `smsUrl`/`smsToken` set):** texts Ross on a card parking at needs-human (with the block reason), and when EVERY card reaches Done fires a milestone-complete text — running `buildCopyCommand` first and including its last stdout line (the shared build path) so play-testing is one step. Best-effort; never affects card processing.

`Worker.stop()`: stops loop.

### Visual QA (per-project, not core) — a pi-skill loaded by a QA column

Not clockwork code: a **pi skill** lives in the target game repo (e.g. prism-drift
`tools/visual-qa-skill/`) and a QA column references its path in `skills` (worker.ts passes each as
`--skill <path>` to pi). The skill renders the game on a GPU (`Xvfb` + nvidia Vulkan, windowed —
NOT `--headless`, which disables rendering), captures a PNG, and POSTs it to the frame-arbiter
`dense` LOW port for a vision verdict against a scenario's `expect` text. Exit 0=pass / 1=fail /
2=blocked; the QA agent maps that to its clockwork verdict, never passing on uncertainty. This is
how a QA column gets "eyes" so it can reject a visually-broken build that still passes logic tests.

---

## Remaining: Phase 2 Step 7 → Phase 6

### Step 7: Repo workspace handling — DONE (2026-08-20)
Implemented in `src/repo.ts` (`RepoWorkspace`) and wired into the worker: clone/pull into
`projectRoot/<projectId>`, per-card `card/<id>` branch (idempotent across stages), pi cwd inside
the clone, commit-with-card-id after non-blocked stages, and `mergeCardToMain` on Done. See the
worker section above. (Was previously built-but-unwired — `index.ts` did `void repoWorkspace`.)

### Step 8: Web board UI
- Served by same Bun server (static + live via websockets)
- Columns + cards view, draggable or button-based moves
- Card detail: threads, attempts, transcripts, artifacts
- Live updates via WebSocket events from `src/ws.ts`
- Plain HTML/CSS/JS, no framework, glance-able
- Manual card moves call the `/api/cards/:id/move` endpoint

### Step 9: Notifications — DONE (2026-08-20)
Two channels in `src/notify.ts`, both wired in the worker:
- `notify()` — the clockwork event webhook (Bearer header, `NotifyEvent` JSON) on
  needs-human/director, retry-exhausted, deploy/done transitions. Config:
  `CLOCKWORK_NOTIFY_URL`/`CLOCKWORK_NOTIFY_TOKEN`.
- `sendSms()` — SMS to Ross via the exocortex `async-workload-complete` webhook
  (`{token,message}` body; see `automation/notify.md`) on a needs-human park (with reason) and on
  milestone completion (all cards Done) with an optional build-copy. Config:
  `CLOCKWORK_SMS_URL`/`CLOCKWORK_SMS_TOKEN`/`CLOCKWORK_MILESTONE_LABEL`/`CLOCKWORK_BUILD_COPY_COMMAND`.

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

### Repo origin must be BARE (merge-push correctness)

`mergeCardToMain` pushes the merged default branch to origin so later/dependent cards
branch off the finished work. A non-bare origin rejects a push to its checked-out branch
(`receive.denyCurrentBranch`). The production origin at `$CLOCKWORK_REPOS/<project>` is
therefore **bare**, created reproducibly by `scripts/ensure-bare-origin.ts` (run at
deploy/setup) — never a hand `git config`. Fallback for an existing non-bare origin that
cannot be recloned: the same script sets `receive.denyCurrentBranch updateInstead`.

### Deploying the studio service (env + run order)

The studio service environment and reproducible deploy steps (every `CLOCKWORK_*` env
var, the bare-origin step, SOPS secrets, and the fresh-checkout run order) are captured
in [`docs/deploy/README.md`](./deploy/README.md) with the systemd unit at
[`docs/deploy/clockwork.service.template`](./deploy/clockwork.service.template).
