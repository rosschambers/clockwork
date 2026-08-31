# Bidirectional GitHub Sync for the Pipeline Origin — Design

**Problem.** clockwork builds each project from a local **pipeline file:// repo**
(`$CLOCKWORK_REPOS/<project>` — the DB `github_repo` value). Workspace clones use that
pipeline repo as their `origin`. The pipeline repo *separately* has a GitHub remote, but
**nothing ever syncs the pipeline repo with GitHub.** On 2026-08-21 this caused a real
divergence: clockwork's autonomously-built game code (layout + space backdrop) lived only
on the pipeline origin, while human/agent edits (the Task 11 per-card scenario resolver +
per-card scenarios) lived only on GitHub. The QA stage ran the *old* skill from the stale
pipeline clone and the per-card contracts never took effect. Two copies of the same repo,
each holding work the other lacked.

**Goal.** Keep the pipeline origin and GitHub in sync in both directions, event-driven,
**fail-closed** — so an unattended pipeline never silently auto-merges product code, and any
divergence becomes a classified director decision (reusing the hands-off hardening's routing).

---

## Topology

```
workspace clone  <--origin-->  pipeline file:// repo  <--github_upstream-->  GitHub
 (card/<id> branch)            ($CLOCKWORK_REPOS/<project>)                   (rosschambers/<repo>)
```

- **Unchanged:** workspace clones use the pipeline repo as `origin` (clone / branch / pull /
  push merges). Card building is untouched.
- **New:** the *pipeline repo* gains a configured GitHub upstream and syncs to it at two event
  points (down at workspace-prepare, up after merge).
- **New per-project field:** `github_upstream TEXT` (nullable, additive column mirroring
  `depends_on`/`targets`/`scenario`). Null = no sync (pure-local project — current behavior
  preserved exactly).
- Auth: the authenticated GitHub URL is built with `CLOCKWORK_GIT_TOKEN`, same pattern as the
  existing clone path in `repo.ts` (`https://x-access-token:<token>@<host>/...`).

---

## The two sync operations (`RepoWorkspace`)

Both no-op when `github_upstream` is null. Both are deterministic git plumbing (machinery
stays dumb); the *decision* on divergence belongs to the director.

### A. `syncDownFromUpstream(pipelineRepoPath, upstreamUrl, branch)` — in `prepareCardWorkspace`, before the workspace clone pulls

1. In the pipeline repo: `git fetch <upstream> <branch>`.
2. Compute ahead/behind vs the fetched head (`git rev-list --left-right --count`).
3. behind-only or equal → `git merge --ff-only`. Clean; pipeline now current.
4. **Diverged** (both ahead and behind) → do NOT merge. Return `{ diverged: true, ahead, behind }`.
   Pipeline left byte-for-byte unchanged. Caller routes to the director; the card does not run.
5. Any git error → fail-closed: return a diverged/error result, never throw the pipeline down.

### B. `pushUpToUpstream(pipelineRepoPath, upstreamUrl, branch)` — in `mergeCardToMain`, after the existing push to the pipeline origin

1. `git push <upstream> <branch>`.
2. Rejected (non-fast-forward — GitHub moved ahead) → do NOT force. Return `{ rejected: true }`.
   The merge into the pipeline repo already succeeded (local truth preserved); only the GitHub
   mirror lags, flagged for reconciliation.

---

## Routing divergence to the director (reuses hardening machinery)

- **Down-divergence** (during `prepareCardWorkspace`): the worker does NOT run the card. It
  moves the card to **Needs-Director** (column 900, already live), records a `card_threads`
  entry `sync-diverged` with ahead/behind counts, adds a new `ParkReason` `"sync-diverged"`
  (`SUGGESTED_ACTIONS = ["reconcileSync", "requeueCard"]`), emits the `card.parked` ws event,
  and fires the SMS — all reusing Task 7/8 paths.
- **Up-rejection** (during `mergeCardToMain`): the card's merge already succeeded, so the card
  completes normally; the worker records a `sync-push-rejected` thread entry and emits a
  distinct **non-blocking** `sync.rejected` ws event + SMS so a human knows GitHub needs a
  manual pull-up. The card is done; only the mirror lags.
- **New director action** `POST /api/projects/:id/sync/reconcile`: attempts the real merge in
  the pipeline repo (fetch upstream → `git merge` → if clean, push both ways), returns the
  result. This is the one-click replacement for the manual trial-merge-in-a-throwaway-clone
  dance done by hand on 2026-08-21. On conflict it returns the conflicted file list and does
  NOT auto-resolve.

---

## Testing

Test-first; matches existing patterns (`repo.test.ts` already seeds bare/non-bare remotes +
file:// clones).

- `repo.test.ts`: (a) upstream ahead → `syncDownFromUpstream` fast-forwards; (b) equal → no-op;
  (c) diverged → `{diverged:true,...}`, pipeline unchanged; (d) `pushUpToUpstream` clean →
  upstream gains the merge; (e) upstream ahead → push `{rejected:true}`, no force.
- `classify.test.ts`: `"sync-diverged"` classified + present in `SUGGESTED_ACTIONS`.
- `worker.test.ts`: injected fake workspace whose `syncDownFromUpstream` returns `diverged` →
  card lands in Needs-Director with a `sync-diverged` thread entry; pi is never invoked.
- `api.test.ts`: `/sync/reconcile` → 404 unknown project; clean merge → 200 + result; null
  `github_upstream` → 400 "no upstream configured".
- `db.test.ts`: `github_upstream` additive column round-trips.

## Acceptance criteria (binary)

1. `github_upstream` nullable column added additively; null → all sync is a no-op.
2. `syncDownFromUpstream` fast-forwards when possible; on divergence returns diverged and
   leaves the repo byte-for-byte unchanged; never auto-merges.
3. `pushUpToUpstream` pushes on fast-forward; on rejection returns rejected; never force-pushes.
4. A down-divergence moves the card to Needs-Director with a `sync-diverged` classified reason
   + SMS; pi is not invoked for that card.
5. An up-rejection does not block the completed card; emits a distinct non-blocking notify.
6. `/sync/reconcile` performs a real merge + dual-push when clean; returns the conflict file
   list when not; never auto-resolves conflicts.
7. `bun run check` green; no new framework; additive migration only.

## Assumptions

- `CLOCKWORK_GIT_TOKEN` is valid for GitHub push. **It is currently empty on studio** — sync-up
  to GitHub needs it set (add to the deploy secrets, `docs/deploy/`). Sync-down from a public
  repo works without a token.
- The pipeline repo keeps GitHub reachable as its `github_upstream` value.
- Single worker (no concurrent sync races).

## Out of scope (YAGNI)

- Automatic conflict resolution (always human/director-reconciled).
- A background scheduler (sync is event-driven at prepare + merge).
- Multi-upstream or non-`main` default handling beyond the existing `defaultBranch`.
