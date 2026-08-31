# Clockwork Hands-Off Hardening Implementation Plan

> **For OpenCode:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close every manual-intervention smell catalogued in the approved design so the manager can run clockwork hands-off — blocks either self-heal in the machinery or route to the director as a one-click decision, never a hand-fix.

**Architecture:** Four dependency-ordered sections. Section 4 groundwork first (bare/`updateInstead` origin + stale-branch prune — these unblock merge correctness). Then Section 2 (deterministic deliverable gate: a `targets` field + a `git diff --name-only` check that fails docs-only diffs). Then Section 3 (park-reason classification + a `card.parked` websocket event + first-class director-action API endpoints that replace database pokes and ad-hoc scripts, plus a "load a plan as a dependency-ordered card chain" command). Then Section 1 (per-card verification contracts: the game-repo visual-QA skill selects a per-card scenario when present, else the shared baseline). Each change removes a specifically-named manual intervention from the design's table.

**Tech Stack:** Bun + TypeScript (ES modules), `bun:sqlite` (WAL, additive migrations only), websockets via `Bun.serve`, pi workers on frame-arbiter LOW ports, Python 3 standard library only for the visual-QA skill (`verdict.py`).

**Assumptions:**
- **bare-vs-`updateInstead` decision → CHOSEN: bare origin.** The production origin at `~/.clockwork-data/repos/<project>` (the value of `CLOCKWORK_REPOS`) must be able to receive a push to its checked-out default branch. A non-bare repo rejects that by default (`receive.denyCurrentBranch`). Two fixes exist: (a) make the origin **bare** (`git clone --bare` / `git init --bare`), or (b) run `git config receive.denyCurrentBranch updateInstead` on a non-bare origin. **We choose bare** because: the existing `src/repo.test.ts` already seeds a **bare** remote and asserts `mergeCardToMain`'s push succeeds against it (repo.test.ts:33 `git init --bare`, repo.test.ts:216 asserts the remote `main` gets the file) — so the production path already works against a bare origin and is proven by the current suite. A bare origin has no working tree to desync, needs no per-repo config flag, and is the conventional "origin" shape. The remaining gap is purely operational: nothing in setup/docs guarantees the studio origin is bare. This plan closes that with a setup task (Task 2) + documentation, so **no hand `git config` on studio is ever needed**. `updateInstead` is documented as the fallback for an existing non-bare origin that cannot be recloned.
- **targets-field-vs-parse decision → CHOSEN: a nullable `targets` column, populated from the card body at create time (parse-on-write), with an explicit API/`depends_on`-style field override.** Rationale: the deterministic gate needs a machine-readable list of target paths. Parsing the body at gate time every run is fragile (body text drifts, the reviewer edits it) and couples the gate to prose. A dedicated `targets` column is DRY (parsed once), inspectable, and directly settable by a director action (`reScopeCard`) — which the design requires ("re-scope card · targets"). We keep the existing body convention working by parsing `Only <files>` / `targets: <files>` out of the body into the column **when the card is created and when a director edits it**, so authors need not learn a new field, but the stored `targets` is the single source of truth the gate reads. Additive migration (`ALTER TABLE cards ADD COLUMN targets TEXT`, JSON-encoded list, in try/catch — same pattern as `depends_on` at db.ts:191).
- The live studio DB must survive redeploy: every schema change is additive only (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN` in try/catch).
- House rules hold on every task: `bun run check` (tsc --noEmit + bun test) is the gate before every commit; strictly test-first; TypeScript ES modules, `function` declarations top-level, explicit return types on exports, no nested ternaries, tabs; machinery stays DUMB (intelligence in prompts/plans/verifiers); single worker.
- The visual-QA skill lives in the game repo (`code/projects/prism-drift/tools/visual-qa-skill/`), not clockwork. Its selection logic is skill tooling (fair to edit); the baseline relaxation and per-card scenarios are authored through the director/card-planning path, never a runtime hand-edit.
- `CLOCKWORK_CARD_ID` is already passed to pi as an env var by the worker (worker.ts:516). The visual-QA skill can read it to resolve a per-card scenario.

---

## Section 4 — Hands-off operability groundwork (do first: unblocks merge correctness)

### Task 1: Stale `card/*` branch prune on `prepareCardWorkspace`

**Files:**
- Modify: `src/repo.ts:47-84` (inside `prepareCardWorkspace`, after the clone/pull block, before the branch checkout)
- Test: `src/repo.test.ts` (new `it` in the `prepareCardWorkspace` describe block, after repo.test.ts:189)

**Why (design):** removes the "`rm -rf` wedged / stale workspaces" hand-touch (design §4, table row 5). Leftover `card/*` branches from earlier cards accumulate in the long-lived clone and can be mis-verified or pollute the working set.

**Acceptance Criteria:**
- [ ] A private method `pruneStaleCardBranches(repoPath: string, keepBranch: string): Promise<void>` exists on `RepoWorkspace` with that exact signature.
- [ ] It deletes every local branch matching `card/*` EXCEPT `keepBranch` and the current checked-out branch.
- [ ] It is called inside `prepareCardWorkspace` after the repo is cloned/pulled and after `git config user.*`, but the delete of the branch being prepared never happens (the branch under prep is `keepBranch`).
- [ ] Deleting branches is best-effort: a failure to delete one stale branch does not throw out of `prepareCardWorkspace`.
- [ ] Test: pre-seed a stale `card/old` branch, prepare `card/new`, assert `card/old` is gone and `card/new` exists.
- [ ] `bun run check` is green.
- [ ] No changes to files outside the list above.

**Step 1: Write the failing test**

Add to `src/repo.test.ts` inside `describe("prepareCardWorkspace", ...)`:

```typescript
it("prunes stale card/* branches on prepare, keeping the current card's branch", async () => {
	const { remotePath } = seedRemote(projectRoot)
	const ws = new RepoWorkspace(
		{ projectRoot, gitToken: "fake-token", defaultBranch: "main" },
		store,
	)

	// Stage a stale branch from an earlier card.
	await ws.prepareCardWorkspace("proj-1", "old", `file://${remotePath}`)
	const repoPath = `${projectRoot}/proj-1`
	// Move off card/old so it is deletable, then prepare a new card.
	await ws.prepareCardWorkspace("proj-1", "new", `file://${remotePath}`)

	const branches = Bun.spawnSync(["git", "-C", repoPath, "branch"], {})
	const text = new TextDecoder().decode(branches.stdout!)
	expect(text).toContain("card/new")
	expect(text).not.toContain("card/old")
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/repo.test.ts -t "prunes stale"`
Expected: FAIL — `card/old` is still present.

**Step 3: Write minimal implementation**

In `src/repo.ts`, add the method and call it. Add after `branchExists` (repo.test.ts helpers pattern):

```typescript
	private async pruneStaleCardBranches(repoPath: string, keepBranch: string): Promise<void> {
		const proc = Bun.spawn(
			["git", "-C", repoPath, "for-each-ref", "--format=%(refname:short)", "refs/heads/card/"],
			{ stdout: "pipe", stderr: "pipe" },
		)
		const out = proc.stdout ? await new Response(proc.stdout).text() : ""
		await proc.exited
		const current = await this.currentBranch(repoPath)
		const branches = out.split("\n").map((b) => b.trim()).filter((b) => b !== "")
		for (const branch of branches) {
			if (branch === keepBranch || branch === current) {
				continue
			}
			try {
				await this.run(["-C", repoPath, "branch", "-D", branch])
			} catch {
				// Best-effort: a stale branch we cannot delete must not wedge prepare.
			}
		}
	}

	private async currentBranch(repoPath: string): Promise<string> {
		const proc = Bun.spawn(
			["git", "-C", repoPath, "branch", "--show-current"],
			{ stdout: "pipe", stderr: "pipe" },
		)
		const out = proc.stdout ? await new Response(proc.stdout).text() : ""
		await proc.exited
		return out.trim()
	}
```

Then in `prepareCardWorkspace`, immediately before the `const branch = \`card/${cardId}\`` block at repo.test.ts:65, insert:

```typescript
			// Prune leftover card/* branches from earlier cards so they cannot be
			// mis-verified or accumulate. The branch we are about to prepare is kept.
			await this.pruneStaleCardBranches(repoPath, `card/${cardId}`)
```

**Step 4: Run test to verify it passes**

Run: `bun test src/repo.test.ts -t "prunes stale"`
Expected: PASS

**Step 5: Verify the gate and commit**

Run: `bun run check`
Expected: tsc clean + all tests pass.

```bash
git add src/repo.ts src/repo.test.ts
git commit -m "feat: prune stale card/* branches on workspace prepare"
```

---

### Task 2: Bare-origin setup + documentation (reproducible, no hand git config)

**Files:**
- Create: `scripts/ensure-bare-origin.ts`
- Modify: `docs/impl-ref.md` (append a short "Repo origin must be bare" subsection under the repo section)
- Test: `scripts/ensure-bare-origin.test.ts`

**Why (design):** removes "`git config … updateInstead` on studio" (design §4, table row 3) by making the origin bare through a checked-in setup command, reproducibly, so a redeploy or new host reproduces it (design §4 acceptance: "The pipeline repo is bare/`updateInstead` via setup, not a hand `git config`.").

**Acceptance Criteria:**
- [ ] `scripts/ensure-bare-origin.ts` exports `function ensureBareOrigin(originPath: string): Promise<{ ok: boolean; action: "already-bare" | "converted" | "created" }>`.
- [ ] If `originPath` does not exist, it runs `git init --bare originPath` and returns `{ ok: true, action: "created" }`.
- [ ] If `originPath` exists and is already bare (`git rev-parse --is-bare-repository` prints `true`), it returns `{ ok: true, action: "already-bare" }` and makes no change.
- [ ] If `originPath` exists and is a non-bare repo, it runs `git config receive.denyCurrentBranch updateInstead` on it and returns `{ ok: true, action: "converted" }` (the documented fallback — never a hand config).
- [ ] `docs/impl-ref.md` documents that the origin is bare, why the merge-push needs it, and the `updateInstead` fallback.
- [ ] `bun run check` is green.
- [ ] No changes to files outside the list above.

**Step 1: Write the failing test**

Create `scripts/ensure-bare-origin.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { ensureBareOrigin } from "./ensure-bare-origin.ts"
import fs from "node:fs"

function makeTempDir(): string {
	return fs.mkdtempSync("/tmp/clockwork-bare-test-")
}

describe("ensureBareOrigin", () => {
	let root: string

	beforeEach(() => {
		root = makeTempDir()
	})

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true })
	})

	it("creates a bare repo when the origin does not exist", async () => {
		const origin = `${root}/origin.git`
		const result = await ensureBareOrigin(origin)
		expect(result.ok).toBe(true)
		expect(result.action).toBe("created")
		const check = Bun.spawnSync(["git", "-C", origin, "rev-parse", "--is-bare-repository"], {})
		expect(new TextDecoder().decode(check.stdout!).trim()).toBe("true")
	})

	it("is a no-op when the origin is already bare", async () => {
		const origin = `${root}/origin.git`
		await ensureBareOrigin(origin)
		const result = await ensureBareOrigin(origin)
		expect(result.action).toBe("already-bare")
	})

	it("converts a non-bare origin via updateInstead", async () => {
		const origin = `${root}/nonbare`
		fs.mkdirSync(origin)
		Bun.spawnSync(["git", "-C", origin, "init"], {})
		const result = await ensureBareOrigin(origin)
		expect(result.action).toBe("converted")
		const check = Bun.spawnSync(["git", "-C", origin, "config", "receive.denyCurrentBranch"], {})
		expect(new TextDecoder().decode(check.stdout!).trim()).toBe("updateInstead")
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test scripts/ensure-bare-origin.test.ts`
Expected: FAIL — module `./ensure-bare-origin.ts` not found.

**Step 3: Write minimal implementation**

Create `scripts/ensure-bare-origin.ts`:

```typescript
import fs from "node:fs"

export interface EnsureBareOriginResult {
	ok: boolean
	action: "already-bare" | "converted" | "created"
}

async function run(args: string[]): Promise<{ code: number; stdout: string }> {
	const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" })
	const stdout = proc.stdout ? await new Response(proc.stdout).text() : ""
	const code = await proc.exited
	return { code, stdout: stdout.trim() }
}

export async function ensureBareOrigin(originPath: string): Promise<EnsureBareOriginResult> {
	if (!fs.existsSync(originPath)) {
		await run(["init", "--bare", originPath])
		return { ok: true, action: "created" }
	}
	const isBare = await run(["-C", originPath, "rev-parse", "--is-bare-repository"])
	if (isBare.code === 0 && isBare.stdout === "true") {
		return { ok: true, action: "already-bare" }
	}
	// Existing non-bare origin (cannot be safely recloned in place): the documented
	// fallback lets it accept a push to its checked-out branch without a hand config.
	await run(["-C", originPath, "config", "receive.denyCurrentBranch", "updateInstead"])
	return { ok: true, action: "converted" }
}

if (import.meta.main) {
	const originPath = process.argv[2]
	if (!originPath) {
		console.log("Usage: bun scripts/ensure-bare-origin.ts <origin-path>")
		process.exit(1)
	}
	ensureBareOrigin(originPath).then((r) => {
		console.log(JSON.stringify(r))
	})
}
```

**Step 4: Run test to verify it passes**

Run: `bun test scripts/ensure-bare-origin.test.ts`
Expected: PASS (3 tests).

**Step 5: Document, verify, commit**

Append to `docs/impl-ref.md`:

```markdown
### Repo origin must be BARE (merge-push correctness)

`mergeCardToMain` pushes the merged default branch to origin so later/dependent cards
branch off the finished work. A non-bare origin rejects a push to its checked-out branch
(`receive.denyCurrentBranch`). The production origin at `$CLOCKWORK_REPOS/<project>` is
therefore **bare**, created reproducibly by `scripts/ensure-bare-origin.ts` (run at
deploy/setup) — never a hand `git config`. Fallback for an existing non-bare origin that
cannot be recloned: the same script sets `receive.denyCurrentBranch updateInstead`.
```

Run: `bun run check`
Expected: green.

```bash
git add scripts/ensure-bare-origin.ts scripts/ensure-bare-origin.test.ts docs/impl-ref.md
git commit -m "feat: reproducible bare-origin setup so merge-push needs no hand git config"
```

---

## Section 2 — Deliverable-exists gate (honest completion)

### Task 3: Add a nullable `targets` field to cards (additive migration + parse-on-write)

**Files:**
- Modify: `src/db.ts:26-42` (`DbCard` interface — add `targets`), `src/db.ts:94-101` (`CreateCardInput`), `src/db.ts:103-111` (`UpdateCardInput`), `src/db.ts:171-195` (add `ALTER TABLE` migration), `src/db.ts:404-419` (`createCard` INSERT), `src/db.ts:474-519` (`updateCard`), `src/db.ts:726-742` (`parseCardRow`)
- Create: `src/targets.ts` (pure parser)
- Test: `src/targets.test.ts`, and add cases to `src/db.test.ts`

**Why (design):** the machine-readable half of the deliverable gate (design §2). A `targets` field lets the deterministic diff check know which paths must change.

**Acceptance Criteria:**
- [ ] `src/targets.ts` exports `function parseTargets(body: string): string[]` that returns the file paths named by a line matching `targets: a, b` OR the existing convention `Only <files>` (comma/space separated), and `[]` when none.
- [ ] `DbCard` gains `targets: string[]` (empty array = no declared targets).
- [ ] `CreateCardInput` gains optional `targets?: string[]`; `createCard` stores `JSON.stringify(targets ?? [])` in a new `targets` TEXT column.
- [ ] When `createCard` is given no explicit `targets`, it derives them via `parseTargets(input.body)`.
- [ ] `UpdateCardInput` gains optional `targets?: string[]`; `updateCard` persists it.
- [ ] The `targets` column is added additively (`ALTER TABLE cards ADD COLUMN targets TEXT` in try/catch) AND in the `CREATE TABLE` for fresh databases.
- [ ] `parseCardRow` returns `targets` parsed from JSON, defaulting to `[]` when the column is null.
- [ ] `bun run check` is green.
- [ ] No changes to files outside the list above.

**Step 1: Write the failing test**

Create `src/targets.test.ts`:

```typescript
import { describe, it, expect } from "bun:test"
import { parseTargets } from "./targets.ts"

describe("parseTargets", () => {
	it("parses an explicit targets: line", () => {
		expect(parseTargets("Do the thing.\ntargets: scripts/main.gd, project.godot")).toEqual([
			"scripts/main.gd",
			"project.godot",
		])
	})

	it("parses the 'Only <files>' body convention", () => {
		expect(parseTargets("Only main.gd should change.")).toEqual(["main.gd"])
	})

	it("returns [] when nothing is declared", () => {
		expect(parseTargets("Just write a plan document.")).toEqual([])
	})
})
```

Add to `src/db.test.ts` (in the cards describe block):

```typescript
it("stores and returns targets, deriving them from the body when not explicit", () => {
	const project = store.createProject({ name: "P", description: "", githubRepo: null, branch: null })
	const column = store.createColumn({ projectId: project.id, name: "Impl", prompt: "", skills: [], model: null, position: 0 })
	const card = store.createCard({
		projectId: project.id,
		columnId: column.id,
		title: "T",
		body: "targets: scripts/main.gd",
		position: 0,
	})
	expect(card.targets).toEqual(["scripts/main.gd"])

	const updated = store.updateCard(card.id, { targets: ["a.gd", "b.gd"] })
	expect(updated.targets).toEqual(["a.gd", "b.gd"])
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/targets.test.ts src/db.test.ts -t "targets"`
Expected: FAIL — `./targets.ts` missing; `card.targets` undefined.

**Step 3: Write minimal implementation**

Create `src/targets.ts`:

```typescript
// Extract the file paths a card declares as its deliverable. Two accepted forms:
//   targets: a/b.gd, c.gd
//   Only main.gd (the existing card-body convention)
// Returns [] when the card declares nothing (a planning/doc card).
export function parseTargets(body: string): string[] {
	const explicit = body.match(/^\s*targets:\s*(.+)$/im)
	if (explicit && explicit[1]) {
		return splitPaths(explicit[1])
	}
	const only = body.match(/\bOnly\s+([^.\n]+)/i)
	if (only && only[1]) {
		return splitPaths(only[1])
	}
	return []
}

function splitPaths(raw: string): string[] {
	return raw
		.split(/[,\s]+/)
		.map((p) => p.trim())
		.filter((p) => p !== "" && p.toLowerCase() !== "should" && p.toLowerCase() !== "change")
}
```

In `src/db.ts`:
- Add to `DbCard` (after `dependsOn`, db.ts:39): `targets: string[]`
- Add to `CreateCardInput` (db.ts:100): `targets?: string[]`
- Add to `UpdateCardInput` (db.ts:110): `targets?: string[]`
- In `CREATE TABLE cards` (db.ts:183, after `depends_on TEXT`): add `targets TEXT,`
- After the `depends_on` migration (db.ts:195), add:

```typescript
		try {
			this.run("ALTER TABLE cards ADD COLUMN targets TEXT")
		} catch {
			// Column already exists — nothing to do.
		}
```

- Import the parser at the top of `db.ts`: `import { parseTargets } from "./targets.ts"`
- In `createCard` (db.ts:404), compute and store targets:

```typescript
	createCard(input: CreateCardInput): DbCard {
		const id = crypto.randomUUID()
		const targets = input.targets ?? parseTargets(input.body)
		this.run(`
			INSERT INTO cards (id, project_id, column_id, title, body, position, retry_count, depends_on, targets)
			VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
		`,
			id,
			input.projectId,
			input.columnId,
			input.title,
			input.body,
			input.position,
			input.dependsOn ?? null,
			JSON.stringify(targets),
		)
		return this.getCardById(id)!
	}
```

- In `updateCard` (db.ts:474), add a branch (before the `if (updates.length === 0)` guard):

```typescript
		if (input.targets !== undefined) {
			updates.push("targets = ?")
			params.push(JSON.stringify(input.targets))
		}
```

- In `parseCardRow` (db.ts:726), add: `targets: row.targets ? JSON.parse(row.targets) : [],`

**Step 4: Run test to verify it passes**

Run: `bun test src/targets.test.ts src/db.test.ts`
Expected: PASS.

**Step 5: Verify and commit**

Run: `bun run check`

```bash
git add src/targets.ts src/targets.test.ts src/db.ts src/db.test.ts
git commit -m "feat: add nullable targets field to cards (additive migration + body parse)"
```

---

### Task 4: `computeChangedFiles` + the deterministic deliverable gate in `repo.ts`

**Files:**
- Modify: `src/repo.ts` (add `computeChangedFiles` public method after `mergeCardToMain`, repo.ts:127)
- Test: `src/repo.test.ts` (new describe `computeChangedFiles`)

**Why (design):** the deterministic core of the gate (design §2: "compute `git diff --name-only <base>..<card-branch>` and **fail** if declared code targets are unchanged"). Deterministic — a model cannot reason around it.

**Acceptance Criteria:**
- [ ] `computeChangedFiles(repoPath: string, base: string, cardBranch: string): Promise<string[]>` exists with that exact signature and returns the list of paths from `git diff --name-only base...cardBranch`.
- [ ] A helper `function targetsSatisfied(changed: string[], targets: string[]): boolean` is exported from `src/repo.ts` (or a new `src/gate.ts` — see decision below) returning `true` when `targets` is empty (no declared targets = unaffected) OR at least one declared target path appears in `changed`.
- [ ] **Decision:** the pure `targetsSatisfied` predicate goes in a new `src/gate.ts` (pure, unit-testable without git); `computeChangedFiles` (needs git) stays in `repo.ts`. This keeps the git-touching code and the pure predicate separately testable (DRY/testability).
- [ ] A card with no targets → `targetsSatisfied` returns `true` (unaffected).
- [ ] A card whose diff is docs-only against declared code targets → `targetsSatisfied` returns `false`.
- [ ] `bun run check` is green.
- [ ] No changes to files outside the list above.

**Step 1: Write the failing test**

Create `src/gate.test.ts`:

```typescript
import { describe, it, expect } from "bun:test"
import { targetsSatisfied } from "./gate.ts"

describe("targetsSatisfied", () => {
	it("passes when no targets are declared", () => {
		expect(targetsSatisfied(["docs/plan.md"], [])).toBe(true)
	})

	it("fails when a declared code target is unchanged (docs-only diff)", () => {
		expect(targetsSatisfied(["docs/plan.md"], ["scripts/main.gd"])).toBe(false)
	})

	it("passes when a declared target is in the changed set", () => {
		expect(targetsSatisfied(["scripts/main.gd", "docs/plan.md"], ["scripts/main.gd"])).toBe(true)
	})
})
```

Add to `src/repo.test.ts` a new describe:

```typescript
describe("computeChangedFiles", () => {
	it("lists files changed on the card branch vs base", async () => {
		const { remotePath } = seedRemote(projectRoot)
		const ws = new RepoWorkspace(
			{ projectRoot, gitToken: "fake-token", defaultBranch: "main" },
			store,
		)
		const { repoPath, branch } = await ws.prepareCardWorkspace("proj-1", "card-1", `file://${remotePath}`)
		fs.writeFileSync(`${repoPath}/scripts-main.gd`, "extends Node")
		await ws.commitCardWork(repoPath, "card-1", "col-1")

		const changed = await ws.computeChangedFiles(repoPath, "origin/main", branch)
		expect(changed).toContain("scripts-main.gd")
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/gate.test.ts src/repo.test.ts -t "computeChangedFiles"`
Expected: FAIL — `./gate.ts` missing; `computeChangedFiles` undefined.

**Step 3: Write minimal implementation**

Create `src/gate.ts`:

```typescript
// Pure deliverable-gate predicate. A card with no declared targets is unaffected
// (planning/doc cards return true). Otherwise the diff must touch at least one
// declared target path, else the card claimed code but shipped none of it.
export function targetsSatisfied(changed: string[], targets: string[]): boolean {
	if (targets.length === 0) {
		return true
	}
	const changedSet = new Set(changed)
	return targets.some((t) => changedSet.has(t))
}
```

In `src/repo.ts`, after `mergeCardToMain` (repo.ts:127):

```typescript
	async computeChangedFiles(repoPath: string, base: string, cardBranch: string): Promise<string[]> {
		const proc = Bun.spawn(
			["git", "-C", repoPath, "diff", "--name-only", `${base}...${cardBranch}`],
			{ stdout: "pipe", stderr: "pipe" },
		)
		const out = proc.stdout ? await new Response(proc.stdout).text() : ""
		await proc.exited
		return out.split("\n").map((f) => f.trim()).filter((f) => f !== "")
	}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/gate.test.ts src/repo.test.ts -t "computeChangedFiles"`
Expected: PASS.

**Step 5: Verify and commit**

Run: `bun run check`

```bash
git add src/gate.ts src/gate.test.ts src/repo.ts src/repo.test.ts
git commit -m "feat: computeChangedFiles + pure targetsSatisfied deliverable predicate"
```

---

### Task 5: Wire the deliverable gate into `processCard` (fail docs-only diffs deterministically)

**Files:**
- Modify: `src/worker.ts:65-84` (`RepoWorkspaceLike` — add optional `computeChangedFiles`), `src/worker.ts:610-628` (verdict switch — gate a `pass` before `moveForward`)
- Test: `src/worker.test.ts` (new describe `deliverable gate`)

**Why (design):** turns a green check on undone work into a deterministic fail (design §2 acceptance: "A card declaring code targets whose branch diff touches only `docs/` is failed with a clear reason.").

**Acceptance Criteria:**
- [ ] `RepoWorkspaceLike` gains an optional `computeChangedFiles?(repoPath: string, base: string, cardBranch: string): Promise<string[]>`.
- [ ] In `processCard`, when the verdict is `pass`, the card has non-empty `targets`, a repo workspace is configured, and `computeChangedFiles` is available: compute the diff of `card/<id>` against `origin/<default>`; if `targetsSatisfied` is false, convert the pass into a `kickback` with feedback `"deliverable gate: declared targets <targets> were not changed (diff touched only: <changed>)"` and DO NOT move forward.
- [ ] A card with empty `targets` is unaffected (moves forward on pass exactly as today).
- [ ] The gate never throws out of `processCard` (a `computeChangedFiles` error is swallowed and the card proceeds as a normal pass — the gate is a guard, not a new failure mode).
- [ ] The default branch name used for the base is derived once (constant `main`, matching `RepoWorkspaceConfig.defaultBranch` — see note) — no hardcoded duplication scattered.
- [ ] `bun run check` is green.
- [ ] No changes to files outside the list above.

**Note:** the worker does not currently know the default branch name (it lives in `RepoWorkspace`). Use `origin/main` as the base (the worker already assumes `card/<id>` off default at worker.ts:686). If a project ever needs a non-`main` default, that is a follow-up; do not add config here (YAGNI).

**Step 1: Write the failing test**

Add to `src/worker.test.ts`:

```typescript
describe("Worker — deliverable gate", () => {
	it("fails a pass whose declared targets were not changed (docs-only diff)", async () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)
		store.updateProject(seeded.projectId, { githubRepo: "file:///tmp/fake-remote" })
		store.createColumn({
			projectId: seeded.projectId, name: "Done", prompt: "done",
			skills: [], model: null, position: 1,
		})
		// Re-declare the seeded card's targets to a code file the diff will NOT touch.
		store.updateCard(seeded.cardId, { targets: ["scripts/main.gd"] })

		const fakeWorkspace = {
			prepareCardWorkspace: (_p: string, cardId: string): Promise<{ repoPath: string; branch: string }> =>
				Promise.resolve({ repoPath: "/tmp/clockwork-fake-repo", branch: `card/${cardId}` }),
			commitCardWork: (): Promise<boolean> => Promise.resolve(true),
			computeChangedFiles: (): Promise<string[]> => Promise.resolve(["docs/plan.md"]),
		}

		const worker = new Worker({
			dbStore: store, projectId: seeded.projectId, token: "test", workerId: "w",
			projectRoot: "/tmp", transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50, maxRetries: 3,
		})
		worker.repoWorkspace = fakeWorkspace
		worker.invokePi = mock(() =>
			Promise.resolve({
				stdout: JSON.stringify({ verdict: "pass", feedback: "done", artifacts: [] }),
				stderr: "", exitCode: 0,
			}),
		)

		await startWorker(worker)
		worker.stop()
		await worker.stopped()

		const card = store.getCardById(seeded.cardId)!
		// The pass was gated into a kickback: retry incremented, still not in Done.
		expect(card.retryCount).toBeGreaterThanOrEqual(1)

		store.close()
		fs.unlinkSync(path)
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/worker.test.ts -t "deliverable gate"`
Expected: FAIL — the card advances (retryCount stays 0).

**Step 3: Write minimal implementation**

In `src/worker.ts`, extend `RepoWorkspaceLike` (worker.ts:65):

```typescript
	computeChangedFiles?(
		repoPath: string,
		base: string,
		cardBranch: string,
	): Promise<string[]>
```

Add the import at the top of `worker.ts`: `import { targetsSatisfied } from "./gate.ts"`

In `processCard`, replace the `case "pass"` block (worker.ts:611-614):

```typescript
			case "pass": {
				const gated = await this.deliverableGateFails(card, workDir)
				if (gated) {
					await this.kickback(card, {
						verdict: "fail",
						feedback: gated,
						artifacts: verdict.artifacts,
					})
					break
				}
				await this.moveForward(card, verdict)
				break
			}
```

Add the private method (after `processCard`, before `saveTranscript`):

```typescript
	// Deterministic deliverable gate: if the card declares code targets but its branch
	// diff changed none of them (docs-only / plan-only), the "pass" is dishonest.
	// Returns a failure reason string when the gate FAILS, or null when it passes /
	// does not apply. Never throws — a diff error degrades to "gate passes".
	private async deliverableGateFails(card: DbCard, workDir: string): Promise<string | null> {
		if (card.targets.length === 0) {
			return null
		}
		if (!this._repoWorkspace?.computeChangedFiles || workDir === this.projectRoot) {
			return null
		}
		try {
			const changed = await this._repoWorkspace.computeChangedFiles(
				workDir,
				"origin/main",
				`card/${card.id}`,
			)
			if (targetsSatisfied(changed, card.targets)) {
				return null
			}
			return `deliverable gate: declared targets ${card.targets.join(", ")} were not changed (diff touched only: ${changed.join(", ") || "nothing"})`
		} catch {
			return null
		}
	}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/worker.test.ts -t "deliverable gate"`
Expected: PASS.

**Step 5: Verify and commit**

Run: `bun run check`

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: deterministic deliverable gate fails docs-only diffs on declared code targets"
```

---

### Task 6: Add the deliverable judgment to the Code-Review column prompt (bootstrap + note the live-column director action)

**Files:**
- Modify: `scripts/bootstrap-project.ts:95-105` (the `Code-Review` prompt)
- Test: `scripts/bootstrap-project.test.ts` (new — assert the prompt contains the judgment sentence)

**Why (design):** the prompt judgment layer atop the deterministic gate (design §2: "The Code-Review column prompt adds the judgment layer"). Note in the plan that the LIVE column needs the same via a director action (Task 9 `updateColumn` already exists as `PUT /api/columns/:id`; the director uses it, no new endpoint).

**Acceptance Criteria:**
- [ ] The `Code-Review` prompt in `bootstrap-project.ts` contains a sentence rejecting a card whose deliverable is a plan/doc rather than the implemented code artifact.
- [ ] A test loads the columns array from the module and asserts the Code-Review prompt includes the phrase `deliverable` and `plan`.
- [ ] The plan text notes: to apply this to an already-live board, the director calls `PUT /api/columns/:id` with the new prompt (no new endpoint needed).
- [ ] `bun run check` is green.
- [ ] No changes to files outside the list above.

**Refactor note (DRY):** `bootstrap-project.ts` currently runs `bootstrap()` on import via the bottom `bun` block. To test the columns array without hitting the network, export the columns builder. Add near the top: `export function pipelineColumns(dense: string): Array<{name:string;prompt:string;position:number;model:string|null;skills:string[]}> { ... }` and have `bootstrap` call it. Keep the CLI entry guarded by `if (import.meta.main)`.

**Step 1: Write the failing test**

Create `scripts/bootstrap-project.test.ts`:

```typescript
import { describe, it, expect } from "bun:test"
import { pipelineColumns } from "./bootstrap-project.ts"

describe("pipelineColumns", () => {
	it("Code-Review prompt rejects a plan-only deliverable", () => {
		const cols = pipelineColumns("MODEL")
		const review = cols.find((c) => c.name === "Code-Review")
		expect(review).toBeDefined()
		expect(review!.prompt.toLowerCase()).toContain("deliverable")
		expect(review!.prompt.toLowerCase()).toContain("plan")
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test scripts/bootstrap-project.test.ts`
Expected: FAIL — `pipelineColumns` not exported (and/or prompt lacks the phrases).

**Step 3: Write minimal implementation**

Refactor `bootstrap-project.ts` to export `pipelineColumns(dense)` returning the existing `columns` array, guard the CLI block with `if (import.meta.main)`, and extend the Code-Review prompt (bootstrap-project.ts:101) by appending:

```
- the deliverable is only a plan or documentation when the card required implemented code — reject any card whose actual code artifact is missing (a green plan is not the deliverable).
```

**Step 4: Run test to verify it passes**

Run: `bun test scripts/bootstrap-project.test.ts`
Expected: PASS.

**Step 5: Verify and commit**

Run: `bun run check`

```bash
git add scripts/bootstrap-project.ts scripts/bootstrap-project.test.ts
git commit -m "feat: Code-Review prompt rejects plan-only deliverables; export pipelineColumns"
```

---

## Section 3 — Director-decision routing (blocks become routed choices)

### Task 7: Classify the park reason and store it on the card

**Files:**
- Create: `src/classify.ts` (pure classifier)
- Modify: `src/worker.ts:717-768` (`kickback` — classify at the retry-exhausted park; store a thread entry + pass into the event + SMS)
- Test: `src/classify.test.ts`, add a case to `src/worker.test.ts`

**Why (design):** design §3 acceptance — "A parked card records a classified reason (not just free text)."

**Acceptance Criteria:**
- [ ] `src/classify.ts` exports `type ParkReason = "scope-mismatch" | "deliverable-missing" | "dependency" | "genuine-failure" | "preemption-exhausted"` and `function classifyParkReason(feedback: string): ParkReason`.
- [ ] Classification is deterministic keyword matching on the last verdict feedback: `deliverable gate` / `not changed` → `deliverable-missing`; `depends` / `dependency` / `prerequisite` → `dependency`; `scope` / `too big` / `re-scope` → `scope-mismatch`; `preempt` → `preemption-exhausted`; else `genuine-failure`.
- [ ] On retry-exhausted park, the worker adds a `card_threads` entry of type `park-reason` with the classification, and the classification appears in the `needsHuman` event reason and the SMS text.
- [ ] `bun run check` is green.
- [ ] No changes to files outside the list above.

**Step 1: Write the failing test**

Create `src/classify.test.ts`:

```typescript
import { describe, it, expect } from "bun:test"
import { classifyParkReason } from "./classify.ts"

describe("classifyParkReason", () => {
	it("classifies a deliverable-gate feedback", () => {
		expect(classifyParkReason("deliverable gate: declared targets not changed")).toBe("deliverable-missing")
	})
	it("classifies a dependency feedback", () => {
		expect(classifyParkReason("blocked: prerequisite card not done")).toBe("dependency")
	})
	it("classifies a scope feedback", () => {
		expect(classifyParkReason("this card is too big, re-scope")).toBe("scope-mismatch")
	})
	it("classifies preemption", () => {
		expect(classifyParkReason("arbiter preempted repeatedly")).toBe("preemption-exhausted")
	})
	it("defaults to genuine-failure", () => {
		expect(classifyParkReason("tests failed with assertion error")).toBe("genuine-failure")
	})
})
```

Add to `src/worker.test.ts` (in a `describe("Worker — park classification")`): drive a card to retry-exhausted with a deliverable-gate feedback and assert a `park-reason` thread entry exists with `deliverable-missing`. (Reuse the existing retry-exhaust test scaffold near worker.test.ts:717 pattern — set `maxRetries: 1` and return a `fail` verdict with the gate feedback.)

**Step 2: Run test to verify it fails**

Run: `bun test src/classify.test.ts`
Expected: FAIL — `./classify.ts` missing.

**Step 3: Write minimal implementation**

Create `src/classify.ts`:

```typescript
export type ParkReason =
	| "scope-mismatch"
	| "deliverable-missing"
	| "dependency"
	| "genuine-failure"
	| "preemption-exhausted"

// Deterministic keyword classification of a parked card's last feedback. Machinery
// stays dumb: no model call, just a fixed mapping the director can rely on.
export function classifyParkReason(feedback: string): ParkReason {
	const f = feedback.toLowerCase()
	if (f.includes("deliverable") || f.includes("not changed")) {
		return "deliverable-missing"
	}
	if (f.includes("depend") || f.includes("prerequisite")) {
		return "dependency"
	}
	if (f.includes("scope") || f.includes("too big") || f.includes("re-scope")) {
		return "scope-mismatch"
	}
	if (f.includes("preempt")) {
		return "preemption-exhausted"
	}
	return "genuine-failure"
}
```

In `worker.ts` `kickback`, inside the retry-exhausted branch (after computing `newRetry >= this.maxRetries`, before the SMS at worker.ts:766), classify and record:

```typescript
			const parkReason = classifyParkReason(verdict.feedback)
			this.dbStore.addCardThreadEntry({
				cardId: card.id,
				entryType: "park-reason",
				content: parkReason,
			})
```

Add `parkReason` to the `needsHuman` event reason (`reason: \`[${parkReason}] Retry count ${newRetry} >= max ${this.maxRetries}\``) and pass it into the SMS (`smsForNeedsHuman(card.title, \`[${parkReason}] ${verdict.feedback}\`)`). Import `classifyParkReason` at the top.

**Step 4: Run test to verify it passes**

Run: `bun test src/classify.test.ts src/worker.test.ts -t "park classification"`
Expected: PASS.

**Step 5: Verify and commit**

Run: `bun run check`

```bash
git add src/classify.ts src/classify.test.ts src/worker.ts src/worker.test.ts
git commit -m "feat: classify park reason and record it on the card thread + event + SMS"
```

---

### Task 8: Emit a `card.parked` websocket event with classification + suggested actions

**Files:**
- Modify: `src/ws.ts:3-16` (add `card.parked` to `WSMessage`)
- Test: `src/ws.test.ts` (assert broadcast of the new event reaches a subscriber)

**Why (design):** design §3 acceptance — "The park surfaces a structured director-action set (board + SMS/record)."

**Acceptance Criteria:**
- [ ] `WSMessage` gains `{ type: "card.parked"; cardId: string; projectId: string; reason: ParkReason; suggestedActions: string[]; timestamp: number }`.
- [ ] A constant `SUGGESTED_ACTIONS: Record<ParkReason, string[]>` maps each reason to its director-action set (e.g. `deliverable-missing → ["requeueCard","reScopeCard","abandonCard"]`, `scope-mismatch → ["reScopeCard","requeueCard"]`, `dependency → ["setCardDependsOn","requeueCard"]`, `preemption-exhausted → ["resetRetry","requeueCard"]`, `genuine-failure → ["reScopeCard","abandonCard","resetRetry"]`) — exported from `src/ws.ts` or `src/classify.ts` (put it in `classify.ts` beside `ParkReason`, DRY).
- [ ] The worker broadcasts `card.parked` when a card parks at needs-human. (Wire via a new optional `onEvent`-adjacent broker hook OR — simpler — the worker already has `onEvent`; add a `card.parked` shaped WorkerEvent and let `index.ts`/api layer forward it. **Decision:** add `{ type: "parked"; cardId: string; reason: ParkReason; suggestedActions: string[] }` to `WorkerEvent` and emit it in `kickback`; the broadcast to websocket clients is done where the broker is reachable. Since the worker does not hold the broker, this task only adds the WorkerEvent + the WSMessage type + the SUGGESTED_ACTIONS map and tests the broker broadcast directly.)
- [ ] `ws.test.ts` broadcasts a `card.parked` message and asserts a subscribed client receives it with the reason and actions intact.
- [ ] `bun run check` is green.
- [ ] No changes to files outside the list above.

**Step 1: Write the failing test**

Add to `src/ws.test.ts` (match the existing broadcast-to-subscriber pattern in that file):

```typescript
it("broadcasts card.parked with classification and suggested actions", async () => {
	// ...open a ws to the test server, send subscribe for projectId...
	broker.broadcast({
		type: "card.parked",
		cardId: "c1",
		projectId: "p1",
		reason: "deliverable-missing",
		suggestedActions: ["requeueCard", "reScopeCard", "abandonCard"],
		timestamp: Date.now(),
	})
	// ...assert the received message.type === "card.parked" and reason/suggestedActions match...
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/ws.test.ts -t "card.parked"`
Expected: FAIL — `card.parked` not an allowed `WSMessage` (tsc) / not received.

**Step 3: Write minimal implementation**

In `src/classify.ts` add:

```typescript
export const SUGGESTED_ACTIONS: Record<ParkReason, string[]> = {
	"scope-mismatch": ["reScopeCard", "requeueCard"],
	"deliverable-missing": ["requeueCard", "reScopeCard", "abandonCard"],
	"dependency": ["setCardDependsOn", "requeueCard"],
	"genuine-failure": ["reScopeCard", "abandonCard", "resetRetry"],
	"preemption-exhausted": ["resetRetry", "requeueCard"],
}
```

In `src/ws.ts`, import `ParkReason` and add to the `WSMessage` union:

```typescript
  | { type: "card.parked"; cardId: string; projectId: string; reason: ParkReason; suggestedActions: string[]; timestamp: number }
```

**Step 4: Run test to verify it passes**

Run: `bun test src/ws.test.ts -t "card.parked"`
Expected: PASS.

**Step 5: Verify and commit**

Run: `bun run check`

```bash
git add src/classify.ts src/ws.ts src/ws.test.ts
git commit -m "feat: card.parked ws event + per-reason suggested director actions"
```

---

### Task 9: First-class director-action API endpoints

**Files:**
- Modify: `src/api.ts` (add handlers + routes: `resetRetry`, `requeueCard`, `reScopeCard`, `setCardScenario`, `setCardDependsOn`, `abandonCard`), `src/db.ts` (add `UpdateCardInput.dependsOn`, `UpdateCardInput.scenario`, a `scenario` column via additive migration; `updateCard` support; `parseCardRow` support)
- Test: `src/api.test.ts` (one describe per endpoint)

**Why (design):** design §3/§4 — "first-class director actions (requeue, reset, re-scope) via API/board" replacing DB pokes. The API currently **cannot reset `retry_count`** (parseUpdateCard at api.ts:182 ignores it) — that gap forced DB pokes this session. This closes it.

**Acceptance Criteria:**
- [ ] `POST /api/cards/:id/reset-retry` sets `retry_count = 0` and returns the updated card. (Removes the "reset `retry_count` via the DB" hand-touch, design §4 table row 4.)
- [ ] `POST /api/cards/:id/requeue` with body `{ column_id }` moves the card to that column, resets `retry_count = 0`, and clears any claim. (Removes "Unparked cards via the DB".)
- [ ] `POST /api/cards/:id/rescope` with body `{ title?, body?, targets? }` updates those fields (targets stored as JSON list). (Removes "hand-wrote product / re-scope by hand".)
- [ ] `POST /api/cards/:id/scenario` with body `{ scenario }` stores a per-card scenario name on the card (new additive `scenario TEXT` column).
- [ ] `POST /api/cards/:id/depends-on` with body `{ depends_on }` (nullable) sets the card's `depends_on`.
- [ ] `POST /api/cards/:id/abandon` moves the card to the Needs-Human column and clears its claim (soft-abandon; no destructive delete).
- [ ] Each endpoint returns 404 for an unknown card, broadcasts an appropriate `card.updated`/`card.moved` websocket event, and has a test following the `startServer({port:0}) + fetch` pattern (api.test.ts:25).
- [ ] `db.ts` `UpdateCardInput` gains `dependsOn?`, `scenario?`; `updateCard` persists both; `parseCardRow` returns `scenario: row.scenario ?? null`; `DbCard` gains `scenario: string | null`.
- [ ] `bun run check` is green.
- [ ] No changes to files outside the list above.

**Step 1: Write the failing test (representative — resetRetry + requeue + rescope)**

Add to `src/api.test.ts`:

```typescript
describe("director actions", () => {
	async function seedCard(): Promise<{ projectId: string; columnId: string; cardId: string }> {
		const project = db.createProject({ name: "P", description: "", githubRepo: null, branch: null })
		const col = db.createColumn({ projectId: project.id, name: "Impl", prompt: "", skills: [], model: null, position: 0 })
		const card = db.createCard({ projectId: project.id, columnId: col.id, title: "T", body: "b", position: 0 })
		db.updateCard(card.id, { retryCount: 3 })
		return { projectId: project.id, columnId: col.id, cardId: card.id }
	}

	it("POST /api/cards/:id/reset-retry sets retry_count to 0", async () => {
		const { cardId } = await seedCard()
		const res = await fetch(`${baseUrl}/api/cards/${cardId}/reset-retry`, { method: "POST" })
		expect(res.status).toBe(200)
		const data: any = await res.json()
		expect(data.retryCount).toBe(0)
	})

	it("POST /api/cards/:id/requeue moves + resets retry + clears claim", async () => {
		const { projectId, cardId } = await seedCard()
		const target = db.createColumn({ projectId, name: "Backlog", prompt: "", skills: [], model: null, position: 5 })
		db.claimCard(cardId, "w")
		const res = await fetch(`${baseUrl}/api/cards/${cardId}/requeue`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ column_id: target.id }),
		})
		expect(res.status).toBe(200)
		const data: any = await res.json()
		expect(data.columnId).toBe(target.id)
		expect(data.retryCount).toBe(0)
		expect(data.claimState).toBeNull()
	})

	it("POST /api/cards/:id/rescope edits title, body, targets", async () => {
		const { cardId } = await seedCard()
		const res = await fetch(`${baseUrl}/api/cards/${cardId}/rescope`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "New", targets: ["main.gd"] }),
		})
		expect(res.status).toBe(200)
		const data: any = await res.json()
		expect(data.title).toBe("New")
		expect(data.targets).toEqual(["main.gd"])
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/api.test.ts -t "director actions"`
Expected: FAIL — 404 not found (routes missing).

**Step 3: Write minimal implementation**

In `src/db.ts`: add `scenario` to `DbCard` (`scenario: string | null`), to `UpdateCardInput` (`dependsOn?: string | null`, `scenario?: string | null`), add the additive `ALTER TABLE cards ADD COLUMN scenario TEXT` (try/catch) and `scenario TEXT` in `CREATE TABLE`, extend `updateCard` with `depends_on` and `scenario` branches, and `parseCardRow` with `scenario: row.scenario ?? null`.

In `src/api.ts`, add handlers (mirroring `handleUnclaim`, api.ts:638) and routes (mirroring api.ts:736). Example:

```typescript
async function handleResetRetry(request: Request, dbStore: DbStore, id: string, broker: WsBroker): Promise<Response> {
	const existing = dbStore.getCardById(id)
	if (!existing) {
		return errorResponse(404, "card not found")
	}
	const updated = dbStore.updateCard(id, { retryCount: 0 })
	broker.broadcast({ type: "card.updated", cardId: id, projectId: existing.projectId, timestamp: Date.now() } as WSMessage)
	return jsonResponse(200, updated)
}

async function handleRequeue(request: Request, dbStore: DbStore, id: string, broker: WsBroker): Promise<Response> {
	const existing = dbStore.getCardById(id)
	if (!existing) {
		return errorResponse(404, "card not found")
	}
	let body: any
	try {
		body = await parseBody(request)
	} catch {
		return errorResponse(400, "invalid JSON body")
	}
	if (!body.column_id || typeof body.column_id !== "string") {
		return errorResponse(400, "column_id is required")
	}
	const pos = nextPositionInColumn(dbStore, existing.projectId, body.column_id)
	dbStore.moveCard(id, body.column_id, pos, false)
	dbStore.updateCard(id, { retryCount: 0 })
	dbStore.unclaimCard(id)
	const updated = dbStore.getCardById(id)!
	broker.broadcast({ type: "card.moved", cardId: id, projectId: existing.projectId, fromColumn: existing.columnId, toColumn: body.column_id, timestamp: Date.now() } as WSMessage)
	return jsonResponse(200, updated)
}
```

Add analogous `handleRescope` (updates `title`/`body`/`targets`), `handleSetScenario` (`scenario`), `handleSetDependsOn` (`dependsOn`), `handleAbandon` (move to the `human` column via the same lookup used in worker.ts:729, unclaim). Register routes in `route()` after api.ts:738:

```typescript
	if (method === "POST" && cardMatch.match && cardMatch.rest === "/reset-retry") {
		return handleResetRetry(request, dbStore, cardMatch.param!, broker)
	}
	if (method === "POST" && cardMatch.match && cardMatch.rest === "/requeue") {
		return handleRequeue(request, dbStore, cardMatch.param!, broker)
	}
	if (method === "POST" && cardMatch.match && cardMatch.rest === "/rescope") {
		return handleRescope(request, dbStore, cardMatch.param!, broker)
	}
	if (method === "POST" && cardMatch.match && cardMatch.rest === "/scenario") {
		return handleSetScenario(request, dbStore, cardMatch.param!, broker)
	}
	if (method === "POST" && cardMatch.match && cardMatch.rest === "/depends-on") {
		return handleSetDependsOn(request, dbStore, cardMatch.param!, broker)
	}
	if (method === "POST" && cardMatch.match && cardMatch.rest === "/abandon") {
		return handleAbandon(request, dbStore, cardMatch.param!, broker)
	}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/api.test.ts -t "director actions"`
Expected: PASS.

**Step 5: Verify and commit**

Run: `bun run check`

```bash
git add src/api.ts src/db.ts src/api.test.ts
git commit -m "feat: first-class director-action endpoints (reset-retry, requeue, rescope, scenario, depends-on, abandon)"
```

---

### Task 10: "Load a plan as a dependency-ordered card chain" director command

**Files:**
- Create: `src/chain.ts` (pure: takes an ordered list, returns the create-inputs chained via `dependsOn`)
- Modify: `src/api.ts` (add `POST /api/projects/:id/cards/chain` handler + route)
- Test: `src/chain.test.ts`, `src/api.test.ts` (endpoint test)

**Why (design):** design §4 — "load a plan as a dependency-ordered card chain … replaces the throwaway `queue-render.py`."

**Acceptance Criteria:**
- [ ] `src/chain.ts` exports `function buildChain(items: Array<{ title: string; body?: string; scenario?: string }>): Array<{ title: string; body: string; scenario: string | null; dependsOnIndex: number | null }>` where each item (after the first) depends on the previous item's index.
- [ ] `POST /api/projects/:id/cards/chain` with body `{ column_id, items: [{title, body?, scenario?}] }` creates all cards into `column_id`, chained so card N depends on card N-1's created id (using the real created ids, not indices), applies each `scenario`, and returns the created cards in order.
- [ ] The first card has `depends_on = null`; each subsequent card's `depends_on` is the prior created card's id.
- [ ] 404 for unknown project; 400 for missing `column_id` or empty `items`.
- [ ] `bun run check` is green.
- [ ] No changes to files outside the list above.

**Step 1: Write the failing test**

Create `src/chain.test.ts`:

```typescript
import { describe, it, expect } from "bun:test"
import { buildChain } from "./chain.ts"

describe("buildChain", () => {
	it("chains each item to the previous by index", () => {
		const chain = buildChain([{ title: "A" }, { title: "B" }, { title: "C" }])
		expect(chain[0]!.dependsOnIndex).toBeNull()
		expect(chain[1]!.dependsOnIndex).toBe(0)
		expect(chain[2]!.dependsOnIndex).toBe(1)
	})

	it("carries body and scenario through", () => {
		const chain = buildChain([{ title: "A", body: "do", scenario: "a.yaml" }])
		expect(chain[0]!.body).toBe("do")
		expect(chain[0]!.scenario).toBe("a.yaml")
	})
})
```

Add an `src/api.test.ts` case: POST a 3-item chain, then GET the cards and assert `depends_on` links point at the prior created id and scenarios are set.

**Step 2: Run test to verify it fails**

Run: `bun test src/chain.test.ts`
Expected: FAIL — `./chain.ts` missing.

**Step 3: Write minimal implementation**

Create `src/chain.ts`:

```typescript
export interface ChainItem {
	title: string
	body?: string
	scenario?: string
}

export interface ChainNode {
	title: string
	body: string
	scenario: string | null
	dependsOnIndex: number | null
}

export function buildChain(items: ChainItem[]): ChainNode[] {
	return items.map((item, index) => ({
		title: item.title,
		body: item.body ?? "",
		scenario: item.scenario ?? null,
		dependsOnIndex: index === 0 ? null : index - 1,
	}))
}
```

In `src/api.ts` add `handleCardsChain` (builds via `buildChain`, creates cards sequentially, tracking created ids so each `dependsOn` is the real prior id; sets `scenario` via `updateCard`) and register `POST` route on `cardMatch`-free path `projectMatch.rest === "/cards/chain"` (add before the `/cards` route so the longer path matches first).

**Step 4: Run test to verify it passes**

Run: `bun test src/chain.test.ts src/api.test.ts -t "chain"`
Expected: PASS.

**Step 5: Verify and commit**

Run: `bun run check`

```bash
git add src/chain.ts src/chain.test.ts src/api.ts src/api.test.ts
git commit -m "feat: load a plan as a dependency-ordered card chain via API"
```

---

## Section 1 — Per-card verification contracts (game-repo skill)

### Task 11: Per-card scenario selection in `verdict.py` + SKILL.md

**Files:**
- Modify: `/home/<user>/Documents/exocortex/code/projects/prism-drift/tools/visual-qa-skill/verdict.py` (add a scenario resolver that prefers a per-card file), `.../SKILL.md` (document the selection + that scenarios are authored via the director path)
- Modify: `/home/<user>/Documents/exocortex/code/projects/prism-drift/tools/visual-qa-skill/scenarios/main.yaml` (relax to the layout baseline — but see the governing-rule framing)
- Create: `.../tools/visual-qa-skill/verdict_test.py` (a small stdlib `unittest` for the resolver)

**Why (design):** design §1 — "The visual-QA skill selects the card's own scenario when one exists … else falls back to the shared baseline." Note the governing rule: the SELECTION LOGIC is skill tooling (fair to edit); the baseline relaxation + per-card scenarios are authored via the card-planning/director path (Task 9 `setCardScenario` / Task 10 chain `scenario`), NOT a manager hand-edit of product config. This task delivers the selection logic + a resolver test; the baseline relaxation is expressed as a director-authored change, documented in SKILL.md.

**Acceptance Criteria:**
- [ ] `verdict.py` gains `def resolve_scenario(scenarios_dir, card_id, fallback)` returning `scenarios/<card_id>.yaml` when that file exists, else `fallback`.
- [ ] `verdict.py`'s CLI accepts the scenario path as today, but the SKILL.md documents invoking it with the resolved per-card path; `CLOCKWORK_CARD_ID` (already in the pi env) drives resolution when the caller passes a directory instead of a file.
- [ ] `resolve_scenario` is covered by `verdict_test.py` (a per-card file present → returns it; absent → returns the fallback) using only the Python standard library (`unittest`, `tempfile`).
- [ ] SKILL.md documents: (a) the per-card selection, (b) that a mid-chain card cannot fail for a later card's feature because it uses its own scenario, (c) that scenario authoring flows through the director path (`POST /api/cards/:id/scenario` or the chain command), never a live hand-edit.
- [ ] `main.yaml` is relaxed to the layout-foundation baseline (grid + pieces-in-cells + deep-space background), with the stage-specific assertions (wave counter, build tray) noted as belonging in per-card scenarios — and the SKILL.md states this relaxation is a director-authored change.
- [ ] The resolver test passes: `python3 tools/visual-qa-skill/verdict_test.py`.
- [ ] `bun run check` is green (clockwork suite unaffected — this task touches only the game repo, so run it to confirm no accidental clockwork edits).
- [ ] No changes to files outside the list above.

**Step 1: Write the failing test**

Create `.../tools/visual-qa-skill/verdict_test.py`:

```python
import os
import tempfile
import unittest

import verdict


class ResolveScenarioTest(unittest.TestCase):
    def test_prefers_per_card_scenario_when_present(self):
        with tempfile.TemporaryDirectory() as d:
            per_card = os.path.join(d, "card-123.yaml")
            open(per_card, "w").write("- expect: x")
            fallback = os.path.join(d, "main.yaml")
            open(fallback, "w").write("- expect: y")
            self.assertEqual(verdict.resolve_scenario(d, "card-123", fallback), per_card)

    def test_falls_back_when_no_per_card_scenario(self):
        with tempfile.TemporaryDirectory() as d:
            fallback = os.path.join(d, "main.yaml")
            open(fallback, "w").write("- expect: y")
            self.assertEqual(verdict.resolve_scenario(d, "card-999", fallback), fallback)


if __name__ == "__main__":
    unittest.main()
```

**Step 2: Run test to verify it fails**

Run: `cd /home/<user>/Documents/exocortex/code/projects/prism-drift/tools/visual-qa-skill && python3 verdict_test.py`
Expected: FAIL — `resolve_scenario` does not exist (AttributeError).

**Step 3: Write minimal implementation**

Add to `verdict.py` (near `read_first_expectation`):

```python
def resolve_scenario(scenarios_dir, card_id, fallback):
    """Prefer the card's own scenario file, else the shared baseline.

    A mid-chain card must be judged against ITS OWN expectation, not a later card's
    feature, so if scenarios/<card_id>.yaml exists we use it; otherwise the shared
    baseline. card_id comes from CLOCKWORK_CARD_ID, already set in the pi env.
    """
    if card_id:
        candidate = os.path.join(scenarios_dir, card_id + ".yaml")
        if os.path.exists(candidate):
            return candidate
    return fallback
```

Update SKILL.md's "How to run it" to resolve per-card first (documented invocation), add a "Per-card contracts" section noting the mid-chain guarantee and the director-authoring rule, and relax `main.yaml`'s `expect` to the layout baseline (drop the wave-counter/build-tray assertions, keep grid/pieces-in-cells/deep-space-navy), with a comment that stage specifics belong in per-card scenarios authored via the director path.

**Step 4: Run test to verify it passes**

Run: `python3 verdict_test.py`
Expected: PASS (2 tests).

**Step 5: Verify and commit (game repo)**

Run: `bun run check` (in clockwork — confirm nothing there changed) AND `python3 verdict_test.py` (game repo).

```bash
# In the prism-drift repo:
git add tools/visual-qa-skill/verdict.py tools/visual-qa-skill/verdict_test.py tools/visual-qa-skill/SKILL.md tools/visual-qa-skill/scenarios/main.yaml
git commit -m "feat: per-card scenario selection in visual-QA skill; relax baseline to layout foundation"
```

---

### Task 12: Capture studio-only service config into the repo (reproducible redeploy)

**Files:**
- Create: `docs/deploy/clockwork.service.template` (systemd unit template with every `CLOCKWORK_*` env var documented) and `docs/deploy/README.md` (what each env var is, that the origin is bare via Task 2, run order)
- Modify: `docs/impl-ref.md` (link to the deploy doc)
- Test: manual verification (documented below — no code)

**Why (design):** design §4 acceptance — "The studio service env + repo config are captured in the repo/config, reproducibly." Removes the disk-only config that would not survive a redeploy/new host.

**Acceptance Criteria:**
- [ ] `docs/deploy/clockwork.service.template` lists every env var the code reads: `CLOCKWORK_DB_PATH`, `CLOCKWORK_REPOS`, `CLOCKWORK_TRANSCRIPTS`, `CLOCKWORK_PORT`, `CLOCKWORK_WORKER_PROJECT_ID`, `CLOCKWORK_TOKEN`, `CLOCKWORK_GIT_TOKEN`, `CLOCKWORK_NOTIFY_URL`, `CLOCKWORK_NOTIFY_TOKEN`, `CLOCKWORK_SMS_URL`, `CLOCKWORK_SMS_TOKEN`, `CLOCKWORK_MILESTONE_LABEL`, `CLOCKWORK_BUILD_COPY_COMMAND`, `CLOCKWORK_MAX_RETRIES`, `CLOCKWORK_POLL_INTERVAL_MS`, `CLOCKWORK_PI_TIMEOUT_MS`, `CLOCKWORK_PREEMPTION_BACKOFF_MS`, `CLOCKWORK_MAX_PREEMPTION_RETRIES` (grepped from `index.ts` + `worker.ts` — verify against source).
- [ ] The deploy README states the origin is made bare via `scripts/ensure-bare-origin.ts` (Task 2) as a deploy step, and documents secrets come from SOPS (not committed plaintext).
- [ ] `docs/impl-ref.md` links to `docs/deploy/README.md`.
- [ ] Manual verification recorded: a fresh checkout + the documented steps reproduce a running service (no disk-only state).
- [ ] `bun run check` is green (docs-only; confirms nothing broke).
- [ ] No changes to files outside the list above.

**Step 1: Enumerate the real env vars**

Run: `rg -o "CLOCKWORK_[A-Z_]+" src/ | sort -u`
Expected: the full list — reconcile against the template so none is missed.

**Step 2: Write the template + README**

Create `docs/deploy/clockwork.service.template` (systemd `[Service]` with `Environment=` lines, one per var, values as `<placeholder>` or `sops-decrypted`) and `docs/deploy/README.md`.

**Step 3: Manual verification**

On a scratch dir: check out the repo, copy the template, fill placeholders, run `bun scripts/ensure-bare-origin.ts <repos>/<project>`, start the service, confirm the board is reachable and the worker loops. Record the result in the README.

**Step 4: Verify and commit**

Run: `bun run check`

```bash
git add docs/deploy/clockwork.service.template docs/deploy/README.md docs/impl-ref.md
git commit -m "docs: capture studio service env + bare-origin deploy steps reproducibly"
```

---

## Definition of done (whole feature)

Each design-section acceptance maps to tasks. Every box requires `bun run check` green, additive migrations only, no framework/build added, and a named manual intervention removed.

**Section 1 — Per-card verification contracts**
- [ ] Visual-QA skill uses a per-card scenario when present, else the shared baseline → **Task 11**
- [ ] A mid-chain card cannot fail for a later card's feature → **Task 11** (per-card scenario) + baseline relaxation
- [ ] Scenario authoring flows through the director path (not a live hand-edit) → **Task 9 `setCardScenario`** + **Task 10 chain scenario** + **Task 11** docs
- [ ] Removes: "hand-edited the shared visual-QA scenario"

**Section 2 — Deliverable-exists gate**
- [ ] A card declaring code targets whose diff is docs-only is failed with a clear reason → **Task 5** (wired) on **Task 3** (targets) + **Task 4** (diff/predicate)
- [ ] Cards with no declared targets are unaffected → **Task 4/5** (`targetsSatisfied` returns true on empty)
- [ ] The core check is git-diff deterministic → **Task 4** (`computeChangedFiles` + pure `targetsSatisfied`)
- [ ] Code-Review prompt adds the judgment layer → **Task 6**
- [ ] Removes: "hand-wrote `scripts/main.gd`"

**Section 3 — Director-decision routing**
- [ ] A parked card records a classified reason → **Task 7**
- [ ] The park surfaces a structured director-action set (board + SMS/record) → **Task 7** (SMS/thread) + **Task 8** (`card.parked` + `SUGGESTED_ACTIONS`)
- [ ] Every offered action is a director/machinery op; none require hand-writing product → **Task 9** endpoints
- [ ] Default path from a park is "route a decision" → **Task 7 + 8**
- [ ] Removes: "unparked cards / reset `retry_count` via the DB"; "SSH+journal+DB spelunking to diagnose blocks"

**Section 4 — Hands-off operability**
- [ ] Pipeline repo is bare/`updateInstead` via setup, not a hand `git config` → **Task 2**
- [ ] Stale `card/*` branches pruned on clone/prepare → **Task 1**
- [ ] requeue / reset-retry / re-scope / set-scenario / adjust-dep / abandon / load-plan-as-chain are first-class API actions → **Task 9 + Task 10**
- [ ] Studio service env + repo config captured reproducibly → **Task 12**
- [ ] Removes: "`git config … updateInstead` on studio"; "`rm -rf` wedged workspaces"; "re-queued the render chain repeatedly by script"

---

## Ordering & parallelization

**Dependency-ordered sequence:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12.

**Hard dependencies:**
- Task 4 depends on Task 3 (`targets` field must exist before the predicate uses it).
- Task 5 depends on Task 4 (uses `computeChangedFiles` + `targetsSatisfied`).
- Task 8 depends on Task 7 (`ParkReason` type + classifier).
- Task 10 depends on Task 9 (`scenario`/`dependsOn` update support; and the chain reuses `createCard` + `updateCard`).

**Parallelizable groups (independent, no shared files):**
- **Group A (Section 4 groundwork):** Task 1 and Task 2 touch disjoint files (`repo.ts` vs a new `scripts/` file) → run in parallel.
- **Group B:** Task 11 (game repo, Python) is independent of all clockwork tasks → can run any time in parallel with clockwork work.
- **Group C:** Task 6 (bootstrap prompt) is independent of the gate wiring → can run in parallel with Tasks 3–5, but is logically Section 2.
- Task 12 (docs) can run last or in parallel once the env surface is stable (after Task 9 adds no new env — it does not).

**Serialize:** 3→4→5 (Section 2 core) and 7→8→9→10 (Section 3 core) must each run in their stated order.

---

## Execution handoff

Plan complete and saved to `docs/plans/2026-08-21-hands-off-hardening-implementation-plan.md`. Three execution options:

**1. Subagent-Driven (this session)** — dispatch a fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**2. Parallel Subagent-Driven (this session)** — dispatch concurrent subagents for the independent groups above (A, B, C), integrate results. REQUIRED SUB-SKILL: superpowers:dispatching-parallel-agents.

**3. Parallel Session (separate)** — open a new session in a worktree and batch-execute with checkpoints. REQUIRED SUB-SKILL: superpowers:executing-plans.

Which approach?
