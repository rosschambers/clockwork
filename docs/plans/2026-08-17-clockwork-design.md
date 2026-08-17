# Clockwork — Design

**Date:** 2026-08-17
**Status:** Design approved (all decisions below made with Ross in-session); implementation plan in
`2026-08-17-clockwork-implementation-plan.md`.

## What it is

A lightweight autonomous build platform: a **kanban board as a state machine**. Cards flow left
to right through **prompt-defined columns**; a single generic worker loop runs **pi** sessions
against frame's local models to act on whichever column a card sits in — implementing,
verifying, reviewing, deploying. Humans watch a live web board; a **director** (an Opus-class
agent, "Fable") checks in periodically through an API to plan, verify, and steer. Everything
runs in a container on serve.

The first tenant project will be a mobile game, but the platform is general: multiple boards,
multiple projects.

## Why (lessons this design encodes)

- **Grimoire/Paperclip lesson:** a company of agents reasoning agent-to-agent compounds errors;
  one-shots often beat the whole apparatus. So: the machinery stays DUMB. Intelligence lives in
  written plans (director), verification (free adversarial local instances), and column prompts
  (editable data) — never in orchestrator-to-orchestrator chatter.
- **Context constraint:** local models have ~256K degrading well before the limit (vs Opus 1M).
  So: every session is SHORT and self-contained, assembled fresh from written artifacts. No long
  shared conversations.
- **"A green ticket is not done":** workers never self-certify. Separate verifier stages, run by
  separate local instances (effectively free), gate every advance and kick back with feedback.

## Operating model

- **Director (Fable/Opus):** plans at check-ins — writes PROJECT.md, decomposes goals into
  cards, adjusts column prompts, reviews stuck/flagged cards, verifies results. Drives the
  platform via the API. Check-ins are human-initiated; the platform NUDGES via SMS when
  attention is needed (needs-director cards, retry-exhausted, pile-ups at human gates).
- **Workers (frame local models via pi):** one worker loop, one card at a time (frame's
  `parallel=1` slots serialize anyway — more workers would only queue). Each card-session is
  fresh, scoped, and short.
- **Humans (Ross + Jenn):** watch the live board, review cards at human gates, set goals.
  Longer-term: an in-page planning chat (local models + brainstorming/plan-writing/kanban
  skills) lets Jenn create plans without agent tooling.

## Core abstraction — columns as data

A **column** = a database row:

| Field | Meaning |
|-------|---------|
| `prompt` | What an agent must do to a card in this column (the stage's system prompt) |
| `skills` | Baseline pi skills loaded for this stage (capabilities ARE skills, expanded as needed) |
| `model` | Which frame model this stage uses (per-stage routing, a text field) |
| `verdict contract` | All stages end with a structured JSON verdict (see below) |

A **card** can add extra skills/context for its specific need (a UI-feature QA card loads an
app-inspection skill; a logic-only card doesn't).

**One generic runner** executes any card in any column:

```
claim next card -> assemble context -> run pi (short session) -> parse verdict
  -> advance | kick back with feedback | park for human
```

Columns are unlimited in the schema and editable live (the director tunes prompts at
check-ins); START with a small sharp set (~6) — many vague stages would re-grow the Grimoire
error-compounding.

Initial pipeline shape (editable data, not code):

```
Backlog -> Impl-Planning -> Implementation -> Code-Review -> QA -> Deploy -> Done
                                  ^\_____________(kickback with feedback)____/
                      + Needs-Director / Needs-Human park columns
```

## The verdict contract

Every session ends by emitting exactly one JSON object:

```json
{ "verdict": "pass" | "fail" | "blocked", "feedback": "…", "artifacts": ["path", "…"] }
```

- The runner parses the output tail; **malformed = blocked** (safe default).
- Because generic local models can be format-sloppy: the verdict can be extracted by a separate
  tiny final call using llama.cpp's **grammar-constrained output** (`json_schema`/GBNF), which
  makes invalid JSON impossible. Work free-form, extract constrained.

## Kickback + retry

- A verifier rejection moves the card BACK one column with the feedback attached to the card's
  thread.
- A **retry counter** increments per bounce; after N retries (default 3) the card auto-moves to
  **needs-human** and fires a notification. Bounded compute — no silent infinite loops.
- Workers never move their own cards to Done; verdicts drive movement, verifier stages gate
  every advance.

## Context assembly (the 256K discipline)

Each session's prompt is assembled fresh, tiered, and token-budgeted:

1. `PROJECT.md` — short stable brief (vision, standards, conventions).
2. The **plan slice** relevant to this card.
3. The **card + its feedback/retry thread** (truncate oldest-first).
4. Column-declared extras (a diff for code-review, and so on).

Implementation-type columns run with the session's working directory inside the repo clone, so
pi's native read/bash/edit tools pull code on demand — curated context is pushed, code is
pulled. Cards are scoped SMALL (a planning-stage responsibility) so in-session code reading
stays within budget.

## Memory

- **Per-project markdown files** in the container volume (PROJECT.md, plan files, notes) —
  the same agent-files discipline as exocortex/Hermes. Updated at stage transitions and
  check-ins.
- **Decoupled from exocortex's brain/graph** — a low-stakes place to learn what the agents
  actually need to recall. Graph memory (Obsidian-style or otherwise) is a FUTURE option, only
  after the base works; any exocortex-graph migration is a separate later decision.

## Architecture

One Docker Compose stack on serve (per serve convention, `deploy.sh` + SOPS secrets):

| Component | Choice | Notes |
|-----------|--------|-------|
| Server | **Bun + TypeScript** | HTTP API + websockets natively (`Bun.serve`); same runtime as frame-arbiter |
| Database | **SQLite (WAL)** | Owned exclusively by the server process; worker + UI go through the API. Single-file backup |
| Worker | Same runtime, single loop process | Runs `pi -p` per card against frame; claims cards via the API |
| Web UI | Served by the server, websocket live updates | Boards, cards, transcripts, artifacts; glance-able progress |
| Models | frame via the **frame-arbiter LOW ports** | Clockwork is the arbiter's first real background consumer; Hugo preempts it automatically |
| Notifications | Existing `async-workload-complete` webhook (SMS / ntfy) | Fired on needs-human/needs-director entry, retry-exhausted, deploy/done |
| Work-product | Dedicated GitHub repo per project, cloned in the volume | Sessions work on branches, commit with the card id; scoped deploy key via SOPS |
| Artifacts | Per-card directory in the volume | Verdict `artifacts[]` paths; served/downloadable in the UI |
| Transcripts | Every session saved to `project/card/attempt-N/` | Linked from the card; the debugging surface at check-ins |
| Access | **Tailnet-only**, no auth/identity for v1 | Household-only; auth (maybe murmur8 logins) is a future item |

## Decisions locked (session 2026-08-17)

1. Director plans at check-ins; a local planner may DRAFT between them, drafts gate through
   needs-director review — never straight to execution.
2. Single worker process (frame serializes anyway); parallelism only if hardware grows.
3. Structured JSON verdict, malformed = blocked; grammar-constrained extraction as the
   reliability backstop.
4. No viability pilot gate — accepted risk: good models + well-planned scoped work + free
   iteration will get there; the autonomous system itself is the goal.
5. Tailnet-only, no identity/auth in v1; future: maybe murmur8 logins.
6. Work-product = dedicated GitHub repo, cloned in the volume, branch-per-card.
7. SQLite (WAL), server-owned.
8. Websocket events pushed by the server on every mutation (all mutations flow through it).
9. Bun + TypeScript.
10. Per-column model routing (a schema field from day one).
11. Tiered, budgeted context assembly; code read on demand in-workspace.
12. Notifications reuse the existing SMS/ntfy webhook.
13. v1 bootstrap: NO template — the director creates projects/columns/plans/cards via the API.
    Future: a UI wizard augmented with frame-LLM calls (for Jenn); Ross may keep using the
    director.
14. Full session transcripts + artifacts persisted and viewable per card.
15. serve Docker Compose stack, SOPS secrets, volume folded into serve's backup pattern.
16. Check-ins are human-initiated; the platform nudges via SMS.
17. Kickback = back one column + feedback + retry counter (default 3) -> needs-human.
18. Memory = per-project markdown; graph memory later, exocortex untouched.
19. Name: **clockwork**.

## Explicitly out of scope

- **The mobile game itself** (engine choice, art pipeline, store submission) — that is a tenant
  PROJECT run on clockwork, designed separately once the platform runs.
- Graph memory / exocortex graph migration.
- Multi-user auth, the in-page planning chat, the UI project wizard (designed-for, phase 2+).
- Multi-worker parallelism.

## Future items (recorded, not built)

- In-page **planning chat** (local models + brainstorming/plan-writing/kanban-interaction
  skills) so Jenn can plan conversationally; converges with the "local planner drafts" role.
- UI project-creation wizard with frame-LLM augmentation.
- Auth (murmur8 logins or other).
- Scheduled autonomous director sessions (the API must not preclude them).
- Graph memory.
