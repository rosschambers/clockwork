# Claim Lease / Heartbeat Implementation Plan

> **For OpenCode:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make a hard-killed worker's claimed cards automatically expire and get re-processed, by giving every claim a time-bounded lease that the live worker renews with a periodic heartbeat, and reaping expired leases at the top of the worker loop.

**Architecture:** A claim already stamps `claimed_at`. Treat a claim as *expired* when `now - claimed_at > claimLeaseMs`. While a worker processes a card it runs a `setInterval` heartbeat that renews `claimed_at` for that one in-flight card (guarded so it is a no-op once the card moves or is unclaimed), so a genuinely-working worker's claim never expires. At the top of each loop pass, before the normal claim scan, the worker calls a new `reclaimExpiredClaims()` DbStore method that frees any card whose lease has lapsed — including claims left by a *different, now-dead* worker (SIGKILL / power loss, where the graceful `releaseClaimsByWorker` on startup never runs). Freed cards then flow through the unchanged eligibility filter + atomic `claimCardIfFree` path. No new column: `claimed_at` + a config duration is sufficient.

**Tech Stack:** Bun + TypeScript (ES modules), `bun:sqlite` (WAL), `bun test`. No new dependencies.

**Assumptions:**
- The `cards.claimed_at` column already exists and is set to `now.toISOString()` by both `claimCard` and `claimCardIfFree` (verified in `src/db.ts:525-547`). **No migration is required** — a lease is derived purely from `claimed_at` + a config duration, so no `lease_expires_at` column is added. (This is the deliberately minimal choice; storing an absolute expiry column would duplicate state that `claimed_at` + one config number already expresses.)
- Single worker in production (`workerId: "main"`). The lease/reaper machinery is still written to be *worker-id-aware* so it correctly steals a claim left by a **previous** process that used the same or a different worker id after a hard kill. It must NOT steal a *live, valid* claim from any worker.
- The per-pi-session watchdog is now an INACTIVITY window (`DEFAULT_PI_INACTIVITY_MS = 5 * 60 * 1000`) plus a total-runtime backstop (`DEFAULT_PI_MAX_RUNTIME_MS = 60 * 60 * 1000`) in `src/worker.ts` — the single `DEFAULT_PI_TIMEOUT_MS` was removed (see `docs/plans/2026-08-20-pi-watchdog-streaming-plan.md`). A single pi session may therefore now legitimately run up to 60 min, which is LONGER than the 20-min lease, so the old "lease must exceed the pi timeout" ordering no longer holds and is the WRONG guarantee. The correct guarantee is dynamic: the heartbeat renews `claimed_at` every 2 min for as long as pi is alive (and pi is alive precisely while it streams, per the inactivity watchdog), so a long-but-active session's claim is continuously renewed and never lapses regardless of total runtime. The lease default therefore need only exceed the heartbeat interval by a comfortable margin — see the invariant below.
- SQLite time math is done in TypeScript (compare `Date` values), NOT in SQL, so the reaper query passes an explicit cutoff ISO timestamp computed as `new Date(Date.now() - claimLeaseMs)`. This avoids depending on SQLite `datetime('now')` vs. the ISO strings the code stores.

---

## Design decisions (explicit, with rationale)

### 1. Lease duration + heartbeat interval defaults, vs. the pi watchdog

| Constant | Default | Why |
|----------|---------|-----|
| `claimLeaseMs` | `20 * 60 * 1000` (20 min) | Must be **comfortably greater** than `heartbeatIntervalMs` so several missed heartbeat ticks still cannot expire a live claim. It is NO LONGER tied to a static pi-session cap: with the inactivity watchdog a single pi session may run up to `DEFAULT_PI_MAX_RUNTIME_MS` (60 min) — longer than the lease — and that is safe because the heartbeat renews the claim every 2 min while pi streams. The lease only ever lapses for a worker that is genuinely gone (no heartbeats at all). |
| `heartbeatIntervalMs` | `2 * 60 * 1000` (2 min) | In normal operation the heartbeat renews `claimed_at` every 2 min, so the effective age of a live claim never exceeds ~2 min and comes nowhere near the 20 min lease. 2 min is far below the lease (10× margin) so a couple of missed ticks (event-loop busy during a long synchronous git op) still cannot expire a live claim. This heartbeat-within-lease margin is now the PRIMARY safety invariant (`heartbeatIntervalMs < claimLeaseMs`), replacing the old `lease > pi-timeout` ordering. |

The lease **cooperates with, not fights, the watchdog**: the watchdog bounds a single hung/silent pi session (kills pi, returns a blocked verdict, card resolves); the lease bounds a *dead worker process* (frees the orphaned claim so another loop pass re-runs the card). They act on different failure modes. Because a single pi session may now run up to 60 min (> the 20-min lease), the two are kept consistent NOT by a static duration ordering but by the heartbeat: a live worker renews its claim every 2 min for as long as pi streams, so a long-but-active session never has its claim reaped.

**A card can take well over an hour** (a card is multiple pi sessions across multiple stages, each bounded by the inactivity watchdog with a 60-min per-session backstop). Across that time the worker heartbeats continuously, so the long total runtime is fine — only an *individual* silent stall (inactivity watchdog) or a dead process (lease reaper) is caught.

### 2. WHERE expiry is enforced — separate `reclaimExpiredClaims()` in the loop (RECOMMENDED), not extending `claimCardIfFree`

**Chosen: a separate `reclaimExpiredClaims()` DbStore method, called once at the top of each `loop()` pass, before the claim scan.**

Rationale — extending `claimCardIfFree` does **not** work here because the eligibility filter in `Worker.claimCard()` (`src/worker.ts:397-411`) rejects any card with `card.claimState !== null` *before* `claimCardIfFree` is ever called. An expired-but-still-`claimed` card would be filtered out upstream and never reach the atomic claim. Making `claimCardIfFree` also match `claimed` rows would additionally break its TOCTOU contract (`WHERE ... AND claim_state IS NULL`) and its meaning ("only claim a free card"). A dedicated reaper that first *frees* expired claims (sets them back to `claim_state = NULL`) and then lets the existing, unchanged eligibility + `claimCardIfFree` path pick them up is the smallest change that respects every existing invariant (dependency gate, park/terminal exclusions, atomic single-winner claim). It mirrors the shape of the already-accepted `releaseClaimsByWorker` recovery method.

### 3. How the heartbeat runs during `processCard`

A `setInterval(heartbeatIntervalMs)` started immediately before the pi invocation and **always cleared in a `finally`** that wraps the entire body of `processCard` (so a throw, a watchdog timeout, or an early return all clear it). Each tick calls `dbStore.renewClaim(cardId, workerId)`, which is a guarded UPDATE (`WHERE id = ? AND claimed_by = ? AND claim_state = 'claimed'`). If the card has already moved, been unclaimed, or been stolen, the renew matches zero rows and is a harmless no-op — it can never resurrect a card that already progressed.

### 4. Migration — none needed

`claimed_at` already exists and is populated on claim. The lease is `claimed_at + claimLeaseMs`. Reusing it (design goal: "prefer reusing `claimed_at` + duration if it works") avoids a schema change entirely, so there is **no** `ALTER TABLE`. (If a future requirement needed per-card variable lease lengths, a column would be justified; it is not needed now — YAGNI.)

### 5. Config surface (`WorkerConfig` + env wiring)

Two optional fields on `WorkerConfig`, defaulted in the constructor, wired through `src/index.ts` from `CLOCKWORK_*` env vars following the existing pattern:

| `WorkerConfig` field | Default | Env var |
|----------------------|---------|---------|
| `claimLeaseMs?: number` | `20 * 60 * 1000` | `CLOCKWORK_CLAIM_LEASE_MS` |
| `heartbeatIntervalMs?: number` | `2 * 60 * 1000` | `CLOCKWORK_HEARTBEAT_INTERVAL_MS` |

---

## Task list (7 tasks)

- **Task 1** — DbStore: `reclaimExpiredClaims(cutoffIso)` (frees expired claims).
- **Task 2** — DbStore: `renewClaim(cardId, workerId)` (guarded heartbeat renew).
- **Task 3** — Worker: `claimLeaseMs` / `heartbeatIntervalMs` config fields + defaults + exported constants.
- **Task 4** — Worker: reaper call at the top of `loop()`.
- **Task 5** — Worker: heartbeat `setInterval` around the pi work in `processCard`, cleared in `finally`.
- **Task 6** — Wire env vars through `src/index.ts`.
- **Task 7** — Full-suite regression + `bun run check` green.

---

### Task 1: DbStore.reclaimExpiredClaims — free claims whose lease has lapsed

**Files:**
- Modify: `src/db.ts` — add method near `releaseClaimsByWorker` (`src/db.ts:561-568`).
- Test: `src/db.test.ts` — add a new `describe` block at end of file (after line 883).

**Acceptance Criteria:**
- [ ] Method signature matches: `reclaimExpiredClaims(cutoffIso: string): number`
- [ ] Frees (`claim_state = NULL, claimed_by = NULL, claimed_at = NULL`) every card that is `claim_state = 'claimed'` AND `claimed_at < cutoffIso`.
- [ ] Returns the number of cards freed (via `SELECT changes()`), exactly like `releaseClaimsByWorker`.
- [ ] A claim newer than the cutoff (`claimed_at >= cutoffIso`) is NOT freed (the still-valid-lease guard).
- [ ] A `locked` card is NOT freed (only `claim_state = 'claimed'` rows).
- [ ] Works regardless of which worker id holds the claim (cross-worker reaping).
- [ ] Covered by the tests below.
- [ ] No changes to files outside the list above.

**Step 1: Write the failing test**

Append to `src/db.test.ts`:

```typescript
describe("DbStore — reclaimExpiredClaims (lease expiry)", () => {
	it("frees only claims older than the cutoff, across any worker, leaving valid + locked claims", () => {
		const { store, path } = createTempDb()
		const project = store.createProject({ name: "P", description: "", githubRepo: null, branch: null })
		const column = store.createColumn({ projectId: project.id, name: "Impl", prompt: "", skills: [], model: null, position: 0 })
		const stale = store.createCard({ projectId: project.id, columnId: column.id, title: "Stale", body: "", position: 0 })
		const fresh = store.createCard({ projectId: project.id, columnId: column.id, title: "Fresh", body: "", position: 1 })
		const otherStale = store.createCard({ projectId: project.id, columnId: column.id, title: "OtherStale", body: "", position: 2 })
		const locked = store.createCard({ projectId: project.id, columnId: column.id, title: "Locked", body: "", position: 3 })

		// Two claims stamped an hour ago (well past any sane lease) by two different workers.
		const oldIso = new Date(Date.now() - 60 * 60 * 1000).toISOString()
		store.updateCard(stale.id, { claimState: "claimed", claimedBy: "dead-1", claimedAt: new Date(oldIso) })
		store.updateCard(otherStale.id, { claimState: "claimed", claimedBy: "dead-2", claimedAt: new Date(oldIso) })
		// A fresh, still-valid claim (stamped now).
		store.updateCard(fresh.id, { claimState: "claimed", claimedBy: "live", claimedAt: new Date() })
		// A locked card, also stamped old — must be left alone (not a 'claimed' row).
		store.updateCard(locked.id, { claimState: "locked", claimedBy: "live", claimedAt: new Date(oldIso) })

		// Cutoff = now minus a 20-minute lease.
		const cutoffIso = new Date(Date.now() - 20 * 60 * 1000).toISOString()
		const freed = store.reclaimExpiredClaims(cutoffIso)

		expect(freed).toBe(2)
		expect(store.getCardById(stale.id)!.claimState).toBeNull()
		expect(store.getCardById(otherStale.id)!.claimState).toBeNull()
		// Still-valid lease untouched.
		expect(store.getCardById(fresh.id)!.claimState).toBe("claimed")
		// Locked card untouched.
		expect(store.getCardById(locked.id)!.claimState).toBe("locked")

		store.close()
		fs.unlinkSync(path)
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/db.test.ts -t "reclaimExpiredClaims"`
Expected: FAIL with `store.reclaimExpiredClaims is not a function` (property does not exist).

**Step 3: Write minimal implementation**

Add to `src/db.ts` immediately after `releaseClaimsByWorker` (after line 568):

```typescript
	// Hard-kill recovery: free every card whose claim lease has lapsed. A worker
	// killed with SIGKILL / power loss never runs the graceful releaseClaimsByWorker
	// on restart, so its claim would strand the card forever. A claim is expired when
	// its claimed_at is older than the caller-supplied cutoff (now - leaseDurationMs).
	// Cross-worker by design: it reaps a dead PREVIOUS process's claim regardless of
	// worker id. Only touches 'claimed' rows (never 'locked'). Returns cards freed.
	reclaimExpiredClaims(cutoffIso: string): number {
		this.run(
			`UPDATE cards SET claim_state = NULL, claimed_by = NULL, claimed_at = NULL, updated_at = datetime('now') WHERE claim_state = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ?`,
			cutoffIso
		)
		const changed = this.db.query("SELECT changes() AS n").get() as { n: number }
		return changed.n
	}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/db.test.ts -t "reclaimExpiredClaims"`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat: DbStore.reclaimExpiredClaims frees lease-expired claims"
```

---

### Task 2: DbStore.renewClaim — guarded heartbeat renew of claimed_at

**Files:**
- Modify: `src/db.ts` — add method after `reclaimExpiredClaims`.
- Test: `src/db.test.ts` — add a `describe` block at end of file.

**Acceptance Criteria:**
- [ ] Method signature matches: `renewClaim(cardId: string, workerId: string): boolean`
- [ ] Renewing a card currently `claimed` by `workerId` sets `claimed_at` to now and returns `true`.
- [ ] After renew, the card's `claimedAt` is strictly newer than before the renew.
- [ ] Renewing a card claimed by a DIFFERENT worker id matches zero rows and returns `false` (no state change).
- [ ] Renewing an UNCLAIMED card (`claim_state IS NULL`) matches zero rows and returns `false` (heartbeat on a card that already moved is a no-op — cannot resurrect it).
- [ ] Renewing a `locked` card returns `false` (only `claim_state = 'claimed'` is renewable).
- [ ] Covered by the tests below.
- [ ] No changes to files outside the list above.

**Step 1: Write the failing test**

Append to `src/db.test.ts`:

```typescript
describe("DbStore — renewClaim (heartbeat)", () => {
	it("renews only a claim still held by the same worker; no-op otherwise", async () => {
		const { store, path } = createTempDb()
		const project = store.createProject({ name: "P", description: "", githubRepo: null, branch: null })
		const column = store.createColumn({ projectId: project.id, name: "Impl", prompt: "", skills: [], model: null, position: 0 })
		const card = store.createCard({ projectId: project.id, columnId: column.id, title: "A", body: "", position: 0 })

		// Claim it, then stamp claimed_at to a known-old value so a renew is observably newer.
		store.claimCardIfFree(card.id, "live")
		const oldStamp = new Date(Date.now() - 5 * 60 * 1000)
		store.updateCard(card.id, { claimState: "claimed", claimedBy: "live", claimedAt: oldStamp })
		const before = store.getCardById(card.id)!.claimedAt!.getTime()

		// Renew by the holding worker -> true, claimed_at moves forward.
		const ok = store.renewClaim(card.id, "live")
		expect(ok).toBe(true)
		const after = store.getCardById(card.id)!.claimedAt!.getTime()
		expect(after).toBeGreaterThan(before)

		// Renew by a DIFFERENT worker -> false, no change.
		const other = store.renewClaim(card.id, "someone-else")
		expect(other).toBe(false)

		// Unclaim, then renew -> false (cannot resurrect a moved/unclaimed card).
		store.unclaimCard(card.id)
		const gone = store.renewClaim(card.id, "live")
		expect(gone).toBe(false)
		expect(store.getCardById(card.id)!.claimState).toBeNull()

		store.close()
		fs.unlinkSync(path)
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/db.test.ts -t "renewClaim"`
Expected: FAIL with `store.renewClaim is not a function`.

**Step 3: Write minimal implementation**

Add to `src/db.ts` immediately after `reclaimExpiredClaims`:

```typescript
	// Heartbeat: renew a claim's lease by bumping claimed_at to now, but ONLY while
	// the card is still claimed by this worker. If the card has moved, been unclaimed,
	// or been stolen, the WHERE matches nothing and this is a harmless no-op (it can
	// never resurrect a card that already progressed). Returns whether a row changed.
	renewClaim(cardId: string, workerId: string): boolean {
		const now = new Date()
		this.run(
			`UPDATE cards SET claimed_at = ?, updated_at = datetime('now') WHERE id = ? AND claimed_by = ? AND claim_state = 'claimed'`,
			now.toISOString(), cardId, workerId
		)
		const changed = this.db.query("SELECT changes() AS n").get() as { n: number }
		return changed.n > 0
	}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/db.test.ts -t "renewClaim"`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat: DbStore.renewClaim renews a live claim's lease (heartbeat)"
```

---

### Task 3: Worker config — claimLeaseMs / heartbeatIntervalMs fields, defaults, exported constants

**Files:**
- Modify: `src/worker.ts` — `WorkerConfig` interface (`src/worker.ts:19-45`), new exported constants near the pi watchdog constants (`DEFAULT_PI_INACTIVITY_MS` / `DEFAULT_PI_MAX_RUNTIME_MS`), new `public readonly` fields + constructor assignments (`src/worker.ts:212-254`).
- Test: `src/worker.test.ts` — add a `describe` block at end of file.

**Acceptance Criteria:**
- [ ] `WorkerConfig` gains `claimLeaseMs?: number` and `heartbeatIntervalMs?: number`.
- [ ] Exported constants: `DEFAULT_CLAIM_LEASE_MS = 20 * 60 * 1000` and `DEFAULT_HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000`.
- [ ] `DEFAULT_HEARTBEAT_INTERVAL_MS < DEFAULT_CLAIM_LEASE_MS` (asserted by a test, encoding the cooperation invariant — the heartbeat must renew well within the lease). NOTE: a single pi session may now run up to `DEFAULT_PI_MAX_RUNTIME_MS` (60 min) > the lease; that is kept safe by the heartbeat renewing every 2 min while pi streams, not by a static lease-vs-pi-timeout ordering (the removed `DEFAULT_PI_TIMEOUT_MS`).
- [ ] `Worker` exposes `public readonly claimLeaseMs: number` and `public readonly heartbeatIntervalMs: number`, each falling back to its default when the config field is omitted.
- [ ] A `Worker` constructed with explicit values uses those values.
- [ ] Covered by the tests below.
- [ ] No behavioural change yet (no reaper/heartbeat wired) — this task only adds config surface.
- [ ] No changes to files outside the list above.

**Step 1: Write the failing test**

Append to `src/worker.test.ts`:

```typescript
import {
	DEFAULT_CLAIM_LEASE_MS,
	DEFAULT_HEARTBEAT_INTERVAL_MS,
} from "./worker.ts"

describe("Worker — lease config surface", () => {
	it("defaults the lease and heartbeat, and the heartbeat renews within the lease", () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)
		const worker = new Worker({
			dbStore: store,
			projectId: seeded.projectId,
			token: "",
			workerId: "w",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
		})
		expect(worker.claimLeaseMs).toBe(DEFAULT_CLAIM_LEASE_MS)
		expect(worker.heartbeatIntervalMs).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS)
		// The invariant that keeps a live worker from being falsely reaped: the
		// heartbeat must renew well within the lease. (A single pi session may run
		// up to DEFAULT_PI_MAX_RUNTIME_MS > the lease; that is kept safe by the
		// heartbeat, not by a static lease-vs-pi-timeout ordering.)
		expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBeLessThan(DEFAULT_CLAIM_LEASE_MS)

		store.close()
		fs.unlinkSync(path)
	})

	it("honours explicit lease / heartbeat config", () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)
		const worker = new Worker({
			dbStore: store,
			projectId: seeded.projectId,
			token: "",
			workerId: "w",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			claimLeaseMs: 1234,
			heartbeatIntervalMs: 567,
		})
		expect(worker.claimLeaseMs).toBe(1234)
		expect(worker.heartbeatIntervalMs).toBe(567)

		store.close()
		fs.unlinkSync(path)
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/worker.test.ts -t "lease config surface"`
Expected: FAIL — import of `DEFAULT_CLAIM_LEASE_MS` is undefined / `worker.claimLeaseMs` is `undefined`.

**Step 3: Write minimal implementation**

In `src/worker.ts`, add exported constants after the pi watchdog constants (`DEFAULT_PI_INACTIVITY_MS` / `DEFAULT_PI_MAX_RUNTIME_MS`):

```typescript
// Claim lease: a claim is considered expired when now - claimed_at exceeds this.
// MUST be comfortably greater than DEFAULT_HEARTBEAT_INTERVAL_MS so several missed
// heartbeat ticks still cannot expire a live claim. It is NOT tied to a static
// pi-session cap: a single pi session may run up to DEFAULT_PI_MAX_RUNTIME_MS
// (60 min) > this lease, kept safe because the heartbeat renews the claim every
// 2 min while pi streams. The heartbeat renews far more often than this, so in
// practice a live claim's age stays near the heartbeat interval.
export const DEFAULT_CLAIM_LEASE_MS = 20 * 60 * 1000

// Heartbeat cadence: how often the worker renews the in-flight card's claimed_at
// while processing. Far below the lease (10x margin) so a couple of missed ticks
// cannot expire a live claim.
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000
```

Add the two optional fields to `WorkerConfig` (inside the interface, e.g. after `buildCopyCommand?: string` at line 44):

```typescript
	// Claim-lease / heartbeat tuning. A claim older than claimLeaseMs is reclaimable
	// by the loop's reaper (hard-kill recovery); the worker renews the in-flight
	// card's claim every heartbeatIntervalMs so its own valid claim never expires.
	claimLeaseMs?: number
	heartbeatIntervalMs?: number
```

Add `public readonly` declarations (after `buildCopyCommand` at line 229):

```typescript
	public readonly claimLeaseMs: number
	public readonly heartbeatIntervalMs: number
```

Add constructor assignments (after `this.buildCopyCommand = config.buildCopyCommand` at line 253):

```typescript
		this.claimLeaseMs = config.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS
		this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
```

**Step 4: Run test to verify it passes**

Run: `bun test src/worker.test.ts -t "lease config surface"`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: Worker claimLeaseMs/heartbeatIntervalMs config + defaults"
```

---

### Task 4: Worker loop — reap expired claims at the top of each pass

**Files:**
- Modify: `src/worker.ts` — `loop()` (`src/worker.ts:351-374`).
- Test: `src/worker.test.ts` — add a `describe` block.

**Acceptance Criteria:**
- [ ] At the start of each `loop()` iteration, before `claimCard()`, the worker calls `this.dbStore.reclaimExpiredClaims(cutoffIso)` where `cutoffIso = new Date(Date.now() - this.claimLeaseMs).toISOString()`.
- [ ] When a card is left `claimed` with a `claimed_at` older than the lease by a DEAD worker id, a running loop reclaims it and then processes it (it advances / resolves, no longer stranded).
- [ ] When >0 claims are reclaimed, an `idle` event is emitted with a reason mentioning the reclaim count (mirrors the startup-recovery event at `src/worker.ts:335-338`), so the journal shows it.
- [ ] A still-valid claim (fresh `claimed_at`) held by another worker id is NOT reclaimed by the loop.
- [ ] Existing loop behaviour (idle when nothing claimable, crash-safety unclaim) is unchanged.
- [ ] Covered by the test below.
- [ ] No changes to files outside the list above.

**Step 1: Write the failing test**

Append to `src/worker.test.ts`:

```typescript
describe("Worker — reaps a dead worker's expired claim and re-processes it", () => {
	it("an expired claim from another (dead) worker is reclaimed and advanced", async () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)
		store.createColumn({
			projectId: seeded.projectId, name: "Done", prompt: "final",
			skills: [], model: null, position: 1,
		})

		// Simulate a hard-killed worker: the card is left 'claimed' by "dead-worker"
		// with a claimed_at an hour in the past. No live process will ever release it
		// gracefully (releaseClaimsByWorker only frees THIS worker's id on startup).
		store.updateCard(seeded.cardId, {
			claimState: "claimed",
			claimedBy: "dead-worker",
			claimedAt: new Date(Date.now() - 60 * 60 * 1000),
		})

		const events: WorkerEvent[] = []
		const worker = new Worker({
			dbStore: store,
			projectId: seeded.projectId,
			token: "test",
			workerId: "live-worker",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
			// Short lease so the hour-old claim is unambiguously expired.
			claimLeaseMs: 20 * 60 * 1000,
			onEvent: (e) => events.push(e),
		})
		worker.invokePi = mock(() =>
			Promise.resolve({
				stdout: JSON.stringify({ verdict: "pass", feedback: "ok", artifacts: [] }),
				stderr: "",
				exitCode: 0,
			}),
		)

		await startWorker(worker)
		worker.stop()
		await worker.stopped()

		const card = store.getCardById(seeded.cardId)!
		// The stranded card was reclaimed and advanced out of its original column.
		expect(card.columnId).not.toBe(seeded.columnId)
		expect(events.some((e) => e.type === "passed")).toBe(true)

		store.close()
		fs.unlinkSync(path)
	})

	it("does NOT reap a still-valid claim held by another worker", async () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)

		// A fresh claim by another worker (valid lease) must be left alone.
		store.updateCard(seeded.cardId, {
			claimState: "claimed",
			claimedBy: "other-live",
			claimedAt: new Date(),
		})

		const worker = new Worker({
			dbStore: store,
			projectId: seeded.projectId,
			token: "test",
			workerId: "live-worker",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
			claimLeaseMs: 20 * 60 * 1000,
		})
		worker.invokePi = mock(() =>
			Promise.resolve({ stdout: "{}", stderr: "", exitCode: 0 }),
		)

		await startWorker(worker)
		worker.stop()
		await worker.stopped()

		const card = store.getCardById(seeded.cardId)!
		// Untouched: still claimed by the other live worker, still in its column.
		expect(card.claimState).toBe("claimed")
		expect(card.claimedBy).toBe("other-live")
		expect(card.columnId).toBe(seeded.columnId)

		store.close()
		fs.unlinkSync(path)
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/worker.test.ts -t "reaps a dead worker"`
Expected: FAIL — the first test finds the card still in its original column (no reaper yet, so the hour-old `claimed` card is never re-picked).

**Step 3: Write minimal implementation**

In `src/worker.ts`, at the top of the `loop()` `while` body (before `const card = await this.claimCard()` at line 353), insert:

```typescript
			// Hard-kill recovery per pass: free any claim whose lease has lapsed —
			// including one left by a DIFFERENT, now-dead process (SIGKILL / power
			// loss never runs the graceful releaseClaimsByWorker on restart). Freed
			// cards fall straight through the normal eligibility + atomic-claim path
			// below, so a stranded card is re-processed. A live worker's own claim is
			// kept fresh by the heartbeat, so this never steals a valid claim.
			const cutoffIso = new Date(Date.now() - this.claimLeaseMs).toISOString()
			const reclaimed = this.dbStore.reclaimExpiredClaims(cutoffIso)
			if (reclaimed > 0) {
				emitEvent(this.onEvent, {
					type: "idle",
					reason: `reclaimed ${reclaimed} expired claim(s)`,
				})
			}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/worker.test.ts -t "reaps a dead worker"`
Expected: PASS (both cases).

**Step 5: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: worker loop reaps lease-expired claims each pass (hard-kill recovery)"
```

---

### Task 5: Worker processCard — heartbeat the in-flight claim, always cleared in finally

**Files:**
- Modify: `src/worker.ts` — `processCard()` (`src/worker.ts:434-586`). Wrap the body so the heartbeat interval is started before the first pi call and cleared in a `finally`.
- Test: `src/worker.test.ts` — add a `describe` block.

**Acceptance Criteria:**
- [ ] During `processCard`, a `setInterval(this.heartbeatIntervalMs)` calls `this.dbStore.renewClaim(card.id, this.workerId)` on each tick.
- [ ] The interval is stored in a local and cleared with `clearInterval` in a `finally` that wraps the whole method body — so it is cleared on normal return, on early return (column-not-found, workspace-prepare failure), AND on a thrown error.
- [ ] A worker processing a slow card keeps its own claim fresh: with a tiny `heartbeatIntervalMs`, a claim whose `claimed_at` is set old at the start is renewed to a fresh timestamp DURING processing, so a concurrent reaper using a short lease would NOT reap it.
- [ ] After `processCard` returns, no interval is left running (no renew fires after completion — verified by counting renews before vs. after a delay past the interval).
- [ ] The heartbeat firing on an already-moved card is a no-op (guaranteed by `renewClaim`'s guard; asserted indirectly — a card that advanced to Done is not re-stamped as claimed).
- [ ] All existing `processCard` behaviour (verdict handling, attempt persistence, git commit, movement) is unchanged.
- [ ] Covered by the test below.
- [ ] No changes to files outside the list above.

**Step 1: Write the failing test**

Append to `src/worker.test.ts`:

```typescript
describe("Worker — heartbeat keeps the in-flight claim fresh and is always cleared", () => {
	it("renews claimed_at during a slow card, and stops renewing after processCard returns", async () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)
		store.createColumn({
			projectId: seeded.projectId, name: "Done", prompt: "final",
			skills: [], model: null, position: 1,
		})

		let renewCount = 0
		const realRenew = store.renewClaim.bind(store)
		// Spy on renewClaim to count heartbeats without changing behaviour.
		store.renewClaim = ((cardId: string, workerId: string): boolean => {
			renewCount++
			return realRenew(cardId, workerId)
		}) as typeof store.renewClaim

		// A pi call that takes ~250ms, with a 50ms heartbeat -> several renews land.
		const worker = new Worker({
			dbStore: store,
			projectId: seeded.projectId,
			token: "test",
			workerId: "live",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
			claimLeaseMs: 20 * 60 * 1000,
			heartbeatIntervalMs: 50,
		})

		// Stamp claimed_at old so we can prove the heartbeat moved it forward.
		const oldStamp = new Date(Date.now() - 10 * 60 * 1000)
		const claimed = await worker["claimCard"]()
		expect(claimed).not.toBeNull()
		store.updateCard(claimed!.id, { claimState: "claimed", claimedBy: "live", claimedAt: oldStamp })
		const claimedAgain = store.getCardById(claimed!.id)!

		worker.invokePi = mock(
			() =>
				new Promise((resolve) =>
					setTimeout(
						() => resolve({ stdout: JSON.stringify({ verdict: "pass", feedback: "ok", artifacts: [] }), stderr: "", exitCode: 0 }),
						250,
					),
				),
		)

		await worker.processCard(claimedAgain)

		// The heartbeat fired at least once during the slow pi call.
		expect(renewCount).toBeGreaterThanOrEqual(1)

		// Record the count, wait past several intervals, and confirm NO further
		// renews fire -> the interval was cleared in the finally.
		const countAfterProcessing = renewCount
		await delay(200)
		expect(renewCount).toBe(countAfterProcessing)

		// The card advanced to Done (heartbeat did not interfere with movement).
		expect(store.getCardById(claimed!.id)!.columnId).not.toBe(seeded.columnId)

		worker.stop()
		await worker.stopped()
		store.close()
		fs.unlinkSync(path)
	})

	it("clears the heartbeat interval even when processCard's column lookup fails early", async () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)

		let renewCount = 0
		const realRenew = store.renewClaim.bind(store)
		store.renewClaim = ((cardId: string, workerId: string): boolean => {
			renewCount++
			return realRenew(cardId, workerId)
		}) as typeof store.renewClaim

		const worker = new Worker({
			dbStore: store,
			projectId: seeded.projectId,
			token: "test",
			workerId: "live",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
			heartbeatIntervalMs: 20,
		})
		worker.invokePi = mock(() => Promise.resolve({ stdout: "{}", stderr: "", exitCode: 0 }))

		// Build a card object whose column does not exist -> processCard early-returns.
		const claimed = await worker["claimCard"]()
		store.deleteColumn(seeded.columnId) // now the card's column lookup fails
		await worker.processCard(claimed!)

		// Wait past several would-be intervals: none should fire (interval cleared).
		const countNow = renewCount
		await delay(120)
		expect(renewCount).toBe(countNow)

		worker.stop()
		await worker.stopped()
		store.close()
		fs.unlinkSync(path)
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/worker.test.ts -t "heartbeat keeps the in-flight claim fresh"`
Expected: FAIL — `renewCount` stays 0 (no heartbeat wired), and/or the post-processing no-further-renew assertion is vacuously irrelevant because nothing renews at all. The first test's `renewCount >= 1` fails.

**Step 3: Write minimal implementation**

In `src/worker.ts`, wrap the entire existing body of `processCard` in a try/finally that owns the heartbeat interval. Concretely, change the method so that immediately after computing `invokeFn`/`column` guards run inside the try, and the heartbeat is started once the claim is confirmed in-flight. The minimal, low-risk shape: start the interval at the very top of `processCard` (the card is already claimed by the caller) and clear it in `finally`.

Replace the opening of `processCard` (line 434) so the body is wrapped:

```typescript
	async processCard(card: DbCard): Promise<void> {
		// Heartbeat: while this card is in flight, renew its claim's lease so the
		// loop's reaper (which frees claims older than claimLeaseMs) never mistakes
		// our own valid, working claim for a dead one. renewClaim is guarded, so a
		// tick after the card has moved/unclaimed is a harmless no-op. ALWAYS cleared
		// in the finally below — on normal return, early return, or a throw — so no
		// stray interval outlives the card.
		const heartbeat = setInterval(() => {
			this.dbStore.renewClaim(card.id, this.workerId)
		}, this.heartbeatIntervalMs)
		try {
			await this.processCardInner(card)
		} finally {
			clearInterval(heartbeat)
		}
	}

	private async processCardInner(card: DbCard): Promise<void> {
```

Then leave the existing body (from the original line 435 `const invokeFn = ...` through the end of the original method at line 586) as the body of `processCardInner`. The original method's closing brace becomes `processCardInner`'s closing brace; no other lines inside change.

> Note for the executor: this is a pure *extract-and-wrap*. Do not alter any statement inside the original body — only rename the method it lives in to `processCardInner` and add the `processCard` wrapper above it. `processCardInner` is `private async ... : Promise<void>`.

**Step 4: Run test to verify it passes**

Run: `bun test src/worker.test.ts -t "heartbeat keeps the in-flight claim"`
Expected: PASS (both cases).

**Step 5: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: heartbeat renews in-flight claim during processCard, cleared in finally"
```

---

### Task 6: Wire env vars through src/index.ts

**Files:**
- Modify: `src/index.ts` — the `Worker` construction (`src/index.ts:55-82`).

**Acceptance Criteria:**
- [ ] The worker is constructed with `claimLeaseMs: Number(process.env.CLOCKWORK_CLAIM_LEASE_MS ?? DEFAULT_CLAIM_LEASE_MS)`.
- [ ] The worker is constructed with `heartbeatIntervalMs: Number(process.env.CLOCKWORK_HEARTBEAT_INTERVAL_MS ?? DEFAULT_HEARTBEAT_INTERVAL_MS)`.
- [ ] `DEFAULT_CLAIM_LEASE_MS` and `DEFAULT_HEARTBEAT_INTERVAL_MS` are imported from `./worker.ts`.
- [ ] `bun run typecheck` passes (the file compiles).
- [ ] No changes to files outside the list above.

**Assumptions (task-specific):** `src/index.ts` is the top-level entrypoint with side effects (it starts the server); there is no unit test for it — verification is `bun run typecheck` plus the full suite. Follow the existing `Number(process.env.X ?? default)` pattern already used for `CLOCKWORK_MAX_RETRIES` / `CLOCKWORK_POLL_INTERVAL_MS`.

**Step 1: Add the import**

Modify the worker import at `src/index.ts:3`:

```typescript
import { Worker, DEFAULT_CLAIM_LEASE_MS, DEFAULT_HEARTBEAT_INTERVAL_MS } from "./worker.ts"
```

**Step 2: Add the two config fields**

Inside the `new Worker({ ... })` object (after `buildCopyCommand: ...` at line 69), add:

```typescript
		claimLeaseMs: Number(process.env.CLOCKWORK_CLAIM_LEASE_MS ?? DEFAULT_CLAIM_LEASE_MS),
		heartbeatIntervalMs: Number(process.env.CLOCKWORK_HEARTBEAT_INTERVAL_MS ?? DEFAULT_HEARTBEAT_INTERVAL_MS),
```

**Step 3: Verify it compiles**

Run: `bun run typecheck`
Expected: no errors.

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire CLOCKWORK_CLAIM_LEASE_MS / CLOCKWORK_HEARTBEAT_INTERVAL_MS env"
```

---

### Task 7: Full regression + the gate

**Files:**
- No source changes (verification only). If anything is red, fix under the failing task's rules (test-first) before proceeding.

**Acceptance Criteria:**
- [ ] `bun test` — the ENTIRE suite passes (existing db/worker tests unchanged in behaviour: pass-moves-forward, fail-kicks-back, retry-counter, max-retries→needsHuman, never-claims-Done, dependency-ordering, idle, stop-in-flight, malformed-verdict, extraction-fallback, transcript-write-failure, per-card-git, merge-to-main, milestone-SMS, releaseClaimsByWorker).
- [ ] The new tests all pass: `reclaimExpiredClaims`, `renewClaim`, lease config surface, dead-worker reaping (+ valid-claim-not-reaped), heartbeat freshness (+ cleared-on-early-return).
- [ ] `bun run typecheck` — zero type errors.
- [ ] `bun run check` — GREEN (this is the mandatory commit gate per AGENTS.md).

**Step 1: Run the gate**

Run: `bun run check`
Expected: `tsc --noEmit` clean AND all tests pass.

**Step 2: If green, final commit (docs/impl-ref update — optional, recommended)**

Update `docs/impl-ref.md` to note the lease/heartbeat mechanism under the worker section (new `reclaimExpiredClaims` + `renewClaim` DbStore methods, the loop reaper, the `processCard` heartbeat, and the two new config fields/env vars). Then:

```bash
git add docs/impl-ref.md
git commit -m "docs: record claim-lease/heartbeat mechanism in impl-ref"
```

---

## Concurrency / edge-case coverage map

| Required edge case | Where covered |
|--------------------|---------------|
| (a) worker's own valid claim never reaped mid-processing | Task 5 heartbeat freshness test (renew moves `claimed_at` forward during the slow pi call); Task 3 invariant test (`lease > watchdog`). |
| (b) an expired claim from a dead worker is reclaimable | Task 1 `reclaimExpiredClaims` unit test (cross-worker) + Task 4 loop test (dead-worker claim reclaimed and advanced). |
| (c) heartbeat interval always cleared on finally | Task 5 both tests — "no further renews after return" and "cleared even on early column-lookup return". |
| (d) heartbeat on an already-moved/unclaimed card is a no-op | Task 2 `renewClaim` guard test (unclaimed → false, other worker → false) + Task 5 (card advanced to Done, not re-stamped). |
| (e) existing tests still pass | Task 7 full-suite regression. |
| (f) `bun run check` green | Task 7. |
| still-valid claim from ANOTHER worker not stolen | Task 1 (`fresh` claim untouched) + Task 4 second test. |
| single-worker model, dependency ordering, park/terminal exclusions preserved | Reaper only frees claims (sets `claim_state = NULL`); it does not bypass `claimCard()`'s eligibility filter, so those invariants are inherited unchanged — asserted by the unchanged dependency-ordering and never-claims-Done tests passing in Task 7. |

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-08-20-claim-lease-heartbeat-plan.md`. Three execution options:

1. **Subagent-Driven (this session)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
2. **Parallel Subagent-Driven (this session)** — concurrent subagents for independent tasks. Note: Tasks 1 and 2 are independent (both add DbStore methods); Tasks 3→4→5 are sequential (config → loop → processCard); Task 6 depends on Task 3; Task 7 is last. REQUIRED SUB-SKILL: superpowers:dispatching-parallel-agents.
3. **Parallel Session (separate)** — open a new session in the worktree and batch-execute with checkpoints. REQUIRED SUB-SKILL: superpowers:executing-plans.

Which approach?
