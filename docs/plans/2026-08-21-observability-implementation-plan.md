# Clockwork Observability — Board + Card Redesign Implementation Plan

> **For OpenCode:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Surface arbiter preemptions, live elapsed time, token usage, and dependencies on the clockwork board so the operator can see at a glance why work stalls, by adding preemption persistence + token capture in the data layer, a stats endpoint and enriched cards payload in the API, a live WebSocket stats event, and a redesigned single-file vanilla board matching the locked playground look.

**Architecture:** Additive-only SQLite changes (a new `preemptions` table + nullable token columns on `attempts`, both via the established `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN`-in-try/catch pattern). The worker's existing preemption-retry loop writes one `preemptions` row per detected preemption and records per-attempt tokens (real if pi exposes them, else a labelled context-size estimate). The API gains `GET /api/projects/:id/stats` (counter + 5-minute-bucket series + in-flight/done/tokens) and enriches the cards list with computed per-card observability fields (current stage, in-flight attempt `startedAt`, `dependsOn`, reverse-deps, retry, per-card preemptions, per-card tokens). A new `stats.updated` WebSocket event lets the dashboard panel refresh live. The board (`public/index.html`) is rebuilt as a single vanilla file: dense cards with a pulsing status dot, live-ticking elapsed timer, token/retry/preemption/dependency badges, plus a collapsible dashboard panel with an interrupt counter and a sparkline-bar graph, all wired to the new endpoint and event.

**Tech Stack:** Bun + TypeScript (ES modules, `function` declarations, explicit return types, no nested ternaries, tabs), `bun:sqlite` (WAL), `Bun.serve` HTTP + WebSocket, `bun:test`. Frontend is framework-free vanilla HTML/CSS/JS, no build step. The gate is `bun run check` (`tsc --noEmit` + `bun test`).

**Assumptions:**
- All migrations are **additive**: the live production DB on `studio` must keep working after a redeploy. Never `DROP`, never rewrite an existing column, never change an existing column type. New tables use `CREATE TABLE IF NOT EXISTS`; new columns use `ALTER TABLE ... ADD COLUMN` wrapped in `try/catch` (SQLite has no `ADD COLUMN IF NOT EXISTS`), exactly like the existing `depends_on` migration in `src/db.ts:189-195`.
- **Token capture is branched by Task 0** (a verify-first probe on `studio`). Branch A (real tokens): parse a usage block. Branch B (fallback): store `assembleContext(...).tokenCount` with `tokens_estimated = true`. The DB schema and the worker plumbing are written to support **both** branches from the start (a single nullable `tokens` integer + a `tokens_estimated` boolean), so only the *source* of the number changes; the schema does not. **Default to Branch B in the code**, and switch the worker's token source to Branch A only if Task 0 confirms real tokens are obtainable.
- Preemption time-series uses **fixed 5-minute buckets** over a **2-hour window** ending "now", returned oldest-bucket-first as a plain integer array (24 buckets), matching the playground's `renderSpark(data)` input shape.
- The board stays a **single** `public/index.html`, driven only by the existing REST + WebSocket. No framework, no bundler, no new runtime dependency.
- "Done" and park columns are identified the same way the worker already does it (`isTerminalColumn` = column name lowercased-trimmed equals `"done"`; park = name contains `human`/`director`). The API/UI reuse that convention; do not invent a new column-type field.
- Test helpers mirror the existing files exactly: `createTempDb()` (per-file temp sqlite), `seedTestData()` in worker tests, `startServer({ dbStore, port: 0 })` + `fetch` against `handle.port` in api/ws tests, and injected `worker.invokePi = mock(...)`.
- The card status shown on the board is **derived**, not stored: `running` if the card is claimed (`claimState === "claimed"`), `done` if in the terminal Done column, `blocked` if `retryCount >= maxRetries` (parked), else `idle`. This needs no schema change.

**Task order (dependency-first):**
0. Token probe (gates the token *source*, not the schema) — investigation, no code.
1. DB: `preemptions` table + `recordPreemption` + `getPreemptionStats`.
2. DB: nullable `tokens` + `tokens_estimated` columns on `attempts`, threaded through create/parse.
3. Worker: write a `preemptions` row per detected preemption.
4. Worker: populate per-attempt tokens (Branch B by default; Branch A if Task 0 says so).
5. API: `GET /api/projects/:id/stats`.
6. API: enrich `GET /api/projects/:id/cards` with observability fields.
7. WS: broadcast `stats.updated` when a preemption is recorded (worker → API callback → broker).
8. UI: rebuild card rendering (extract pure helpers so they are unit-testable) + dashboard panel + live tick + WS wiring.

---

## Task 0: Token-source probe (verify-first, gates Tasks 4's source only)

**Files:**
- Create: `docs/plans/2026-08-21-token-probe-finding.md` (the written finding — NOT code)
- Modify: none
- Test: none (this is an investigation task; its "acceptance" is a written finding + a chosen branch)

**Acceptance Criteria:**
- [ ] `docs/plans/2026-08-21-token-probe-finding.md` exists and records: the exact commands run, their raw output (trimmed), and a one-line verdict.
- [ ] The finding states **Branch A (real tokens available)** or **Branch B (estimate only)** explicitly.
- [ ] If Branch A: the finding names the exact JSON path to the token count(s) (for example `usage.prompt_tokens` / `usage.completion_tokens`, or pi's `--mode json` field name) so Task 4 can parse it.
- [ ] No files under `src/` are changed by this task.

**Assumptions (task-specific):** The `studio` host runs the pipeline; the model server (frame dense LOW, port 8185, OpenAI-compatible) may be **busy** serving live traffic. A busy/preempted probe is itself a data point — record it and, if you cannot get a clean answer within a few tries, choose **Branch B** and move on (the fallback is always valid).

**Step 1: Run the probe commands on `studio`**

Run these from your workstation (they SSH into `studio`; pi lives at `~/.nix-profile/bin/pi`, and the worker's home is `/home/<user>/.clockwork-home`):

```bash
# (a) Does pi --mode json emit a usage/token block?
ssh studio 'HOME=/home/<user>/.clockwork-home ~/.nix-profile/bin/pi -p --provider frame-dense-low --mode json "Say hi in one word." 2>/dev/null | tail -c 2000'

# (b) Does the OpenAI-compatible model server return a usage block directly?
ssh studio 'curl -s http://frame:8185/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\":\"dense\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":8}" | tail -c 2000'
```

Expected (Branch A): output contains a `usage` object with integer token fields, or pi's JSON contains a token count field.
Expected (Branch B): no usage block, an error, or the server is busy/preempted (503).

**Step 2: Write the finding**

Create `docs/plans/2026-08-21-token-probe-finding.md` with the commands, the trimmed raw output, and a verdict line, for example:

```markdown
# Token probe finding (2026-08-21)

## Commands run
(paste the two commands above)

## Output (trimmed)
(a) pi --mode json: <paste>
(b) model server /v1/chat/completions: <paste>

## Verdict
Branch B (estimate only): the model server returned no `usage` block / was busy (503),
and pi --mode json did not surface token counts to stdout. Task 4 will store
assembleContext(...).tokenCount with tokens_estimated = true.

# — OR —

Branch A (real tokens): the server returned usage.prompt_tokens / usage.completion_tokens.
Task 4 will sum them into the attempt's `tokens` with tokens_estimated = false.
Exact path: usage.prompt_tokens + usage.completion_tokens.
```

**Step 3: Commit**

```bash
git add docs/plans/2026-08-21-token-probe-finding.md
git commit -m "docs: token-source probe finding for clockwork observability (branch A/B decision)"
```

---

## Task 1: DB — `preemptions` table, `recordPreemption`, `getPreemptionStats`

**Files:**
- Modify: `src/db.ts` — add interfaces near line 44-59; add the `CREATE TABLE IF NOT EXISTS preemptions` + index inside `initialize()` after the `card_threads` block (around line 216) and alongside the index block (around line 222); add `recordPreemption` + `getPreemptionStats` methods after the attempts section (around line 660); add a `parsePreemptionRow` parser near the other parsers (around line 753).
- Test: `src/db.test.ts` — add a new `describe("DbStore — preemptions", ...)` block after the attempts describe block (around line 620).

**Acceptance Criteria:**
- [ ] A `preemptions` table is created with columns `id TEXT PRIMARY KEY`, `project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE`, `card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE`, `column_id TEXT`, `created_at DATETIME NOT NULL DEFAULT (datetime('now'))`.
- [ ] An index `idx_preemptions_project_id ON preemptions(project_id)` exists.
- [ ] `recordPreemption(input: RecordPreemptionInput): DbPreemption` inserts one row and returns it with a generated UUID `id` and a `createdAt: Date`.
- [ ] `getPreemptionStats(projectId: string): PreemptionStats` returns `{ total: number; series: number[]; perCard: Record<string, number> }` where `series` has exactly 24 integer buckets (5-minute buckets over the last 2 hours, oldest first), `total` is the count of all preemption rows for the project, and `perCard` maps `cardId → count`.
- [ ] Existing DB tests still pass (the `initialize` test that asserts table names still passes; add `preemptions` to it).
- [ ] `bun run check` is green.
- [ ] No files outside the list above are changed.

**Step 1: Write the failing tests**

Add to `src/db.test.ts` (after the attempts `describe`, around line 620):

```typescript
describe("DbStore — preemptions", () => {
	let store: DbStore
	let path: string
	let projectId: string
	let columnId: string
	let cardId: string

	beforeEach(() => {
		const result = createTempDb()
		store = result.store
		path = result.path
		const project = store.createProject({ name: "P", description: "", githubRepo: null, branch: null })
		projectId = project.id
		const column = store.createColumn({ projectId, name: "Impl", prompt: "", skills: [], model: null, position: 0 })
		columnId = column.id
		const card = store.createCard({ projectId, columnId, title: "Card", body: "", position: 0 })
		cardId = card.id
	})

	afterEach(() => {
		store.close()
	})

	it("records a preemption row and returns it", () => {
		const p = store.recordPreemption({ projectId, cardId, columnId })
		expect(p.id).toBeDefined()
		expect(p.projectId).toBe(projectId)
		expect(p.cardId).toBe(cardId)
		expect(p.columnId).toBe(columnId)
		expect(p.createdAt).toBeInstanceOf(Date)
	})

	it("getPreemptionStats totals all rows for the project", () => {
		store.recordPreemption({ projectId, cardId, columnId })
		store.recordPreemption({ projectId, cardId, columnId })
		const stats = store.getPreemptionStats(projectId)
		expect(stats.total).toBe(2)
	})

	it("getPreemptionStats returns exactly 24 five-minute buckets", () => {
		store.recordPreemption({ projectId, cardId, columnId })
		const stats = store.getPreemptionStats(projectId)
		expect(stats.series.length).toBe(24)
		expect(stats.series.every((n) => Number.isInteger(n))).toBe(true)
		// A just-now preemption lands in the last (most recent) bucket.
		expect(stats.series[stats.series.length - 1]!).toBeGreaterThanOrEqual(1)
	})

	it("getPreemptionStats counts per card", () => {
		const card2 = store.createCard({ projectId, columnId, title: "C2", body: "", position: 1 })
		store.recordPreemption({ projectId, cardId, columnId })
		store.recordPreemption({ projectId, cardId, columnId })
		store.recordPreemption({ projectId, cardId: card2.id, columnId })
		const stats = store.getPreemptionStats(projectId)
		expect(stats.perCard[cardId]).toBe(2)
		expect(stats.perCard[card2.id]).toBe(1)
	})

	it("preemptions cascade-delete with their card", () => {
		store.recordPreemption({ projectId, cardId, columnId })
		store.deleteCard(cardId)
		const stats = store.getPreemptionStats(projectId)
		expect(stats.total).toBe(0)
	})
})
```

Also extend the existing initialization test (around `src/db.test.ts:22`) to assert the new table:

```typescript
		expect(tables.map((t: any) => t.name)).toContain("preemptions")
```

**Step 2: Run the tests to verify they fail**

Run: `bun test src/db.test.ts`
Expected: FAIL — `store.recordPreemption is not a function` (and the initialize test fails on the missing `preemptions` table).

**Step 3: Write the minimal implementation**

In `src/db.ts`, add interfaces after `DbCardThreadEntry` (around line 59):

```typescript
export interface DbPreemption {
	id: string
	projectId: string
	cardId: string
	columnId: string | null
	createdAt: Date
}

export interface RecordPreemptionInput {
	projectId: string
	cardId: string
	columnId: string | null
}

export interface PreemptionStats {
	total: number
	series: number[]
	perCard: Record<string, number>
}
```

In `initialize()`, add the table right after the `card_threads` `CREATE TABLE` (around line 216, before the index block):

```typescript
		this.run(`
			CREATE TABLE IF NOT EXISTS preemptions (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
				card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
				column_id TEXT,
				created_at DATETIME NOT NULL DEFAULT (datetime('now'))
			)
		`)
```

And add its index alongside the other `CREATE INDEX` calls (around line 223):

```typescript
		this.run("CREATE INDEX IF NOT EXISTS idx_preemptions_project_id ON preemptions(project_id)")
```

Add methods after the attempts section (after `getAttemptById`, around line 660):

```typescript
	// --- Preemptions ---

	recordPreemption(input: RecordPreemptionInput): DbPreemption {
		const id = crypto.randomUUID()
		this.run(`
			INSERT INTO preemptions (id, project_id, card_id, column_id)
			VALUES (?, ?, ?, ?)
		`, id, input.projectId, input.cardId, input.columnId ?? null)
		const row = this.db
			.prepare("SELECT * FROM preemptions WHERE id = ?")
			.get(id) as any
		return this.parsePreemptionRow(row)
	}

	// Total preemptions for a project, a 24-bucket (5-minute) series over the last
	// 2 hours (oldest bucket first, for the sparkline), and a per-card count.
	getPreemptionStats(projectId: string): PreemptionStats {
		const rows = this.db
			.prepare("SELECT card_id, created_at FROM preemptions WHERE project_id = ?")
			.all(projectId) as any[]

		const bucketMs = 5 * 60 * 1000
		const bucketCount = 24
		const windowMs = bucketMs * bucketCount
		const now = Date.now()
		const windowStart = now - windowMs

		const series = new Array<number>(bucketCount).fill(0)
		const perCard: Record<string, number> = {}
		let total = 0

		for (const row of rows) {
			total += 1
			perCard[row.card_id] = (perCard[row.card_id] ?? 0) + 1
			const t = new Date(row.created_at).getTime()
			if (t >= windowStart && t <= now) {
				let idx = Math.floor((t - windowStart) / bucketMs)
				if (idx < 0) {
					idx = 0
				}
				if (idx >= bucketCount) {
					idx = bucketCount - 1
				}
				series[idx] = (series[idx] ?? 0) + 1
			}
		}

		return { total, series, perCard }
	}
```

Add the parser near the other parsers (around line 753):

```typescript
	private parsePreemptionRow(row: any): DbPreemption {
		return {
			id: row.id,
			projectId: row.project_id,
			cardId: row.card_id,
			columnId: row.column_id ?? null,
			createdAt: new Date(row.created_at),
		}
	}
```

**Step 4: Run the tests to verify they pass**

Run: `bun run check`
Expected: PASS (typecheck clean, all db tests green).

**Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(db): persist arbiter preemptions with per-project stats + 5-min series"
```

---

## Task 2: DB — nullable `tokens` + `tokens_estimated` on `attempts`

**Files:**
- Modify: `src/db.ts` — extend `DbAttempt` (line 44-51) and `CreateAttemptInput` (line 113-119); add two additive `ALTER TABLE attempts ADD COLUMN ...` migrations in `initialize()` right after the `attempts` `CREATE TABLE` (around line 206); thread the fields through `createAttempt` (line 599-615) and `parseAttemptRow` (line 744-753).
- Test: `src/db.test.ts` — add tests to the existing `describe("DbStore — attempts", ...)` block (around line 618).

**Acceptance Criteria:**
- [ ] `DbAttempt` gains `tokens: number | null` and `tokensEstimated: boolean`.
- [ ] `CreateAttemptInput` gains optional `tokens?: number | null` and `tokensEstimated?: boolean` (both default to `null` / `false` when omitted, preserving every existing `createAttempt` call site with no change).
- [ ] `initialize()` runs `ALTER TABLE attempts ADD COLUMN tokens INTEGER` and `ALTER TABLE attempts ADD COLUMN tokens_estimated INTEGER NOT NULL DEFAULT 0`, each wrapped in its own `try/catch` (duplicate-column tolerated), matching the `depends_on` pattern at `src/db.ts:189-195`.
- [ ] A pre-existing attempt row (created before the columns existed) parses with `tokens = null`, `tokensEstimated = false` (no crash on the migrated DB).
- [ ] `createAttempt` with `tokens: 1234, tokensEstimated: true` round-trips those values through `getAttemptById`.
- [ ] `createAttempt` called WITHOUT the new fields yields `tokens = null`, `tokensEstimated = false`.
- [ ] `bun run check` is green.
- [ ] No files outside the list above are changed.

**Step 1: Write the failing tests**

Add to the attempts `describe` in `src/db.test.ts`:

```typescript
	it("stores and round-trips token fields", () => {
		const attempt = store.createAttempt({
			cardId,
			transcriptPath: null,
			verdict: null,
			startedAt: new Date(),
			completedAt: null,
			tokens: 1234,
			tokensEstimated: true,
		})
		const found = store.getAttemptById(attempt.id)
		expect(found!.tokens).toBe(1234)
		expect(found!.tokensEstimated).toBe(true)
	})

	it("defaults token fields to null/false when omitted", () => {
		const attempt = store.createAttempt({
			cardId,
			transcriptPath: null,
			verdict: null,
			startedAt: new Date(),
			completedAt: null,
		})
		const found = store.getAttemptById(attempt.id)
		expect(found!.tokens).toBeNull()
		expect(found!.tokensEstimated).toBe(false)
	})
```

**Step 2: Run the tests to verify they fail**

Run: `bun test src/db.test.ts`
Expected: FAIL — `found.tokens` is `undefined` (property does not exist yet), TypeScript also errors on the unknown `tokens` input field.

**Step 3: Write the minimal implementation**

Extend `DbAttempt` (line 44):

```typescript
export interface DbAttempt {
	id: string
	cardId: string
	transcriptPath: string | null
	verdict: Record<string, unknown> | null
	startedAt: Date
	completedAt: Date | null
	tokens: number | null
	tokensEstimated: boolean
}
```

Extend `CreateAttemptInput` (line 113):

```typescript
export interface CreateAttemptInput {
	cardId: string
	transcriptPath: string | null
	verdict: Record<string, unknown> | null
	startedAt: Date
	completedAt: Date | null
	tokens?: number | null
	tokensEstimated?: boolean
}
```

Add the additive migrations in `initialize()` right after the `attempts` `CREATE TABLE` block (around line 206):

```typescript
		// Additive migrations for token capture on pre-existing databases. Same
		// duplicate-column-tolerant pattern as depends_on above.
		try {
			this.run("ALTER TABLE attempts ADD COLUMN tokens INTEGER")
		} catch {
			// Column already exists — nothing to do.
		}
		try {
			this.run("ALTER TABLE attempts ADD COLUMN tokens_estimated INTEGER NOT NULL DEFAULT 0")
		} catch {
			// Column already exists — nothing to do.
		}
```

Update `createAttempt` (line 599) to insert the new columns:

```typescript
	createAttempt(input: CreateAttemptInput): DbAttempt {
		const id = crypto.randomUUID()
		this.run(`
			INSERT INTO attempts (id, card_id, transcript_path, verdict, started_at, completed_at, tokens, tokens_estimated)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`,
			id,
			input.cardId,
			input.transcriptPath ?? null,
			input.verdict !== null ? JSON.stringify(input.verdict) : null,
			input.startedAt.toISOString(),
			input.completedAt ? input.completedAt.toISOString() : null,
			input.tokens ?? null,
			input.tokensEstimated ? 1 : 0
		)
		return this.parseAttemptRow(this.db
			.prepare("SELECT * FROM attempts WHERE id = ?")
			.get(id) as any)
	}
```

Update `parseAttemptRow` (line 744) — tolerate `undefined` for rows from a DB migrated in-place:

```typescript
	private parseAttemptRow(row: any): DbAttempt {
		return {
			id: row.id,
			cardId: row.card_id,
			transcriptPath: row.transcript_path,
			verdict: row.verdict ? JSON.parse(row.verdict) : null,
			startedAt: new Date(row.started_at),
			completedAt: row.completed_at ? new Date(row.completed_at) : null,
			tokens: row.tokens ?? null,
			tokensEstimated: row.tokens_estimated === 1,
		}
	}
```

**Step 4: Run the tests to verify they pass**

Run: `bun run check`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(db): nullable per-attempt token columns (additive migration)"
```

---

## Task 3: Worker — record a preemption row on each detected preemption

**Files:**
- Modify: `src/worker.ts` — in the preemption-retry `while` loop inside `processCard` (line 528-533), call `this.dbStore.recordPreemption(...)` each iteration; add an optional `onPreemption?` config hook to `WorkerConfig` (around line 45-51) and to the `Worker` class fields/constructor so Task 7 can broadcast (do NOT wire the broadcast here).
- Test: `src/worker.test.ts` — add a `describe("Worker — records preemption rows", ...)` block near the existing preemption test (around line 426).

**Acceptance Criteria:**
- [ ] Each time `isPreemption(result)` is true inside the retry loop, exactly one `preemptions` row is written for that card (project id, card id, current column id).
- [ ] Given a fake pi that returns one preemption then a pass, exactly **one** `preemptions` row exists for the card afterward, and the card still advances with `retryCount === 0` (the existing preemption semantics are unchanged).
- [ ] A new optional `onPreemption?: (p: { projectId: string; cardId: string; columnId: string | null }) => void` config field exists on `WorkerConfig` and is invoked (if set) after each row is written. It is `undefined` in all existing tests and must not break them.
- [ ] All existing worker tests still pass.
- [ ] `bun run check` is green.
- [ ] No files outside the list above are changed.

**Step 1: Write the failing test**

Add to `src/worker.test.ts`:

```typescript
describe("Worker — records preemption rows", () => {
	it("writes one preemption row per detected preemption and still advances", async () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)
		store.createColumn({
			projectId: seeded.projectId, name: "Done", prompt: "done",
			skills: [], model: null, position: 1,
		})

		let calls = 0
		const observed: Array<{ cardId: string }> = []
		const worker = new Worker({
			dbStore: store, projectId: seeded.projectId, token: "", workerId: "w",
			projectRoot: "/tmp", transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50, maxRetries: 3, preemptionBackoffMs: 1,
			onPreemption: (p) => observed.push({ cardId: p.cardId }),
		})
		worker.invokePi = mock(() => {
			calls += 1
			if (calls === 1) {
				return Promise.resolve({ stdout: "", stderr: "503 preempted by higher-priority request", exitCode: 1 })
			}
			return Promise.resolve({ stdout: JSON.stringify({ verdict: "pass", feedback: "ok", artifacts: [] }), stderr: "", exitCode: 0 })
		})

		await startWorker(worker)
		worker.stop()
		await worker.stopped()

		const stats = store.getPreemptionStats(seeded.projectId)
		expect(stats.total).toBe(1)
		expect(stats.perCard[seeded.cardId]).toBe(1)
		expect(observed.length).toBe(1)
		expect(observed[0]!.cardId).toBe(seeded.cardId)
		// Preemption semantics preserved: retry not consumed, card advanced.
		const card = store.getCardById(seeded.cardId)!
		expect(card.retryCount).toBe(0)
		expect(card.columnId).not.toBe(seeded.columnId)

		store.close()
		fs.unlinkSync(path)
	})
})
```

**Step 2: Run the test to verify it fails**

Run: `bun test src/worker.test.ts`
Expected: FAIL — `stats.total` is `0` (no row written) and TypeScript errors on the unknown `onPreemption` config field.

**Step 3: Write the minimal implementation**

Add to `WorkerConfig` (around line 50, before the closing brace):

```typescript
	// Fired once per detected arbiter preemption, AFTER the preemption row is
	// persisted. Lets the server broadcast a live stats event without the worker
	// importing the broker. Optional; undefined = no callback.
	onPreemption?: (p: { projectId: string; cardId: string; columnId: string | null }) => void
```

Add the field to the class (near line 249) and assign it in the constructor (near line 275):

```typescript
	public readonly onPreemption: ((p: { projectId: string; cardId: string; columnId: string | null }) => void) | undefined
```

```typescript
		this.onPreemption = config.onPreemption
```

Update the preemption retry loop (line 528-533):

```typescript
		let result = await invokeFn(piArgs)
		let preemptions = 0
		while (isPreemption(result) && preemptions < this.maxPreemptionRetries) {
			preemptions += 1
			// Persist the preemption so the board's counter + sparkline reflect real
			// data (this was previously only an event/log — invisible to the operator).
			try {
				this.dbStore.recordPreemption({ projectId: this.projectId, cardId: card.id, columnId: card.columnId })
				if (this.onPreemption) {
					this.onPreemption({ projectId: this.projectId, cardId: card.id, columnId: card.columnId })
				}
			} catch {
				// Recording a preemption is best-effort observability; never let it
				// break the retry loop or strand the card.
			}
			emitEvent(this.onEvent, { type: "blocked", cardId: card.id, reason: `arbiter preempted (transient) — retry ${preemptions}/${this.maxPreemptionRetries} after backoff` })
			await new Promise((resolve) => setTimeout(resolve, this.preemptionBackoffMs))
			result = await invokeFn(piArgs)
		}
```

**Step 4: Run the tests to verify they pass**

Run: `bun run check`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat(worker): persist a preemption row per arbiter preemption (+onPreemption hook)"
```

---

## Task 4: Worker — populate per-attempt tokens

**Files:**
- Modify: `src/worker.ts` — in `processCard`, capture the assembled token count and thread it into the `createAttempt` call (line 580-586). Add a small helper `extractTokens(result: PiResult): number | null` (Branch A parser) near the top-level helpers (around line 197), used only if Task 0 chose Branch A.
- Test: `src/worker.test.ts` — add a `describe("Worker — captures tokens per attempt", ...)` block.

**Acceptance Criteria:**
- [ ] **Branch B (default):** after a card runs, its recorded attempt has `tokens` equal to the assembled context's `tokenCount` (a positive integer) and `tokensEstimated === true`.
- [ ] **Branch A (only if Task 0 said so):** `extractTokens(result)` parses the real usage block from `result.stdout`; when present, the attempt's `tokens` is that value and `tokensEstimated === false`; when absent, it falls back to the estimate (Branch B) so a missing usage block never loses the field.
- [ ] The token capture must not throw out of `processCard` (wrap parsing in try/catch; on failure store the estimate).
- [ ] All existing worker tests still pass (they call `createAttempt` indirectly; the new fields are additive with safe defaults).
- [ ] `bun run check` is green.
- [ ] No files outside the list above are changed.

**Assumptions (task-specific):** Implement Branch B unconditionally first (it is always valid and testable offline). Only add the Branch A parser + switch if `docs/plans/2026-08-21-token-probe-finding.md` says Branch A. The `assembled` object from `assembleContext(...)` is already computed at `src/worker.ts:474`; reuse its `.tokenCount`.

**Step 1: Write the failing test (Branch B — the default)**

Add to `src/worker.test.ts`:

```typescript
describe("Worker — captures tokens per attempt", () => {
	it("stores the assembled-context token estimate on the attempt (Branch B)", async () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)
		const worker = new Worker({
			dbStore: store, projectId: seeded.projectId, token: "", workerId: "w",
			projectRoot: "/tmp", transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50, maxRetries: 3,
		})
		worker.invokePi = mock(() =>
			Promise.resolve({ stdout: JSON.stringify({ verdict: "pass", feedback: "ok", artifacts: [] }), stderr: "", exitCode: 0 }),
		)

		const card0 = await worker["claimCard"]()
		await worker.processCard(card0!)

		const attempts = store.getAttemptsByCard(seeded.cardId)
		expect(attempts.length).toBe(1)
		expect(attempts[0]!.tokens).toBeGreaterThan(0)
		expect(attempts[0]!.tokensEstimated).toBe(true)

		store.close()
		fs.unlinkSync(path)
	})
})
```

If Task 0 chose **Branch A**, ALSO add:

```typescript
	it("prefers a real usage block over the estimate (Branch A)", async () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)
		const worker = new Worker({
			dbStore: store, projectId: seeded.projectId, token: "", workerId: "w",
			projectRoot: "/tmp", transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50, maxRetries: 3,
		})
		// stdout carries a usage block AND the verdict trailer.
		worker.invokePi = mock(() =>
			Promise.resolve({
				stdout: '{"usage":{"prompt_tokens":900,"completion_tokens":100}}\n{"verdict":"pass","feedback":"ok","artifacts":[]}',
				stderr: "", exitCode: 0,
			}),
		)

		const card0 = await worker["claimCard"]()
		await worker.processCard(card0!)

		const attempts = store.getAttemptsByCard(seeded.cardId)
		expect(attempts[0]!.tokens).toBe(1000)
		expect(attempts[0]!.tokensEstimated).toBe(false)

		store.close()
		fs.unlinkSync(path)
	})
```

**Step 2: Run the test to verify it fails**

Run: `bun test src/worker.test.ts`
Expected: FAIL — `attempts[0].tokens` is `null` (worker does not yet set it).

**Step 3: Write the minimal implementation**

Branch B (default) — update the `createAttempt` call in `processCard` (line 580):

```typescript
			this.dbStore.createAttempt({
				cardId: card.id,
				transcriptPath,
				verdict: { verdict: verdict.verdict, feedback: verdict.feedback, artifacts: verdict.artifacts, columnId: card.columnId },
				startedAt,
				completedAt: new Date(),
				tokens: assembled.tokenCount,
				tokensEstimated: true,
			})
```

Branch A (ONLY if Task 0 chose it) — add the helper near the other top-level helpers (around line 197):

```typescript
// Branch A token capture: parse a real usage block from pi's stdout. Returns the
// summed prompt+completion tokens, or null if no usage block is present. Best-effort:
// any parse failure returns null so the caller falls back to the context estimate.
export function extractTokens(result: PiResult): number | null {
	try {
		const match = result.stdout.match(/"usage"\s*:\s*\{[^}]*\}/)
		if (!match) {
			return null
		}
		const usage = JSON.parse(`{${match[0]}}`).usage
		const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0
		const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0
		const sum = prompt + completion
		return sum > 0 ? sum : null
	} catch {
		return null
	}
}
```

And branch the fields (Branch A) in the `createAttempt` call instead of the Branch-B version above:

```typescript
			const realTokens = extractTokens(result)
			this.dbStore.createAttempt({
				cardId: card.id,
				transcriptPath,
				verdict: { verdict: verdict.verdict, feedback: verdict.feedback, artifacts: verdict.artifacts, columnId: card.columnId },
				startedAt,
				completedAt: new Date(),
				tokens: realTokens ?? assembled.tokenCount,
				tokensEstimated: realTokens === null,
			})
```

**Step 4: Run the tests to verify they pass**

Run: `bun run check`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat(worker): capture per-attempt tokens (estimate by default; real if available)"
```

---

## Task 5: API — `GET /api/projects/:id/stats`

**Files:**
- Modify: `src/api.ts` — add `handleStatsGet(...)` after `handleCardsGet` (around line 400); add a route for it in `route()` alongside the other `projectMatch` routes (around line 692). Reuse `isTerminalColumn`-style logic locally (a `columnIsDone(name)` helper) — do NOT import from worker.ts (keep the API free of worker imports).
- Test: `src/api.test.ts` — add a `describe("Stats", ...)` block.

**Acceptance Criteria:**
- [ ] `GET /api/projects/:id/stats` returns `200` with `{ preemptionsTotal: number, preemptionSeries: number[], inFlight: number, cardsDone: number, totalTokens: number }`.
- [ ] `preemptionsTotal` and `preemptionSeries` come from `dbStore.getPreemptionStats(id)` (series length 24).
- [ ] `inFlight` = count of cards with `claimState === "claimed"`.
- [ ] `cardsDone` = count of cards whose column name (case-insensitive, trimmed) equals `"done"`.
- [ ] `totalTokens` = sum of `tokens` across all attempts of all cards in the project (nulls treated as 0).
- [ ] Returns `404` for an unknown project id.
- [ ] `bun run check` is green.
- [ ] No files outside the list above are changed.

**Step 1: Write the failing tests**

Add to `src/api.test.ts` (inside the top-level `describe("REST API", ...)`):

```typescript
	describe("Stats", () => {
		let projectId: string
		let doneColId: string
		let implColId: string

		beforeEach(() => {
			const project = db.createProject({ name: "S", description: "", githubRepo: null, branch: null })
			projectId = project.id
			implColId = db.createColumn({ projectId, name: "Impl", prompt: "", skills: [], model: null, position: 0 }).id
			doneColId = db.createColumn({ projectId, name: "Done", prompt: "", skills: [], model: null, position: 1 }).id
		})

		it("returns stats shape with preemptions, in-flight, done, tokens", async () => {
			const running = db.createCard({ projectId, columnId: implColId, title: "Running", body: "", position: 0 })
			db.claimCard(running.id, "w")
			const done = db.createCard({ projectId, columnId: doneColId, title: "Done card", body: "", position: 0 })
			db.recordPreemption({ projectId, cardId: running.id, columnId: implColId })
			db.recordPreemption({ projectId, cardId: running.id, columnId: implColId })
			db.createAttempt({ cardId: running.id, transcriptPath: null, verdict: null, startedAt: new Date(), completedAt: null, tokens: 500, tokensEstimated: true })
			db.createAttempt({ cardId: done.id, transcriptPath: null, verdict: null, startedAt: new Date(), completedAt: null, tokens: 250, tokensEstimated: true })

			const res = await fetch(`${baseUrl}/api/projects/${projectId}/stats`)
			expect(res.status).toBe(200)
			const data: any = await res.json()
			expect(data.preemptionsTotal).toBe(2)
			expect(Array.isArray(data.preemptionSeries)).toBe(true)
			expect(data.preemptionSeries.length).toBe(24)
			expect(data.inFlight).toBe(1)
			expect(data.cardsDone).toBe(1)
			expect(data.totalTokens).toBe(750)
		})

		it("returns 404 for unknown project", async () => {
			const res = await fetch(`${baseUrl}/api/projects/nonexistent/stats`)
			expect(res.status).toBe(404)
		})
	})
```

**Step 2: Run the tests to verify they fail**

Run: `bun test src/api.test.ts`
Expected: FAIL — the stats route returns `404 not found` for the valid project (no handler yet).

**Step 3: Write the minimal implementation**

Add a local helper near the top of `src/api.ts` (after `findClaimableCard`, around line 236):

```typescript
function columnIsDone(name: string): boolean {
	return name.toLowerCase().trim() === "done"
}
```

Add the handler after `handleCardsGet` (around line 400):

```typescript
async function handleStatsGet(request: Request, dbStore: DbStore, projectId: string, _broker: WsBroker): Promise<Response> {
	const project = dbStore.getProjectById(projectId)
	if (!project) {
		return errorResponse(404, "project not found")
	}

	const preemptions = dbStore.getPreemptionStats(projectId)
	const columns = dbStore.getColumnsByProject(projectId)
	const doneColumnIds = new Set(columns.filter((c) => columnIsDone(c.name)).map((c) => c.id))
	const cards = dbStore.getCardsByProject(projectId)

	let inFlight = 0
	let cardsDone = 0
	let totalTokens = 0

	for (const card of cards) {
		if (card.claimState === "claimed") {
			inFlight += 1
		}
		if (doneColumnIds.has(card.columnId)) {
			cardsDone += 1
		}
		for (const attempt of dbStore.getAttemptsByCard(card.id)) {
			totalTokens += attempt.tokens ?? 0
		}
	}

	return jsonResponse(200, {
		preemptionsTotal: preemptions.total,
		preemptionSeries: preemptions.series,
		inFlight,
		cardsDone,
		totalTokens,
	})
}
```

Add the route in `route()` alongside the other `projectMatch` routes (after the `/cards` GET, around line 694):

```typescript
	if (method === "GET" && projectMatch.match && projectMatch.rest === "/stats") {
		return handleStatsGet(request, dbStore, projectMatch.param!, broker)
	}
```

**Step 4: Run the tests to verify they pass**

Run: `bun run check`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/api.ts src/api.test.ts
git commit -m "feat(api): GET /api/projects/:id/stats (preemptions, in-flight, done, tokens)"
```

---

## Task 6: API — enrich the cards list with observability fields

**Files:**
- Modify: `src/api.ts` — add an `enrichCard(...)` helper and change `handleCardsGet` (line 381-400) to return enriched card objects (spread the raw `DbCard` plus the new fields, so existing consumers keep working). Add the same local `columnIsDone` reuse.
- Test: `src/api.test.ts` — add tests to the existing `describe("Cards", ...)` (around line 352) or a new `describe("Cards — observability fields", ...)`.

**Acceptance Criteria:**
- [ ] Each card in `GET /api/projects/:id/cards` includes all original `DbCard` fields **plus**: `currentStage: string | null` (its column name), `inFlightAttemptStartedAt: string | null` (ISO string of the most recent attempt with `completedAt === null`, else null), `dependsOn: string | null` (already present, unchanged), `reverseDeps: string[]` (ids of cards whose `dependsOn` equals this card's id), `retryCount` (unchanged), `perCardPreemptions: number`, `perCardTokens: number`.
- [ ] `reverseDeps` is computed server-side across the project's cards (a card that no one depends on has `[]`).
- [ ] `perCardPreemptions` comes from `getPreemptionStats(projectId).perCard[cardId] ?? 0`.
- [ ] `perCardTokens` = sum of `tokens` over that card's attempts (nulls as 0).
- [ ] The `?column_id=` filter still works and returns enriched cards.
- [ ] Existing card tests (which assert `title`, `columnId`, `retryCount`, `claimState`) still pass — enrichment is additive.
- [ ] `bun run check` is green.
- [ ] No files outside the list above are changed.

**Step 1: Write the failing tests**

Add to `src/api.test.ts`:

```typescript
	describe("Cards — observability fields", () => {
		let projectId: string
		let implColId: string
		let doneColId: string

		beforeEach(() => {
			const project = db.createProject({ name: "O", description: "", githubRepo: null, branch: null })
			projectId = project.id
			implColId = db.createColumn({ projectId, name: "Impl", prompt: "", skills: [], model: null, position: 0 }).id
			doneColId = db.createColumn({ projectId, name: "Done", prompt: "", skills: [], model: null, position: 1 }).id
		})

		it("includes stage, reverse-deps, preemptions, tokens and in-flight startedAt", async () => {
			const first = db.createCard({ projectId, columnId: implColId, title: "First", body: "", position: 0 })
			const dependent = db.createCard({ projectId, columnId: implColId, title: "Second", body: "", position: 1, dependsOn: first.id })
			db.claimCard(first.id, "w")
			db.recordPreemption({ projectId, cardId: first.id, columnId: implColId })
			// An in-flight (not completed) attempt drives inFlightAttemptStartedAt.
			db.createAttempt({ cardId: first.id, transcriptPath: null, verdict: null, startedAt: new Date("2026-08-21T10:00:00Z"), completedAt: null, tokens: 400, tokensEstimated: true })

			const res = await fetch(`${baseUrl}/api/projects/${projectId}/cards`)
			expect(res.status).toBe(200)
			const cards: any[] = await res.json()
			const firstOut = cards.find((c) => c.id === first.id)
			const secondOut = cards.find((c) => c.id === dependent.id)

			expect(firstOut.currentStage).toBe("Impl")
			expect(firstOut.reverseDeps).toEqual([dependent.id])
			expect(firstOut.perCardPreemptions).toBe(1)
			expect(firstOut.perCardTokens).toBe(400)
			expect(firstOut.inFlightAttemptStartedAt).toBe(new Date("2026-08-21T10:00:00Z").toISOString())
			expect(secondOut.dependsOn).toBe(first.id)
			expect(secondOut.reverseDeps).toEqual([])
			expect(secondOut.inFlightAttemptStartedAt).toBeNull()
		})
	})
```

**Step 2: Run the tests to verify they fail**

Run: `bun test src/api.test.ts`
Expected: FAIL — `firstOut.currentStage` is `undefined` (cards are not enriched yet).

**Step 3: Write the minimal implementation**

Add the enrichment helper in `src/api.ts` (after `columnIsDone`, around line 240):

```typescript
function enrichCard(
	dbStore: DbStore,
	card: DbCard,
	columnNameById: Map<string, string>,
	reverseDepsById: Map<string, string[]>,
	perCardPreemptions: Record<string, number>,
): Record<string, unknown> {
	const attempts = dbStore.getAttemptsByCard(card.id)
	let inFlightAttemptStartedAt: string | null = null
	let perCardTokens = 0
	for (const attempt of attempts) {
		perCardTokens += attempt.tokens ?? 0
		// getAttemptsByCard is newest-first; the first not-yet-completed attempt is
		// the in-flight one whose startedAt drives the live elapsed timer.
		if (inFlightAttemptStartedAt === null && attempt.completedAt === null) {
			inFlightAttemptStartedAt = attempt.startedAt.toISOString()
		}
	}

	return {
		...card,
		currentStage: columnNameById.get(card.columnId) ?? null,
		inFlightAttemptStartedAt,
		reverseDeps: reverseDepsById.get(card.id) ?? [],
		perCardPreemptions: perCardPreemptions[card.id] ?? 0,
		perCardTokens,
	}
}
```

Rewrite `handleCardsGet` (line 381) to enrich:

```typescript
async function handleCardsGet(request: Request, dbStore: DbStore, projectId: string, _broker: WsBroker): Promise<Response> {
	const project = dbStore.getProjectById(projectId)
	if (!project) {
		return errorResponse(404, "project not found")
	}

	const url = new URL(request.url)
	const columnId = url.searchParams.get("column_id")

	const allCards = dbStore.getCardsByProject(projectId)
	const columns = dbStore.getColumnsByProject(projectId)
	const columnNameById = new Map(columns.map((c) => [c.id, c.name]))

	const reverseDepsById = new Map<string, string[]>()
	for (const c of allCards) {
		if (c.dependsOn) {
			const list = reverseDepsById.get(c.dependsOn) ?? []
			list.push(c.id)
			reverseDepsById.set(c.dependsOn, list)
		}
	}

	const perCardPreemptions = dbStore.getPreemptionStats(projectId).perCard

	const source = columnId ? allCards.filter((c) => c.columnId === columnId) : allCards
	const enriched = source.map((c) => enrichCard(dbStore, c, columnNameById, reverseDepsById, perCardPreemptions))

	return jsonResponse(200, enriched)
}
```

**Step 4: Run the tests to verify they pass**

Run: `bun run check`
Expected: PASS (existing card tests still green — enrichment spreads the original fields).

**Step 5: Commit**

```bash
git add src/api.ts src/api.test.ts
git commit -m "feat(api): enrich cards with stage, reverse-deps, per-card preemptions + tokens"
```

---

## Task 7: WS — broadcast `stats.updated` on a recorded preemption

**Files:**
- Modify: `src/ws.ts` — add `{ type: "stats.updated"; projectId: string; timestamp: number }` to the `WSMessage` union (line 3-16).
- Modify: `src/api.ts` — in `startServer`, when constructing the `Worker` is NOT done here (the worker lives in `index.ts`); instead expose the broker so `index.ts` can wire the worker's `onPreemption` to a broadcast. Add `broker` to the returned `ServerHandle` (line 17-21) and to the `startServer` return (line 787-794).
- Modify: `src/index.ts` — pass `onPreemption: (p) => server.broker.broadcast({ type: "stats.updated", projectId: p.projectId, timestamp: Date.now() })` into the `Worker` config (around line 55-84).
- Test: `src/ws.test.ts` — add a test that a recorded preemption (driven through a worker with a broadcast callback) emits `stats.updated`. Simpler + hermetic: test the broker directly by calling `broker.broadcast({ type: "stats.updated", ... })` and asserting a subscribed client receives it.

**Acceptance Criteria:**
- [ ] `WSMessage` includes a `stats.updated` variant carrying `projectId` and `timestamp`.
- [ ] `ServerHandle` exposes `broker: WsBroker`, and `startServer` returns it.
- [ ] A WebSocket client subscribed to project X receives a `stats.updated` event for project X when `broker.broadcast(...)` is called with it (reusing the existing project-filtering in `shouldReceive`).
- [ ] `index.ts` wires `worker.onPreemption` → `server.broker.broadcast({ type: "stats.updated", ... })` (verified by reading; not unit-tested since `index.ts` is the composition root).
- [ ] All existing ws tests still pass.
- [ ] `bun run check` is green.
- [ ] No files outside the list above are changed.

**Step 1: Write the failing test**

Add to `src/ws.test.ts`:

```typescript
	it("delivers a stats.updated event to a subscribed client", async () => {
		const ws = new WebSocket(wsUrl)
		await new Promise<void>((resolve) => { ws.onopen = () => resolve() })

		const project = db.createProject({ name: "Test", description: "", githubRepo: "x", branch: "main" })
		ws.send(JSON.stringify({ type: "subscribe", projectId: project.id }))

		const received: any[] = []
		ws.onmessage = (event) => {
			received.push(typeof event.data === "string"
				? JSON.parse(event.data)
				: JSON.parse(new TextDecoder().decode(event.data)))
		}

		// Broadcast directly through the server's broker (the same call index.ts makes
		// from the worker's onPreemption hook).
		handle.broker.broadcast({ type: "stats.updated", projectId: project.id, timestamp: Date.now() })

		await new Promise((r) => setTimeout(r, 50))

		const evt = received.find((e) => e.type === "stats.updated")
		expect(evt).toBeDefined()
		expect(evt.projectId).toBe(project.id)

		ws.close()
	})
```

**Step 2: Run the test to verify it fails**

Run: `bun test src/ws.test.ts`
Expected: FAIL — `handle.broker` is `undefined` (not exposed), and TypeScript errors on the `stats.updated` variant.

**Step 3: Write the minimal implementation**

Add the event to `WSMessage` in `src/ws.ts` (after line 16):

```typescript
  | { type: "stats.updated"; projectId: string; timestamp: number }
```

Expose the broker in `src/api.ts`. Update `ServerHandle` (line 17):

```typescript
export interface ServerHandle {
	server: Server<unknown>
	port: number
	broker: WsBroker
	stop(): void
}
```

Return it from `startServer` (line 787):

```typescript
	return {
		server: bunServer,
		port: bunServer.port ?? 0,
		broker,
		stop(): void {
			broker.closeAll()
			bunServer.stop()
		},
	}
```

Wire it in `src/index.ts` — add to the `Worker` config (around line 71, next to the other fields):

```typescript
		onPreemption: (p) => {
			server.broker.broadcast({ type: "stats.updated", projectId: p.projectId, timestamp: Date.now() })
		},
```

**Step 4: Run the tests to verify they pass**

Run: `bun run check`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/ws.ts src/api.ts src/index.ts src/ws.test.ts
git commit -m "feat(ws): stats.updated event + expose broker so worker preemptions push live"
```

---

## Task 8: UI — rebuild the board (dense cards + dashboard panel + live tick)

**Files:**
- Modify: `public/index.html` — replace card rendering and add the dashboard panel, matching the locked playground look. **Extract pure render helpers** into a small inline testable module pattern (see below) so acceptance can be checked without a browser.
- Create: `public/render.js` — pure, dependency-free render helpers (`fmtDur`, `fmtTok`, `cardStatus`, `renderSpark`, `cardBadges`) exported as ES-module functions, imported by `index.html` via `<script type="module">` AND importable by a bun test.
- Test: `src/render.test.ts` — unit-test the pure helpers (this is how the UI is made testable without a DOM).
- Test (smoke): `src/api.test.ts` — add one test that `GET /` serves the board HTML and that it references the stats endpoint path, proving the page loads and is wired.

**Acceptance Criteria:**
- [ ] `public/render.js` exports pure functions with no DOM/`window` access: `fmtDur(ms: number | null): string`, `fmtTok(n: number): string`, `cardStatus(card): "running" | "done" | "blocked" | "idle"`, `renderSpark(data: number[], hue: number): string` (returns an HTML string of `.spark .b` bars), `cardBadges(card, nowMs): string` (returns the badges HTML string), and `fmtTimestamp(iso: string | number | Date): string` (a compact local timestamp for card notes, e.g. `"14:35:07"` for today or `"Aug 21 14:35"` for another day).
- [ ] `fmtTimestamp` is deterministic given a fixed input and never throws on a valid ISO string / epoch ms / Date; an invalid/empty input returns `""`.
- [ ] `cardStatus` returns `"running"` when `claimState === "claimed"`, `"done"` when `currentStage` lowercased-trimmed is `"done"`, `"blocked"` when `retryCount >= 3`, else `"idle"` (checked in that priority order).
- [ ] `fmtDur`: `null → "—"`, `5000 → "5s"`, `65000 → "1m 5s"`, `3_700_000 → "1h 1m"`.
- [ ] `fmtTok`: `0 → "0"`, `950 → "950"`, `1500 → "1.5k"`, `120000 → "120k"`.
- [ ] `renderSpark([0,1,2], 345)` returns a string containing three `<div class="b"` bars and an `hsl(345` color.
- [ ] `cardBadges` includes a `needs ` badge when `dependsOn` is set and an `unblocks` badge when `reverseDeps` is non-empty; includes a token badge when `perCardTokens > 0`; a retry badge `n/3` when `retryCount > 0`; a preemption badge when `perCardPreemptions > 0`; a live elapsed badge (using `nowMs - inFlightAttemptStartedAt`) only when status is `running` and `inFlightAttemptStartedAt` is set.
- [ ] `index.html` renders: a status dot per card (pulsing on running via the playground's `@keyframes pulse`), density matching the locked look (padding 7, radius 5, corner, outline badges, accent `hsl(345 ...)`, navy base `#1a1a2e`/`#16213e`/`#0f3460`), and a **collapsible dashboard panel** with an interrupt counter + `renderSpark` graph + in-flight + cards-done + total-tokens, fed by `GET /api/projects/:id/stats`.
- [ ] **Card notes are TIMESTAMPED:** in the card-detail modal, each thread/note entry (`data.threads[]`, which already carries `createdAt` from the API) renders its timestamp via `fmtTimestamp(entry.createdAt)` alongside the note text (a small muted timestamp per `.thread-entry`, e.g. right-aligned or as a prefix). The data already exists — the current `index.html` thread loop (around lines 172-183) drops it; this adds it. Entries render in chronological order (oldest first), matching `getCardThreads` ordering.
- [ ] The panel refreshes when a `stats.updated` WS event for the current project arrives; the card elapsed timers tick every second via a single `setInterval`.
- [ ] The smoke test confirms `GET /` returns HTML (status 200, `content-type` includes `text/html`) whose body references `/stats` (proving the panel is wired) — no browser needed.
- [ ] No framework or build step is added; `public/` stays static files served by the existing `serveStatic`.
- [ ] `bun run check` is green.
- [ ] No files outside the list above are changed.

**Assumptions (task-specific):** `serveStatic` (referenced in `src/api.ts:4` and `:774`) already serves `public/` and resolves `/` to `index.html` and other files by path; `public/render.js` will be served as a static asset and imported by the page via `<script type="module" src="/render.js">`. Keeping the helpers in a separate `.js` ES module is what makes them importable by `bun test` — that is the mechanism for making the vanilla UI testable without a DOM.

**Step 1: Write the failing tests**

Create `src/render.test.ts`:

```typescript
import { describe, it, expect } from "bun:test"
import { fmtDur, fmtTok, cardStatus, renderSpark, cardBadges, fmtTimestamp } from "../public/render.js"

describe("render helpers — fmtDur", () => {
	it("formats null / seconds / minutes / hours", () => {
		expect(fmtDur(null)).toBe("—")
		expect(fmtDur(5000)).toBe("5s")
		expect(fmtDur(65000)).toBe("1m 5s")
		expect(fmtDur(3_700_000)).toBe("1h 1m")
	})
})

describe("render helpers — fmtTok", () => {
	it("formats plain / thousands", () => {
		expect(fmtTok(0)).toBe("0")
		expect(fmtTok(950)).toBe("950")
		expect(fmtTok(1500)).toBe("1.5k")
		expect(fmtTok(120000)).toBe("120k")
	})
})

describe("render helpers — cardStatus", () => {
	it("derives status by priority", () => {
		expect(cardStatus({ claimState: "claimed", currentStage: "Impl", retryCount: 0 })).toBe("running")
		expect(cardStatus({ claimState: null, currentStage: "Done", retryCount: 0 })).toBe("done")
		expect(cardStatus({ claimState: null, currentStage: "Impl", retryCount: 3 })).toBe("blocked")
		expect(cardStatus({ claimState: null, currentStage: "Impl", retryCount: 0 })).toBe("idle")
	})
})

describe("render helpers — renderSpark", () => {
	it("renders one bar per datum with the hue color", () => {
		const html = renderSpark([0, 1, 2], 345)
		expect((html.match(/class="b"/g) || []).length).toBe(3)
		expect(html).toContain("hsl(345")
	})
})

describe("render helpers — fmtTimestamp (timestamped card notes)", () => {
	it("returns a compact time for a valid ISO string and empty for invalid input", () => {
		const iso = "2026-08-21T14:35:07.000Z"
		const out = fmtTimestamp(iso)
		expect(typeof out).toBe("string")
		expect(out.length).toBeGreaterThan(0)
		// Deterministic: same input -> same output.
		expect(fmtTimestamp(iso)).toBe(out)
		// Accepts epoch ms and Date too, never throwing.
		expect(fmtTimestamp(Date.parse(iso))).toBe(out)
		expect(fmtTimestamp(new Date(iso))).toBe(out)
		// Invalid / empty input -> "".
		expect(fmtTimestamp("")).toBe("")
		expect(fmtTimestamp("not-a-date")).toBe("")
	})
})

describe("render helpers — cardBadges", () => {
	it("includes needs / unblocks / token / retry / preempt / elapsed as applicable", () => {
		const now = 1_000_000
		const html = cardBadges({
			claimState: "claimed",
			currentStage: "Impl",
			retryCount: 2,
			dependsOn: "card-a",
			reverseDeps: ["card-b"],
			perCardTokens: 1500,
			perCardPreemptions: 3,
			inFlightAttemptStartedAt: new Date(now - 5000).toISOString(),
		}, now)
		expect(html).toContain("needs ")
		expect(html).toContain("unblocks")
		expect(html).toContain("1.5k")
		expect(html).toContain("2/3")
		expect(html).toContain("3")
		expect(html).toContain("5s")
	})

	it("omits the elapsed badge when not running", () => {
		const now = 1_000_000
		const html = cardBadges({
			claimState: null,
			currentStage: "Impl",
			retryCount: 0,
			dependsOn: null,
			reverseDeps: [],
			perCardTokens: 0,
			perCardPreemptions: 0,
			inFlightAttemptStartedAt: null,
		}, now)
		expect(html).not.toContain("⏱")
	})
})
```

Add the smoke test to `src/api.test.ts` (top-level `describe("REST API", ...)`):

```typescript
	describe("Board page", () => {
		it("serves index.html referencing the stats endpoint", async () => {
			const res = await fetch(`${baseUrl}/`)
			expect(res.status).toBe(200)
			expect(res.headers.get("content-type") ?? "").toContain("text/html")
			const html = await res.text()
			expect(html).toContain("/stats")
		})
	})
```

**Step 2: Run the tests to verify they fail**

Run: `bun test src/render.test.ts src/api.test.ts`
Expected: FAIL — `../public/render.js` does not exist (import error); the board-page smoke test fails because the current `index.html` does not reference `/stats`.

**Step 3: Write the minimal implementation**

Create `public/render.js` (pure ES module, no DOM):

```javascript
// Pure, framework-free render helpers for the clockwork board. No DOM/window
// access, so they are unit-testable under bun test and importable by index.html.

export function fmtDur(ms) {
	if (ms == null) {
		return "—"
	}
	const s = Math.floor(ms / 1000)
	if (s < 60) {
		return s + "s"
	}
	const m = Math.floor(s / 60)
	if (m < 60) {
		return m + "m " + (s % 60) + "s"
	}
	return Math.floor(m / 60) + "h " + (m % 60) + "m"
}

export function fmtTok(n) {
	if (!n) {
		return "0"
	}
	if (n >= 1000) {
		return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "k"
	}
	return "" + n
}

export function cardStatus(card) {
	if (card.claimState === "claimed") {
		return "running"
	}
	if ((card.currentStage || "").toLowerCase().trim() === "done") {
		return "done"
	}
	if (card.retryCount >= 3) {
		return "blocked"
	}
	return "idle"
}

function hsl(h, s, l) {
	return "hsl(" + h + " " + s + "% " + l + "%)"
}

export function renderSpark(data, hue) {
	const max = Math.max(...data, 1)
	const bars = data.map((v) => {
		const height = Math.max(2, (v / max) * 30)
		return '<div class="b" style="height:' + height + "px;background:" + hsl(hue, 70, 60) + '"></div>'
	}).join("")
	return '<div class="spark">' + bars + "</div>"
}

function badge(cls, txt) {
	return '<span class="badge ' + cls + '">' + txt + "</span>"
}

export function cardBadges(card, nowMs) {
	const status = cardStatus(card)
	const badges = []
	if (card.currentStage) {
		badges.push(badge("stage", card.currentStage))
	}
	if (status === "running" && card.inFlightAttemptStartedAt) {
		const started = new Date(card.inFlightAttemptStartedAt).getTime()
		badges.push(badge("time", "⏱ " + fmtDur(nowMs - started)))
	}
	if (card.perCardTokens > 0) {
		badges.push(badge("tok", "◈ " + fmtTok(card.perCardTokens) + " tok"))
	}
	if (card.retryCount > 0) {
		badges.push(badge("retry", "↻ " + card.retryCount + "/3"))
	}
	if (card.perCardPreemptions > 0) {
		badges.push(badge("preempt", "⚡ " + card.perCardPreemptions))
	}
	if (card.dependsOn) {
		badges.push(badge("dep", "⛓ needs " + String(card.dependsOn).slice(0, 8)))
	}
	if (card.reverseDeps && card.reverseDeps.length > 0) {
		badges.push(badge("dep", "↳ unblocks " + card.reverseDeps.length))
	}
	return badges.join("")
}
```

Rewrite `public/index.html`. Keep it a single vanilla file that imports `render.js`. Below is the full replacement (locked look: navy base, hue 345, padding 7 / radius 5, outline badges, pulsing running dot, collapsible dashboard panel, live tick, `/stats` + `stats.updated` wiring):

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Clockwork Board</title>
<style>
:root{--bg:#1a1a2e;--col:#16213e;--line:#0f3460;--card:#0f3460;--card-hover:#1a4a7a;--accent2:#533483;--ink:#e8ecf5;--muted:#8a93a8;--good:#3fb950;--bad:#e94560;--cyan:#39c5cf;--warn:#d9a521;--accent:hsl(345 70% 60%)}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--ink)}
header{padding:12px 18px;background:var(--col);display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--line)}
header h1{font-size:16px;color:var(--accent)}
header select{padding:6px 10px;background:var(--line);color:var(--ink);border:1px solid var(--accent2);border-radius:4px;font-size:13px}
#status{margin-left:auto;font-size:11px;padding:4px 10px;border-radius:10px}
#status.connected{background:#123020;color:#a5d6a7}
#status.disconnected{background:#3a1418;color:#ef9a9a}
/* dashboard panel */
#panel{background:#141a30;border-bottom:1px solid #232b45}
#panel .panel-head{display:flex;align-items:center;gap:10px;padding:8px 18px;cursor:pointer;user-select:none;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
#panel .panel-body{display:flex;gap:16px;align-items:stretch;padding:0 18px 12px;flex-wrap:wrap}
#panel.collapsed .panel-body{display:none}
.stat{display:flex;flex-direction:column;gap:2px;min-width:78px}
.stat .k{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.stat .v{font-size:19px;font-weight:700}
.stat .v.bad{color:var(--bad)} .stat .v.good{color:var(--good)} .stat .v.cyan{color:var(--cyan)}
.graphwrap{flex:1;min-width:220px;display:flex;flex-direction:column;gap:3px}
.graphwrap .glabel{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.spark{display:flex;align-items:flex-end;gap:2px;height:34px;padding-top:4px}
.spark .b{width:6px;border-radius:1px;opacity:.85}
/* board */
#board{display:flex;gap:12px;padding:16px 18px;overflow-x:auto;min-height:calc(100vh - 120px)}
.column{min-width:270px;max-width:300px;background:var(--col);border-radius:8px;padding:10px;flex-shrink:0}
.column h2{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--accent);margin:0 0 8px;padding-bottom:7px;border-bottom:2px solid var(--line);display:flex;justify-content:space-between}
.column h2 .cnt{font-size:11px;color:var(--muted);font-weight:400}
.card{background:var(--card);border-radius:5px;padding:7px;margin-bottom:8px;cursor:pointer;border-left:3px solid var(--accent2);position:relative;transition:background .15s,transform .1s}
.card:hover{background:var(--card-hover);transform:translateY(-1px)}
.card.running{border-left-color:var(--good)}
.card.blocked{border-left-color:var(--bad)}
.card.done{border-left-color:var(--good);opacity:.72}
.card .title{font-weight:600;font-size:13px;line-height:1.3}
.card .status-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:middle}
.dot-run{background:var(--good);animation:pulse 1.6s infinite}
.dot-idle{background:var(--muted)} .dot-block{background:var(--bad)} .dot-done{background:var(--good)}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(63,185,80,.5)}70%{box-shadow:0 0 0 6px rgba(63,185,80,0)}100%{box-shadow:0 0 0 0 rgba(63,185,80,0)}}
.badges{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}
.badge{font-size:10px;padding:2px 6px;border-radius:10px;background:#0b1020;border:1px solid #2a3350;color:var(--muted);display:inline-flex;align-items:center;gap:4px}
.badge.time{color:var(--cyan);border-color:#204152}
.badge.tok{color:#c9a3ff;border-color:#3a2a55}
.badge.retry{color:var(--warn);border-color:#4a3a12}
.badge.preempt{color:var(--bad);border-color:#4a1f22}
.badge.dep{color:#7fb0ff;border-color:#243a5a}
.badge.stage{color:var(--ink);border-color:#2a3350}
.empty{color:#555;font-style:italic;font-size:12px;text-align:center;padding:12px}
</style>
</head>
<body>
<header>
  <h1>Clockwork</h1>
  <select id="project-select"><option value="">— select project —</option></select>
  <span id="status" class="disconnected">disconnected</span>
</header>
<div id="panel" class="collapsed">
  <div class="panel-head" id="panel-head">▸ dashboard</div>
  <div class="panel-body">
    <div class="stat"><span class="k">Interrupts</span><span class="v bad" id="s-preempt">0</span></div>
    <div class="stat"><span class="k">In-flight</span><span class="v good" id="s-inflight">0</span></div>
    <div class="stat"><span class="k">Cards done</span><span class="v" id="s-done">0</span></div>
    <div class="stat"><span class="k">Tokens</span><span class="v cyan" id="s-tokens">0</span></div>
    <div class="graphwrap"><div class="glabel">arbiter interrupts · 5-min buckets, last 2h</div><div id="s-spark"></div></div>
  </div>
</div>
<div id="board"></div>
<script type="module">
import { fmtTok, cardStatus, renderSpark, cardBadges } from "/render.js";
const HUE = 345;
const board = document.getElementById("board");
const projectSelect = document.getElementById("project-select");
const statusEl = document.getElementById("status");
const panel = document.getElementById("panel");
document.getElementById("panel-head").addEventListener("click", () => {
  panel.classList.toggle("collapsed");
  document.getElementById("panel-head").textContent = (panel.classList.contains("collapsed") ? "▸" : "▾") + " dashboard";
});
let currentProject = null, columns = [], cardsByColumn = {}, ws = null, cards = [];

function loadProjects() {
  fetch("/api/projects").then(r => r.json()).then(projects => {
    projectSelect.innerHTML = '<option value="">— select project —</option>';
    for (const p of projects) {
      const opt = document.createElement("option");
      opt.value = p.id; opt.textContent = p.name; projectSelect.appendChild(opt);
    }
    if (currentProject) { projectSelect.value = currentProject; loadBoard(currentProject); }
  });
}

function loadBoard(projectId) {
  currentProject = projectId;
  Promise.all([
    fetch("/api/projects/" + projectId + "/columns").then(r => r.json()),
    fetch("/api/projects/" + projectId + "/cards").then(r => r.json()),
  ]).then(([cols, cs]) => {
    columns = cols.sort((a, b) => a.position - b.position);
    cards = cs;
    cardsByColumn = {};
    for (const col of columns) cardsByColumn[col.id] = [];
    for (const card of cards) if (cardsByColumn[card.columnId]) cardsByColumn[card.columnId].push(card);
    renderBoard();
    loadStats();
    connectWs();
  });
}

function loadStats() {
  if (!currentProject) return;
  fetch("/api/projects/" + currentProject + "/stats").then(r => r.json()).then(s => {
    document.getElementById("s-preempt").textContent = s.preemptionsTotal;
    document.getElementById("s-inflight").textContent = s.inFlight;
    document.getElementById("s-done").textContent = s.cardsDone;
    document.getElementById("s-tokens").textContent = fmtTok(s.totalTokens);
    document.getElementById("s-spark").innerHTML = renderSpark(s.preemptionSeries, HUE);
  });
}

function renderBoard() {
  const now = Date.now();
  board.innerHTML = "";
  if (columns.length === 0) { board.innerHTML = '<div class="empty">No columns yet.</div>'; return; }
  for (const col of columns) {
    const colEl = document.createElement("div");
    colEl.className = "column";
    const colCards = cardsByColumn[col.id] || [];
    colEl.innerHTML = '<h2>' + escHtml(col.name) + '<span class="cnt">' + colCards.length + '</span></h2>';
    if (colCards.length === 0) colEl.innerHTML += '<div class="empty">—</div>';
    for (const card of colCards) {
      const status = cardStatus(card);
      const dotCls = status === "running" ? "dot-run" : status === "blocked" ? "dot-block" : status === "done" ? "dot-done" : "dot-idle";
      const cardEl = document.createElement("div");
      cardEl.className = "card " + status;
      cardEl.innerHTML =
        '<div class="title"><span class="status-dot ' + dotCls + '"></span>' + escHtml(card.title) + '</div>' +
        '<div class="badges">' + cardBadges(card, now) + '</div>';
      board.appendChild(colEl);
      colEl.appendChild(cardEl);
    }
    board.appendChild(colEl);
  }
}

function connectWs() {
  if (ws) ws.close();
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(proto + "//" + location.host + "/ws");
  ws.onopen = () => {
    statusEl.textContent = "connected"; statusEl.className = "connected";
    if (currentProject) ws.send(JSON.stringify({ type: "subscribe", projectId: currentProject }));
  };
  ws.onclose = () => { statusEl.textContent = "disconnected"; statusEl.className = "disconnected"; };
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.projectId !== currentProject) return;
      if (msg.type === "stats.updated") { loadStats(); return; }
      if (["card.moved","card.created","card.deleted","card.updated","card.claimed","card.unclaimed","column.created","column.deleted","column.updated","attempt.recorded"].includes(msg.type)) {
        loadBoard(currentProject);
      }
    } catch {}
  };
}

projectSelect.addEventListener("change", () => { if (projectSelect.value) loadBoard(projectSelect.value); });
function escHtml(s){const d=document.createElement("div");d.textContent=s;return d.innerHTML;}
// Live tick: re-render the board every second so running cards' elapsed timers advance.
setInterval(() => { if (currentProject && columns.length) renderBoard(); }, 1000);
loadProjects();
</script>
</body>
</html>
```

**Step 4: Run the tests to verify they pass**

Run: `bun run check`
Expected: PASS — `src/render.test.ts` green, the board-page smoke test green (body references `/stats`), typecheck clean.

**Step 5: Manual visual check (not a gate, but do it)**

Run: `CLOCKWORK_DB_PATH=/tmp/clockwork-visual.sqlite bun run src/index.ts` (seed a project/columns/cards via the API, or point at a scratch DB), open the served page, and confirm: dense cards, pulsing running dot, live-ticking elapsed badge, token/retry/preemption/dependency badges, and the collapsible dashboard panel with the sparkline. Compare against `docs/plans/clockwork-observability-playground.html`.

**Step 6: Commit**

```bash
git add public/index.html public/render.js src/render.test.ts src/api.test.ts
git commit -m "feat(ui): rebuild board to locked look — dense cards, dashboard panel, live tick"
```

---

## Definition of done (whole feature)

- [ ] Task 0 finding written; the token branch (A or B) is chosen and recorded, and Task 4's implementation matches it.
- [ ] `preemptions` table exists; `recordPreemption` + `getPreemptionStats` (total, 24-bucket series, per-card) are implemented and tested.
- [ ] `attempts` has nullable `tokens` + `tokens_estimated` (additive migration); threaded through `createAttempt` / `parseAttemptRow`; tested.
- [ ] The worker writes exactly one `preemptions` row per detected preemption (existing preemption semantics unchanged: no retry consumed) and fires `onPreemption`.
- [ ] The worker records per-attempt tokens (estimate by default, real if Task 0 said so).
- [ ] `GET /api/projects/:id/stats` returns the documented shape; tested.
- [ ] `GET /api/projects/:id/cards` returns enriched cards (stage, in-flight startedAt, dependsOn, reverseDeps, retry, per-card preemptions, per-card tokens); tested; existing card tests still pass.
- [ ] `stats.updated` WS event exists, the broker is exposed on `ServerHandle`, and `index.ts` wires the worker's `onPreemption` to broadcast it; tested.
- [ ] `public/index.html` is rebuilt to the locked look (dense cards, pulsing running dot, live elapsed, token/retry/preemption/dependency badges, collapsible dashboard panel with counter + sparkline), still a single vanilla file + `render.js`, no framework/build.
- [ ] `public/render.js` pure helpers are unit-tested (`src/render.test.ts`); the board page smoke test confirms it loads and references `/stats`.
- [ ] **Card notes are timestamped:** the card-detail modal renders each thread/note entry's `createdAt` via `fmtTimestamp` (data already present in the API); `fmtTimestamp` is unit-tested.
- [ ] **All migrations are additive** — the live `studio` DB survives a redeploy (verified by the fact that only `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN`-in-try/catch were used).
- [ ] `bun run check` is green on the final commit (every task ends with it green).
- [ ] No new runtime dependency, no framework, no build step introduced anywhere.

---

## Execution handoff

Plan complete and saved to `docs/plans/2026-08-21-observability-implementation-plan.md`. Three execution options:

**1. Subagent-Driven (this session)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
- REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**2. Parallel Subagent-Driven (this session)** — I dispatch multiple subagents concurrently for independent tasks. Note the dependency chain here is mostly linear (1→2→3/4→5/6→7→8), so the safe parallelisable set is small: Tasks 1 and 2 are independent of each other; Task 0 is independent of all code tasks. Everything after Task 2 should be sequential.
- REQUIRED SUB-SKILL: Use superpowers:dispatching-parallel-agents.

**3. Parallel Session (separate)** — Open a new session in a worktree and batch-execute with checkpoints.
- REQUIRED SUB-SKILL: New session uses superpowers:executing-plans.

Which approach?
