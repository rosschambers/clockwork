# clockwork — AGENTS.md

Kanban-state-machine build platform. Bun + TypeScript, SQLite (WAL), websockets, pi workers
against frame local models. Built strictly test-first.

## Source of truth

`docs/plans/2026-08-17-clockwork-design.md` holds every locked decision (19 of them) — read it
before changing behavior; do not re-litigate settled decisions without cause. The phased build
order is `docs/plans/2026-08-17-clockwork-implementation-plan.md`.

## Documentation upkeep — required with every major change

Two operator documents describe how humans and directors USE clockwork, and they go stale
silently. **Any major behavior change — card fields, the deliverable gate, verdict flow,
retry/park semantics, API endpoints, column conventions, bootstrap defaults — must include a
review of both, updating them if the change affects authoring or onboarding:**

1. `docs/new-tenant-runbook.md` (this repo) — how a new project gets onto the pipeline.
2. The exocortex skill `.opencode/skill/clockwork-card-authoring/SKILL.md` (in the exocortex
   superrepo) — the field-by-field card authoring reference agents load before touching the
   board.

Treat a skipped review like a skipped test: the next director session will author cards
against the OLD contract and cards will wedge.

## Commands

| Command | Purpose |
|---------|---------|
| `bun install` | Install dependencies |
| `bun run check` | **The gate: `tsc --noEmit` + `bun test`.** Run this before committing. |
| `bun test` | Run the test suite only |
| `bun run typecheck` | Type-check only (`tsc --noEmit`) |

**Always run `bun run check`, not just `bun test`.** A green test suite alone once hid 145
type errors and a completely unwired integration layer (`index.ts` didn't compile; the worker
never assembled context, recorded attempts, or respected park columns). Type-check is
non-negotiable.

## Non-negotiables (from the design)

- The machinery stays DUMB — intelligence lives in column prompts (data), written plans, and
  verifier stages. No agent-to-agent reasoning.
- Workers never self-certify; verdicts drive card movement; malformed verdict = blocked.
- Sessions are short and assembled fresh (tiered, token-budgeted context) — never a long
  shared conversation.
- Kickback carries feedback; retry counter (3) parks cards at needs-human. No infinite loops.
- Model calls go through the frame-arbiter LOW ports — clockwork is background work by
  definition; Hugo preempts it.
- exocortex's brain/graph is out of bounds — clockwork has its own per-project markdown memory.

## Diagnosing a stuck card — telemetry that is TRUE vs telemetry that LIES

Read this before you ever conclude a worker is "wedged" and restart the service. On 2026-08-27
an operator misread a **legitimately slow Code-Review** as a hang and restarted clockwork three
times, killing a live in-progress session each time — the operator was the only thing preventing
that card from finishing. The restarts, not the card, were the problem.

**Signals that LIE (never conclude "stuck" from these):**

- **`ps` for a pi/godot process.** A point-in-time `ps` snapshot routinely shows nothing even
  while a pi session is actively streaming — the process name/args do not match a naive grep, and
  short-lived tool subprocesses come and go between samples. "No process in `ps`" does NOT mean
  no session.
- **Worker-log silence.** The worker only logs stage TRANSITIONS (`claimed`/`running`/`passed`/
  `blocked`), not per-token progress. A genuinely-working session on a ~14 t/s local model reading
  a large diff can emit zero log lines for 15–30 minutes. Silence ≠ stuck.
- **A `running` event with no visible follow-up.** Same reason — that is the normal look of a long
  turn in progress.

**Signals that are TRUE (use these):**

- **Transcript byte growth.** `wc -c` the newest `attempt-*.txt` under
  `.clockwork-data/transcripts/<project>/<card>/` twice, ~90s apart. Growing = alive and working.
  Flat over a FULL cycle (not 60s — a slow model can pause mid-turn) starts to suggest trouble.
- **Transcript tail.** `tail -c 400` the newest attempt: a terminal event
  (`"stopReason":"stop"..."willRetry":false}` then `## stderr`) means the attempt ENDED (its
  flatness is completion, not a hang); mid-stream JSON means it is still going.
- **Backend activity.** On frame, `journalctl -u llama-server-dense.service --since '20 seconds ago'`
  — `slot ... print_timing` / `launch_slot_` lines mean a model turn is generating right now.
- **`/proc/<bunpid>/task/*/children`** — the RELIABLE no-sudo liveness check (use this instead of
  a `ps | grep pi` that misses the process). If the bun worker has a `pi` child, read its age with
  `ps -o etimes= -p <childpid>`: a pi child alive for tens of minutes means the session is running,
  full stop — even if the transcript is flat and the worker log is silent.
- **Do NOT assume "preemption" — PROVE it from the arbiter's attribution log.** It is tempting to
  explain a flat-transcript live pi child as "Hugo preempted it on the LOW port." On 2026-08-28
  that explanation was FALSE for an entire session: the frame-arbiter logs one JSON line per high
  request (`{"event":"high","model":...,"source":<ip>}`) and per preemption
  (`{"event":"preempt","cancelled":N}`) — and across the whole session there were **2 high events
  (to a different model) and ZERO preempt events.** Nothing ever preempted the dense model
  clockwork uses. The "preemption" strings seen in transcripts were the MODEL READING the
  visual-qa skill's own docs (which contain "arbiter preemption / connection closed by Hugo") plus
  game-code line numbers — pure false positives. Before believing preemption: on frame run
  `journalctl -u frame-arbiter.service | grep '"event":"preempt"'` (and `"event":"high"`) for the
  window in question. No preempt events = not preemption, period. A flat transcript on a live pi
  child with no preempt events is either a genuinely slow turn (wait) or the LOW request buffered
  server-side (a real bug — the arbiter LOW path must STREAM, not buffer).
- **`sudo strace -f -p <bunpid>`** (needs Ross — the agent cannot ptrace). `recvfrom(<sock>, "{\"type\":\"message_update\"...`
  is the definitive proof of a live streaming session. This is what finally settled it.

**Rule:** a stall requires transcript bytes flat AND backend idle for a full 30-minute cycle.
Then investigate read-only and surface it — **never auto-restart the service to "unwedge" it.**
Restarting throws away a possibly-live session and its uncommitted work.

## Authoring cards — targets and dependencies

### Declare `targets` explicitly for cards that produce code

The **deliverable gate** blocks a card from advancing past Implementation unless the branch
diff touches at least one declared target file. If no targets are declared (empty array), the
gate does not fire and the card advances freely.

- **On the API:** pass `targets: ["scripts/grid.gd", "tests/test_grid.gd"]` in the card
  creation body (`POST /api/projects/:id/cards`), or set them later via
  `POST /api/cards/:id/rescope` with `{ targets: [...] }`.
- **In the card body (auto-parse fallback):** add a line `targets: scripts/main.gd, project.godot`
  or write `Only scripts/main.gd should change.` — the parser extracts file paths from these
  conventions. Tokens must look like file paths (contain a `/` or have a recognized extension
  like `.gd`, `.ts`, `.json`, `.tscn`); plain English words are ignored.
- **Planning/doc cards** that do not produce code files should have empty targets (`targets: []`
  or omit targets entirely). The gate only fires from the Implementation column onward.
- **Why it matters:** without explicit targets on code cards, the gate cannot verify that the
  model actually edited the files it claimed to edit. With WRONG targets (non-file-path
  garbage), the gate fails every time and the card loops forever. Always set targets to the
  actual file paths the card should modify.

### Populate `depends_on` for ordered work

When you queue a card that **needs another card's work to already be on `main`**, set its
`depends_on` to the prerequisite card's id. The scheduler will not claim a card until its
`depends_on` card has reached the terminal **Done** column (where the worker merges the card
branch into `main`), so dependents never run early.

- **Field:** `depends_on` (card id) on the create-card API body:
  `POST /api/projects/:id/cards` → `{column_id, title, body?, depends_on?}`. Null/omitted =
  no dependency (runs whenever eligible). Only a single prerequisite is supported; for a
  linear plan, chain each card to the one before it (1 ← 2 ← 3 …).
- **Why it matters:** without it, dependency-chained cards get claimed and run BEFORE their
  prerequisite is done, fail their in-prompt dependency check, burn all 3 retries, and park
  at needs-human (firing a needless "blocked" SMS each time). Stating the dependency in the
  card body text is NOT enough — that is only a prompt-level self-check; `depends_on` is the
  real scheduling gate. (This bit us on the prism-drift M1 render chain, 2026-08-20.)
- **A dangling `depends_on`** (referenced card deleted) is treated as satisfied, so a card
  can never wedge forever on a missing prerequisite.
- Independent cards need no `depends_on` and still run in parallel-eligible order.

## Style

TypeScript, ES modules, `function` declarations top-level, explicit return types on exports,
no nested ternaries, tabs. Same conventions as frame-arbiter.
