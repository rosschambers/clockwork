# Clockwork Hands-Off Hardening — Design

**Date:** 2026-08-21
**Status:** Approved (all 4 sections, with Ross). Render-pipeline work is PAUSED until this
is implemented.

## Governing rule

**If managing clockwork requires touching it by hand, that is a bug in clockwork.**

The measure of every decision here is: *does this let the manager run clockwork hands-off?*
Anything that forces a manual intervention — writing product code, editing config live,
poking the DB, `rm -rf`-ing a workspace, re-queuing by ad-hoc script, SSH+journal spelunking
to find out why a card is stuck — is a **system defect to close**, not a task to keep doing.
This supersedes the earlier "machinery vs product" framing: the real line is hands-off
manageability. The manager fixes clockwork's machinery and acts as director (authoring/
re-scoping cards, tuning column prompts) through first-class controls — and NEVER hand-writes
the product, because the system should never require it.

## Why now

Over a long session the manager repeatedly had to reach in to keep the render pipeline
moving. Each reach-in is evidence of a missing autonomous capability or a missing director
control. This effort catalogs every one and closes it, so blocks become **either self-healed
by the machinery or routed to the director as a one-click decision** — never a hand-fix.

## The manual interventions this session → the systemic fix that removes each

| Manual intervention (the smell) | Systemic fix (the cure) | Section |
|---|---|---|
| Hand-wrote `scripts/main.gd` | deliverable gate + retries + director re-scope (never hand-code) | §2, §3 |
| Hand-edited the shared visual-QA scenario | per-card verification contracts | §1 |
| `git push` the stranded merge; `git config … updateInstead` on studio | merge-push fix (done) + pipeline repo bare/configured **in setup** | §4 |
| Unparked cards / reset `retry_count` via the DB | first-class director actions (requeue, reset, re-scope) via API/board | §3 |
| `rm -rf` wedged / stale workspaces | self-healing workspace (partial-clone recovery done) + stale-branch prune on clone | §4 |
| Re-queued the render chain repeatedly by script | stable "load a plan as a card chain" director command | §4 |
| Bumped the watchdog; added preemption-retry | done (machinery) + planned inactivity-watchdog + claim-lease (separate plans) | (prior) |
| SSH+journal+DB spelunking to diagnose blocks | observability board (separate plan) + classified park reasons | §3 |

## Section 1 — Per-card verification contracts

**Problem:** the shared `tools/visual-qa-skill/scenarios/main.yaml` asserts the FINAL M1 look
(wave counter, build tray, themed threats), so a mid-chain card fails visual QA for features
it isn't responsible for. Card 2 (space backdrop) verified its own work correct at pixel
level but failed because a wave counter M1 has no logic for was demanded. The only unblock
today is hand-editing shared config — a reach-in.

**Fix:** a card owns its verification contract.
- The visual-QA skill selects **the card's own scenario** when one exists (resolved from the
  card — e.g. `CLOCKWORK_CARD_ID` env, already present, mapping to a per-card scenario file, or
  a scenario path the card body/plan names), else falls back to the shared baseline.
- The shared baseline asserts ONLY what is true from the layout foundation onward; stage
  specifics live in per-card scenarios. Authoring scenarios is a director/card-planning step,
  not a runtime hand-edit.

**Acceptance:**
- [ ] The visual-QA skill uses a per-card scenario when present, else the shared baseline.
- [ ] A mid-chain card cannot fail for a later card's feature.
- [ ] Scenario authoring flows through card planning (director), never a live hand-edit.

## Section 2 — Deliverable-exists gate (honest completion)

**Problem:** a card reached Done having committed only a plan doc — Implementation never
wrote code, yet Review/QA passed it and it merged. A green check on undone work is exactly
what tempts a hand-fix.

**Fix (layered, deterministic first):**
- A card declares its target artifact(s) (a `targets` field or the existing card-body
  convention "Only main.gd / project.godot / main.tscn").
- A stage (worker-side check and/or Code-Review) computes `git diff --name-only
  <base>..<card-branch>` and **fails** the card if declared code targets are unchanged (diff
  is docs-only when code was required). Deterministic — a model can't reason around it.
- The Code-Review column prompt adds the judgment layer ("reject if the deliverable isn't
  actually present / implemented, not just a plan").

**Acceptance:**
- [ ] A card declaring code targets whose branch diff touches only `docs/` is failed with a
      clear reason.
- [ ] Cards with no declared targets (planning/doc cards) are unaffected.
- [ ] The core check is git-diff deterministic, not solely prompt-dependent.

## Section 3 — Director-decision routing (blocks become routed choices)

**Problem:** an exhausted card silently parks at Needs-Human — a dead-end that tempts a
hand-fix. Every reach-in started with "a card is stuck, I'll just fix it."

**Fix:** a park emits a structured decision, not just a notification.
- Classify the park reason (`scope-mismatch` / `deliverable-missing` / `dependency` /
  `genuine-failure` / `preemption-exhausted`) and store it on the card/attempt.
- Surface the parked card with **director actions**: relax/replace scenario · re-scope card ·
  reassign · adjust dependency · abandon · retry-as-is · requeue-fresh — on the board and in
  the SMS/decision record.
- Every action is a director/machinery operation performed **through the pipeline** (edit the
  card, reset+requeue, adjust scenario/dep) — none require writing product code. The decision
  menu itself enforces the boundary.

**Acceptance:**
- [ ] A parked card records a classified reason (not just free text).
- [ ] The park surfaces a structured director-action set (board + SMS/record).
- [ ] Every offered action is a director/machinery op; none require hand-writing product.
- [ ] The default path from a park is "route a decision," not "sit silently."

## Section 4 — Hands-off operability (close every remaining hand-touch)

**Fix:** turn the remaining manual operations into setup/config or first-class director
controls.
- The pipeline repo (`~/.clockwork-data/repos/<project>`) is **bare** (or `updateInstead`)
  **as part of project/setup**, so merge-push never needs a hand `git config`. The
  merge-to-origin path (fixed in code, `mergeCardToMain` now pushes) then works unattended.
- Stale `card/*` branches are pruned on workspace clone/prepare (so leftover branches can't
  be mis-verified or accumulate).
- First-class director operations exposed via API + board (and thus scriptable/one-click),
  replacing DB pokes and ad-hoc scripts:
  - requeue a card fresh; reset retry count; re-scope (edit) a card; set/replace a card's
    scenario; adjust a card's `dependsOn`; abandon a card;
  - **load a plan as a dependency-ordered card chain** (replaces the throwaway
    `queue-render.py` — a stable "seed cards from a plan" command).
- Studio-only config (service env: SMS, watchdog, workspace paths; repo bare/config) is
  captured into the repo/config so a redeploy or new host reproduces it (not disk-only).

**Acceptance:**
- [ ] The pipeline repo is bare/`updateInstead` via setup, not a hand `git config`.
- [ ] Stale `card/*` branches are pruned on clone/prepare.
- [ ] requeue / reset-retry / re-scope / set-scenario / adjust-dep / abandon /
      load-plan-as-chain are first-class API (and board) actions.
- [ ] The studio service env + repo config are captured in the repo/config, reproducibly.

## Constraints / assumptions
- All clockwork house rules hold: `bun run check` gate, strictly test-first, TypeScript ES
  modules, additive SQLite migrations only (the live studio DB must survive redeploy),
  machinery stays dumb (intelligence in prompts/plans/verifiers), single worker, framework-free board.
- Reuses existing seams: worker env already carries `CLOCKWORK_CARD_ID`; `RepoWorkspace` owns
  git; `src/api.ts` routing + `src/ws.ts` events; the visual-QA skill lives in the game repo.
- This design composes with, but is separate from, the already-written plans:
  observability (`2026-08-21-observability-*`), pi watchdog+streaming
  (`2026-08-20-pi-watchdog-streaming-plan.md`), and claim-lease
  (`2026-08-20-claim-lease-heartbeat-plan.md`).

## Deferred
- Full role model beyond director/manager (e.g. a separate CTO approval lane) — not needed yet.
- Auto-relaxing scenarios by inference — scenarios are authored per card, not guessed.

## Reference
- The manual-intervention log above is drawn from the 2026-08-19/20/21 daily notes + inbox.
- Related fixes already landed this session: RepoWorkspace wiring, merge-on-Done (+push),
  dependency ordering (`depends_on`), preemption-retry, startup claim-recovery, non-git
  workspace self-heal, 45-min watchdog stopgap.
