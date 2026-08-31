# Clockwork Observability — Board + Card Redesign (Design)

**Date:** 2026-08-21
**Status:** Approved (look locked via interactive playground — Ross deciding-by-seeing).
**Playground:** `docs/plans/clockwork-observability-playground.html`.

## Why

The current board (`public/index.html`, ~301 lines, vanilla HTML/CSS/JS + WebSocket) shows
only a title, a small meta line, and a retry count per card — and no board-level view. This
session made painfully clear that the operator (Ross/agent) cannot see what matters at a
glance: how long a card has been processing, how many tokens it is burning, what it depends
on, and — critically — how often the arbiter is preempting clockwork's work (the root cause
of every render-card stall was invisible preemption). This redesign surfaces that.

## Scope

Improve observability across two coordinated surfaces on the existing single-page board,
plus the data plumbing to feed them. Full scope was chosen ("everything including real
tokens"), with token capture gated behind a verify-first probe.

## Locked look (from the playground)

- **Global stats = a collapsible DASHBOARD PANEL** (not just a header bar) for deeper
  analytics, with an **arbiter-interrupt COUNTER** beside a **sparkline-bar graph** of
  preemptions over time.
- **Each card shows:** a status dot (color by state), current stage, **live elapsed /
  processing time** (ticking while running), **token count**, **retry count (n/3)** and
  **arbiter-preemption count**, and **dependency badges** — both "needs X" (its `dependsOn`)
  and "unblocks Y" (reverse dependency).
- **Density / look:** card padding 7px, corner radius 5px, **outline** (subtle) badges,
  accent hue ~345, keeping clockwork's dark navy base (`#1a1a2e` / `#16213e` / `#0f3460`).
- **Motion:** live-ticking elapsed timers + a subtle pulse on the running card's status dot.
- **Stay framework-free:** single-file vanilla HTML/CSS/JS + the existing WebSocket live
  updates. No build step, no framework.

## Data model / capture work

Three data sources feed the UI. Two are "surface existing data"; two need new persistence.

1. **Elapsed / processing time — SURFACE EXISTING.** `DbAttempt` already has `startedAt` /
   `completedAt`. A running card's elapsed = `now − (its in-flight attempt.startedAt)`; a
   finished stage's duration = `completedAt − startedAt`. Expose via the card/attempt API;
   the client ticks it live.

2. **Dependencies — SURFACE EXISTING.** `DbCard.dependsOn` already exists (added this
   session). Expose it AND compute reverse deps (which cards name this card as their
   `dependsOn`) so a card can show both "needs X" and "unblocks Y".

3. **Arbiter preemptions — NEW PERSISTENCE.** Preemptions are currently only emitted as
   worker events / logs (the preemption-retry fix, this session). Persist each as a
   timestamped event row (project, card, stage, timestamp) so the UI can show a **total
   counter** and a **time-series** (5-minute buckets) for the sparkline. Add an API endpoint
   returning the count + the bucketed series for a project.

4. **Token usage — NEW CAPTURE (verify-first).** pi does not currently report tokens to
   clockwork. **Task 0 of the plan is a probe:** run pi `--mode json` (it exists) and/or the
   model-server `usage` block and confirm prompt+completion token counts are obtainable. If
   yes, capture per-attempt tokens and aggregate per card/project. If the probe fails, fall
   back to a labelled *estimate* from assembled-context size (`assembleContext` already
   computes a token count) — clearly marked as approximate — rather than dropping the feature.

## Components & acceptance criteria (binary)

### A. Data / DB
- [ ] A `preemptions` (or `events`) table persists each arbiter preemption with
      `projectId, cardId, columnId/stage, createdAt`. Migration is additive.
- [ ] The worker's preemption-retry path (worker.ts) writes one such row per preemption.
- [ ] `DbAttempt` gains a nullable `promptTokens` / `completionTokens` (or a single
      `tokens`) — additive migration — populated from pi when available.
- [ ] A DB method returns, for a project: total preemptions and a bucketed time-series.

### B. API
- [ ] `GET /api/projects/:id/stats` returns `{ preemptionsTotal, preemptionSeries[],
      inFlight, cardsDone, totalTokens }` for the dashboard panel.
- [ ] The cards list / card detail expose per-card: current stage, in-flight attempt
      `startedAt` (for live elapsed), `dependsOn`, reverse-deps, retry count, per-card
      preemption count, per-card token total.
- [ ] A `preemption` (or generic stat) change is broadcast over the existing WebSocket so
      the panel updates live.

### C. UI (`public/index.html`)
- [ ] A collapsible dashboard panel shows the interrupt counter + a sparkline-bar graph of
      preemptions over time, in-flight count, cards done, total tokens.
- [ ] Each card renders: status dot (running/idle/blocked/done colors), current stage, live
      elapsed time (ticks each second when running), token count, retry (n/3), preemption
      count, and dependency badges (needs-X + unblocks-Y) — all as subtle outline badges.
- [ ] Density matches the locked look (padding 7, radius 5, hue ~345, navy base) and the
      running dot pulses.
- [ ] No framework/build added; still a single HTML file driven by the existing REST +
      WebSocket.

### D. Token probe (Task 0, gating C's token badge)
- [ ] A short investigation confirms whether pi `--mode json` or the model-server `usage`
      block yields real token counts; the plan's token tasks branch on the result
      (real capture vs. labelled context-size estimate).

## Assumptions
- The board stays a single vanilla file served by the existing Bun server; no framework.
- SQLite additive migrations follow the established `ALTER TABLE … ADD COLUMN` (try/catch)
  and `CREATE TABLE IF NOT EXISTS` patterns.
- WebSocket event plumbing (`src/ws.ts`) is reused; new event types follow the existing shape.
- `bun run check` (tsc + tests) remains the mandatory gate; work is test-first.

## Deferred (not this round)
- Per-stage timing distribution charts / token trend charts inside the panel (the panel is
  built collapsible with room for them later).
- Cost estimation from tokens (needs a price model).
- Cross-project / historical dashboards beyond the current project.

## Reference
- Playground: `docs/plans/clockwork-observability-playground.html`.
- Preemption root cause + fix: `docs/plans/2026-08-21-impl-writes-plan-not-code-investigation.md`.
- Current UI + data: `public/index.html`, `src/db.ts` (`DbCard`, `DbAttempt`), `src/api.ts`, `src/ws.ts`.
