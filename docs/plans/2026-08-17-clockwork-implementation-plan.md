# Clockwork — Implementation Plan

**Date:** 2026-08-17
**Prerequisite reading:** `2026-08-17-clockwork-design.md` (all decisions live there).
**Method:** strict TDD (red-green-refactor) for every behavior; `bun test` is the gate.
Trial-before-bake: everything runs ad-hoc first; the serve compose stack comes last.

## Phase 1 — Data core (schema + API)

1. **Schema + store (TDD):** SQLite (WAL) tables — `projects`, `columns` (prompt, skills,
   model, position, per-column extras), `cards` (title, body, column, position, retry_count,
   thread/feedback log as ordered entries, claim state), `attempts` (card, transcript path,
   verdict JSON, timestamps). Failing tests first for every store operation.
2. **REST API (TDD):** CRUD for projects/columns/cards; card movement as an explicit
   `move` operation (records actor + reason); attempt recording; a `next-card` claim endpoint
   for the worker (single worker, but claims still recorded for observability). Bearer token
   optional in v1 (tailnet-only) but the header is honored from day one so adding auth later
   is config, not surgery.
3. **Websocket events (TDD):** every mutation through the API emits an event; a test client
   subscribes and sees the change.

## Phase 2 — The runner (the heart)

4. **Context assembler (TDD):** given (card, column, project files), produce the session
   prompt: PROJECT.md tier + plan slice + card thread (oldest-truncated) + column extras,
   under a configurable token budget. Pure function, heavily tested — this is the most
   important unit in the system.
5. **Verdict parser (TDD):** extract the trailing JSON verdict; malformed -> `blocked`.
   Then the grammar-constrained fallback: a second tiny model call with `json_schema`
   enforcement extracting the verdict from a free-form transcript (integration-tested against
   a real frame model).
6. **Worker loop (TDD with a fake pi):** claim card -> assemble -> invoke runner command ->
   parse verdict -> move card / kick back (feedback + retry counter -> needs-human at 3) ->
   save transcript + artifacts. The pi invocation is injected so tests use a fake; one live
   integration test runs a real `pi -p` against a frame **low port** (through the
   frame-arbiter).
7. **Repo workspace handling:** clone/pull the project repo into the volume; per-card branch;
   session cwd inside the clone for implementation-type columns; commit with the card id.

## Phase 3 — The board UI

8. Web board: columns + cards, live via websockets; card detail shows thread, attempts,
   transcripts, artifacts; manual card moves (a human IS a valid mover). Served by the same
   Bun server. Keep it plain and fast — glance-ability over polish for v1.

## Phase 4 — Notifications + nudges

9. Fire the existing `async-workload-complete` webhook on: card enters needs-human /
   needs-director, retry-exhausted, deploy/done transitions. (Channel + token per
   `automation/notify.md` in exocortex.)

## Phase 5 — Bake onto serve (only after live ad-hoc proof)

10. Compose stack + `deploy.sh` + SOPS (git deploy key, webhook token); volume layout
    (db, memory files, repos, transcripts, artifacts); fold the volume into serve's backup
    pattern; tailnet-only binding. Verify from ground truth: board reachable, worker loops,
    a real card flows Backlog -> Done end-to-end on a toy project.

## Phase 6 — First real use (director-driven)

11. Fable creates the first project via the API (PROJECT.md, columns with tuned prompts,
    the initial plan + cards) at a check-in. Watch the first tens of cards closely; tune
    column prompts as data. THEN scope the mobile-game tenant project as its own design.

## Verification gates

- Every phase: `bun test` green, output pristine.
- Phase 2 gate: a live scoped task flows through a real frame model end-to-end with a real
  verdict, preempted correctly when a Hugo request arrives (arbiter low-lane proven in situ).
- Phase 5 gate: the acceptance walk on serve from ground truth, not a green deploy.

## Deferred (do not build in v1)

Planning chat, UI wizard, auth, scheduled director sessions, graph memory, multi-worker.
