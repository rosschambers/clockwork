# Clockwork Hands-Off Hardening — Studio Redeploy Plan

**Goal:** Get the merged hardening (`main` @ `c8b6ea5`) running as the live studio
clockwork service, safely, taking the deploy all the way up to — but **not including** —
activation. Ross runs the final privileged step (starting the user service). The agent
proves the new code builds, the additive migrations apply to the *live* database without
data loss, and every prerequisite is in place; then hands off.

**Scope:** This is a *redeploy of an existing install*, not a fresh-host bring-up (that is
`docs/deploy/README.md`). The differences below are what this plan handles.

---

## Ground truth (verified on studio 2026-08-21)

| Fact | Value | Implication |
|------|-------|-------------|
| Service unit | `~/.config/systemd/user/clockwork.service` (hand-rolled, not nix) | Update in place; no nix rebuild. |
| Service state | **inactive** (stopped earlier this session) | Safe to redeploy; nothing running. |
| Source checkout | `/home/<user>/Documents/GitHub/clockwork` — a **real standalone clone** of `git@github.com:rosschambers/clockwork.git`, on `main` @ `5786e01` (pre-hardening) | Must `git pull` to `c8b6ea5`. NOT a symlink into exocortex. |
| Entry | `ExecStart=/run/current-system/sw/bin/bun run src/index.ts`, `WorkingDirectory` = that checkout, `HOME=/home/<user>/.clockwork-home` | Unchanged. |
| bun | `1.3.13` on studio; dev built on same | Version parity. |
| Live DB | `/home/<user>/.clockwork-data/db/clockwork.sqlite`, 315 KB, **13 card rows** | Must survive. `cards` has `depends_on` but **not** `targets`/`scenario`. |
| Origin repo | `/home/<user>/.clockwork-data/repos/prism-drift` — **non-bare**, `receive.denyCurrentBranch = updateInstead` | Already the Task 2 fallback state. Merge-push works. `ensure-bare-origin.ts` would report `converted` (idempotent no-op). |
| `CLOCKWORK_REPOS` | `/home/<user>/.clockwork-data/workspaces` (per-project **clone** parent) | NOTE: on studio this is the clone parent, and the origin lives separately under `repos/`. The `ensure-bare-origin` deploy step targets the **origin** path, not `$CLOCKWORK_REPOS`. |
| Project id | `a2afe5dc-1459-4201-9a7d-90152b4ab7e9` | The render project. |

**The single biggest risk** is the DB migration: the new code adds `targets TEXT` and
`scenario TEXT` to `cards` via `ALTER TABLE … ADD COLUMN` in try/catch, mirroring the
already-live `depends_on` column. This plan proves that on a **copy** of the live DB
before touching the real one.

---

## Assumptions

- The agent never runs `systemctl --user start/enable`, never activates. Ross does.
- No secret values are written to the repo or to any committed file.
- The redeploy is additive/reversible: a DB backup is taken; the old checkout commit is
  recorded so a rollback is a `git checkout <old>` + restart.
- `bun run check` is green on `main` @ `c8b6ea5` (verified at merge: 261 tests, tsc clean).

---

## Steps

### Step 0 — Pre-flight backup + record rollback point (agent)

1. Back up the live DB (WAL-safe copy):
   ```
   ssh studio 'cp -v /home/<user>/.clockwork-data/db/clockwork.sqlite \
     /home/<user>/.clockwork-data/db/clockwork.sqlite.bak-$(date +%Y%m%d-%H%M%S)'
   ```
2. Record the current checkout commit for rollback:
   ```
   ssh studio 'cd /home/<user>/Documents/GitHub/clockwork && git rev-parse HEAD'
   ```
   Expect `5786e01…`. Note it in the daily log.

**Acceptance:** a timestamped `.bak-*` file exists; the old HEAD is recorded.

### Step 1 — Prove the migration on a COPY of the live DB (agent, non-destructive)

Before updating the real checkout, run the new code's migration against a *throwaway copy*
of the live DB and confirm the columns appear and the 13 rows are intact.

1. On studio, in a scratch dir, check out `main` @ `c8b6ea5` (or fetch in a temp clone),
   `bun install`.
2. Copy the live DB to `/tmp/clockwork-migration-test.sqlite`.
3. Point the new code's `DbStore` at the copy (a tiny script `new DbStore(copyPath)` triggers
   the constructor migrations), then `PRAGMA table_info(cards)`.

**Acceptance (binary):**
- `targets` present ✓, `scenario` present ✓, `depends_on` still present ✓.
- `SELECT COUNT(*) FROM cards` still returns **13**.
- No exception thrown by the `DbStore` constructor.

If any fails: STOP, do not proceed; investigate the migration.

### Step 2 — Update the studio checkout to the merged main (agent)

```
ssh studio 'cd /home/<user>/Documents/GitHub/clockwork \
  && git fetch origin \
  && git checkout main \
  && git pull --ff-only origin main \
  && git rev-parse HEAD'
```
Expect `c8b6ea5…`.

Then install deps against the new tree:
```
ssh studio 'cd /home/<user>/Documents/GitHub/clockwork && /run/current-system/sw/bin/bun install'
```

**Acceptance:** HEAD = `c8b6ea5`; `bun install` clean; working tree clean (the standalone
checkout has no local commits — confirm `git status` is clean first; if it is dirty, STOP
and reconcile before pulling).

### Step 3 — Prove the new code builds + tests on studio (agent)

```
ssh studio 'cd /home/<user>/Documents/GitHub/clockwork && /run/current-system/sw/bin/bun run check'
```

**Acceptance:** `tsc --noEmit` clean + **261 tests pass, 0 fail** on studio (matches dev).
This is the studio equivalent of `just build` — it proves the new configuration evaluates
and runs on the target host before activation.

### Step 4 — Ensure the origin is push-ready (agent, idempotent)

The origin is already non-bare + `updateInstead`, which the new merge-push path handles.
Run the checked-in script to make the state explicit and reproducible (idempotent):
```
ssh studio 'cd /home/<user>/Documents/GitHub/clockwork \
  && /run/current-system/sw/bin/bun scripts/ensure-bare-origin.ts \
     /home/<user>/.clockwork-data/repos/prism-drift'
```
Expect JSON `{"ok":true,"action":"converted"}` (already-updateInstead → re-sets the same
flag; harmless) or `already-bare`.

**Acceptance:** script exits 0; origin still accepts a push to its checked-out branch
(already proven live by the pre-hardening merge-push fix).

### Step 5 — Reconcile the service unit with the captured template (agent)

Diff the live unit against `docs/deploy/clockwork.service.template` and the README env
table. The live unit is the source of truth for *values*; the template is the source of
truth for *which vars exist*. Confirm:
- No new **required** env var was introduced by the hardening. (It was not:
  `rg -o "CLOCKWORK_[A-Z_]+" src/ scripts/` on `c8b6ea5` matches the README table; the new
  code reads no new `CLOCKWORK_*`.)
- `CLOCKWORK_GIT_TOKEN=` is empty in the live unit — fine for a `file://` origin and local
  merge-push; note it, do not populate (no secret in repo).

**Acceptance:** the live unit needs **no edit** for this redeploy (documented), OR any
edit needed is a value already present on disk — captured as a note, not a new secret.
The unit does not need `daemon-reload` unless edited.

### Step 6 — Immediate non-privileged relief (agent, optional)

Nothing is currently running (service inactive), so there is no stray process to kill and
no visible problem to ease. Skip. (If the service had been left running, the agent would
stop it here to prevent the old code from processing cards.)

### Step 7 — Hand off to Ross for activation (STOP — hard gate)

Everything below the activation line is Ross's to run. The agent presents:

> Redeploy staged and proven. To activate:
> ```
> systemctl --user daemon-reload   # only if the unit was edited (it was not)
> systemctl --user start clockwork
> journalctl --user -u clockwork -f
> ```
> Watch for: the additive migration log (or silent success), the board reachable on
> `:3000` over tailnet, and the worker loop polling. The render chain is paused (cards
> 3–5 held, card 2 in QA); do **not** expect card processing until you resume it.

**Acceptance:** Ross starts the service; the board comes up; `PRAGMA table_info(cards)` on
the live DB now shows `targets` + `scenario`; the 13 rows are intact.

### Step 8 — Post-activation smoke (agent, after Ross confirms it is up)

Once Ross reports the service running, the agent verifies (all read-only / director-API,
no product hand-touch):
1. `GET /api/projects/<id>/columns` returns the pipeline columns (board alive).
2. Hit one **new director endpoint** harmlessly to prove the new API is live, e.g.
   `POST /api/cards/<a-parked-card>/reset-retry` on a card that is genuinely parked — or,
   if nothing should change yet, just `curl` a 404 path (`/api/cards/nope/reset-retry`
   → 404) to confirm the route exists rather than 404-for-unknown-route vs unknown-card.
3. Confirm the live `cards` schema has the two new columns.

**Acceptance:** board responds; a new director route is reachable; schema migrated;
row count 13.

---

## Rollback (if activation misbehaves)

1. `systemctl --user stop clockwork` (Ross).
2. `cd /home/<user>/Documents/GitHub/clockwork && git checkout 5786e01` (recorded in Step 0).
3. Restore the DB backup only if the schema change caused a problem (it should not —
   additive columns are ignored by old code):
   `cp .../clockwork.sqlite.bak-<ts> .../clockwork.sqlite`.
4. `systemctl --user start clockwork` (Ross).

The additive migration is forward-safe: the *old* code ignores unknown columns, so even
after migrating, a rollback to `5786e01` runs fine against the migrated DB — the DB restore
is a belt-and-braces option, rarely needed.

---

## Definition of done (redeploy)

- [ ] DB backed up; old HEAD recorded (Step 0).
- [ ] Migration proven on a copy: `targets`+`scenario` added, 13 rows intact (Step 1).
- [ ] Studio checkout at `c8b6ea5`, `bun install` clean (Step 2).
- [ ] `bun run check` green on studio — 261 tests, tsc clean (Step 3).
- [ ] Origin push-ready via idempotent script (Step 4).
- [ ] Service unit reconciled; no new required env var; no secret added (Step 5).
- [ ] Handed off to Ross with the exact activation commands (Step 7).
- [ ] (After Ross activates) board up, new director route live, live schema migrated,
      13 rows intact (Step 8).

## What the agent must NOT do

- Not run `systemctl --user start/enable/restart clockwork` (activation is Ross's).
- Not write secret token values anywhere in the repo or a committed file.
- Not hand-edit product/cards to "test" — use the read paths and the new director API.
- Not touch the paused render chain as part of the redeploy (separate decision).
