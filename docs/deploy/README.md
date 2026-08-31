# Deploying clockwork (reproducible studio redeploy)

This captures the studio-only service configuration in the repo so a redeploy — or a
fresh host — reproduces a running service with **no disk-only state** and **no hand
`git config`**. It closes the design §4 acceptance: "The studio service env + repo
config are captured in the repo/config, reproducibly."

The systemd user unit lives at [`clockwork.service.template`](./clockwork.service.template).
The service entrypoint is `bun run src/index.ts` (`package.json` `start` script).

## Environment variables

Every variable below is one the code **actually reads**. This list was reconciled
against source with:

```
rg -o "CLOCKWORK_[A-Z_]+" src/ scripts/ | sort -u
```

### Service configuration (read at startup by `src/index.ts` and `src/worker.ts`)

| Variable | Read at | Default | Meaning |
|----------|---------|---------|---------|
| `CLOCKWORK_DB_PATH` | `index.ts:9` | `:memory:` | SQLite DB file. MUST be a real path in production so the board survives redeploy. |
| `CLOCKWORK_REPOS` | `index.ts:10` | `./repos` | Root for per-project origin clones. `$CLOCKWORK_REPOS/<project>` is a **bare** origin (see below). |
| `CLOCKWORK_TRANSCRIPTS` | `index.ts:11` | `./transcripts` | Where pi transcripts are written. |
| `CLOCKWORK_PORT` | `index.ts:12` | `3000` | HTTP/websocket port for the board + director API (tailnet-only bind). |
| `CLOCKWORK_WORKER_PROJECT_ID` | `index.ts:13` | _(none)_ | Project id the single worker loop drives. Unset = board only, no worker. |
| `CLOCKWORK_MAX_RETRIES` | `index.ts:48,62` | `3` | Kickback retry counter before a card parks at needs-human. |
| `CLOCKWORK_POLL_INTERVAL_MS` | `index.ts:63` | `5000` | Worker poll interval (ms). |
| `CLOCKWORK_PI_INACTIVITY_MS` | `worker.ts` | `600000` (10 min) | Inactivity watchdog: kill a pi session only after this long with NO output (resets on every chunk). Never kills a session that is making progress. |
| `CLOCKWORK_PI_MAX_RUNTIME_MS` | `worker.ts` | `3600000` (60 min) | Total-runtime backstop: absolute ceiling on one pi session regardless of activity. |
| `CLOCKWORK_PREEMPTION_BACKOFF_MS` | `index.ts:70` | _(undefined → worker built-in)_ | Frame-arbiter preemption backoff (ms). |
| `CLOCKWORK_MAX_PREEMPTION_RETRIES` | `index.ts:71` | _(undefined → worker built-in)_ | Max retries after arbiter preemption. |
| `CLOCKWORK_MILESTONE_LABEL` | `index.ts:68` | _(none)_ | Label used to tag milestone cards. |
| `CLOCKWORK_BUILD_COPY_COMMAND` | `index.ts:69` | _(none)_ | Shell command run to copy a build artifact out on milestone. |
| `CLOCKWORK_NOTIFY_URL` | `index.ts:45,64`; `api.ts:750` | _(none)_ | Generic notify webhook URL (non-secret). |
| `CLOCKWORK_SMS_URL` | `index.ts:66` | _(none)_ | SMS webhook URL (non-secret). |

### Secrets (also read at startup — provided by SOPS, never committed)

| Variable | Read at | Meaning |
|----------|---------|---------|
| `CLOCKWORK_TOKEN` | `index.ts:14`; `api.ts:745` | API auth token. `null` = no auth (dev). |
| `CLOCKWORK_GIT_TOKEN` | `index.ts:35,47`; `api.ts:756` | git push/pull credential. **Required for sync-UP to GitHub** (see "Bidirectional GitHub sync" below); **currently empty on studio**, so sync-up cannot push until it is set. Sync-down from a public repo works without it. |
| `CLOCKWORK_NOTIFY_TOKEN` | `index.ts:46,65`; `api.ts:753` | Auth for the notify webhook. |
| `CLOCKWORK_SMS_TOKEN` | `index.ts:67` | Auth for the SMS webhook. |

Secret **values** never live in the repo. They are stored SOPS-encrypted and decrypted
at deploy time into a tmpfs file (for example `~/.clockwork-data/secrets.env`) that the
unit pulls in via `EnvironmentFile=`. The template ships the reference, not the plaintext.

### Not service configuration (documented so the grep list reconciles)

The full `rg` sweep also surfaces these. They are **deliberately absent** from the
service template because the service does not read them from its own environment:

| Variable | Where | Why it is not in the unit |
|----------|-------|---------------------------|
| `CLOCKWORK_PROJECT_ROOT` | `worker.ts:516` | **Set by** the worker into each pi child process, not read from deploy env. |
| `CLOCKWORK_CARD_ID` | `worker.ts:517,558` | **Set by** the worker into each pi child process (the visual-QA skill reads it). |
| `CLOCKWORK_WORKER_ID` | `worker.ts:518` | **Set by** the worker into each pi child process. |
| `CLOCKWORK_API_URL` | `scripts/bootstrap-project.ts:15` | Belongs to the `bootstrap-project` **client CLI**, not the service. Default `http://localhost:3000`. |

(`CLOCKWORK_TOKEN` is also read by `bootstrap-project.ts:16`, but it is already a real
service variable listed above.)

## The origin must be BARE (deploy step)

`mergeCardToMain` pushes the merged default branch back to origin so later/dependent
cards branch off finished work. A non-bare origin rejects a push to its checked-out
branch (`receive.denyCurrentBranch`). The production origin at `$CLOCKWORK_REPOS/<project>`
is therefore **bare**, created reproducibly by `scripts/ensure-bare-origin.ts` (Task 2) —
never a hand `git config`. For an existing non-bare origin that cannot be recloned, the
same script sets `receive.denyCurrentBranch updateInstead` as the documented fallback.

```
bun scripts/ensure-bare-origin.ts "$CLOCKWORK_REPOS/<project>"
```

## Bidirectional GitHub sync (the pipeline origin <-> GitHub)

Set per project via the `github_upstream` field (`POST`/`PUT /api/projects`, key `github_upstream`;
nullable). Null = pure-local project, no sync (unchanged behavior). When set, the pipeline repo
(`$CLOCKWORK_REPOS/<project>`) syncs to its GitHub upstream at two event points:

- **Down** — before a card's workspace is prepared: the pipeline repo fast-forwards from GitHub.
  On real divergence (both ahead and behind) the card does NOT run; it parks in Needs-Director as
  `sync-diverged`.
- **Up** — after a card merges to the default branch: the pipeline repo pushes up to GitHub. A
  non-fast-forward rejection is non-blocking (the card is done); it is flagged for a manual
  pull-up.
- **Reconcile** — `POST /api/projects/:id/sync/reconcile` does the one real merge + dual push, or
  returns the conflict file list (never auto-resolves).

**`CLOCKWORK_GIT_TOKEN` is required for sync-UP.** It is **currently empty on studio**, so sync-up
silently cannot push until it is set (SOPS secret, same as the other `*_TOKEN` vars). Sync-down
from a public GitHub repo works without a token.

## Run order — bring up the service from a fresh checkout

1. **Clone** clockwork on the host and `cd` into it.
2. **Install:** `bun install`.
3. **Data dir:** create `~/.clockwork-data/{repos,transcripts}` (the service also mkdirs
   these at startup, but pre-creating keeps ownership predictable).
4. **Secrets:** decrypt the SOPS bundle into `~/.clockwork-data/secrets.env` (defines the
   four `*_TOKEN` vars). This file is tmpfs/local only — never committed.
5. **Bare origin:** for each project, run
   `bun scripts/ensure-bare-origin.ts "$CLOCKWORK_REPOS/<project>"` (idempotent:
   `created` / `already-bare` / `converted`).
6. **Unit:** copy `docs/deploy/clockwork.service.template` to
   `~/.config/systemd/user/clockwork.service`, fill the `<placeholders>` (project id,
   webhook URLs, milestone/build-copy if used).
7. **Start:** `systemctl --user daemon-reload && systemctl --user enable --now clockwork`.
8. **Verify:** the board is reachable on `CLOCKWORK_PORT` (tailnet) and
   `journalctl --user -u clockwork -f` shows the worker loop polling.

## Manual verification

> _Not yet run against a scratch host._ The intended check: on a scratch directory,
> check out the repo, follow the run order above, and confirm the board is reachable
> and the worker loops with no disk-only state. Record the outcome here when performed.
