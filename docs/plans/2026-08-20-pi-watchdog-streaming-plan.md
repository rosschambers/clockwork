# pi Watchdog + Streaming Transcript Implementation Plan

> **For OpenCode:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop killing long-but-active pi sessions and stop losing their transcripts, by (1) replacing the 15-minute wall-clock watchdog in `invokePi` with an inactivity watchdog that resets whenever pi emits output, and (2) reading pi's stdout/stderr incrementally so a watchdog-killed session persists the partial output it actually produced instead of an empty 82-byte file.

**Architecture:** `invokePi` currently spawns `pi` with piped stdout/stderr and awaits `Bun.readableStreamToText`, which only resolves at EOF — so a `proc.kill()` mid-session discards everything buffered and the wall-clock timer fires even while the model is streaming tokens. The fix reads both pipes chunk-by-chunk into growing accumulators; every chunk bumps a `lastActivityAt` timestamp; a timer checks "silent for longer than the inactivity window" and only then kills. On kill (or normal exit) the accumulators — not a resolved-at-EOF read — are what `invokePi` returns, so `saveTranscript` and the attempt record always contain whatever pi emitted. A hard total-runtime ceiling is retained as a backstop so a session that streams a trickle forever still cannot run truly unbounded. The spawn is made injectable (a `spawn` seam defaulting to `Bun.spawn`) so streaming/inactivity is tested deterministically against a fake subprocess with no real `pi`.

**Tech Stack:** Bun + TypeScript (ES modules), `Bun.spawn`, `ReadableStream` readers, `bun test`. No new dependencies.

**Assumptions:**
- The proven root causes (investigation: `docs/plans/2026-08-20-pi-hang-investigation.md`) are: (1) the model genuinely runs longer than 900s of continuous multi-turn generation on some render cards — model-slow, not a stuck process; (2) pi buffers stdout and flushes only at turn/process exit, so `Bun.readableStreamToText` + `proc.kill()` yields an empty transcript on every kill. Both are addressed here.
- **Chosen watchdog model: inactivity-based, with a total-runtime backstop.** Rationale below in "Design decisions". This is preferred over simply raising the wall-clock limit because it (a) never kills a session that is making progress, however long, and (b) still kills a genuinely silent/hung session promptly — the exact distinction the investigation could not previously make.
- pi buffers **per model turn** (proven: 65s of silence, then a whole turn at once). So "activity" arrives in bursts at turn boundaries, not token-by-token. The inactivity window must therefore be comfortably longer than a single slow model turn. Chosen default 5 min (see table) is ~4× the longest observed single-turn gap and far short of the old 15-min guillotine.
- The just-planned claim lease (`docs/plans/2026-08-20-claim-lease-heartbeat-plan.md`) uses `DEFAULT_CLAIM_LEASE_MS = 20 min` and a 2-min heartbeat, and its stated invariant is `claimLeaseMs > DEFAULT_PI_TIMEOUT_MS`. This plan REPLACES the single `DEFAULT_PI_TIMEOUT_MS` with an inactivity window (5 min) + a total-runtime backstop (`DEFAULT_PI_MAX_RUNTIME_MS`). The lease invariant is re-expressed against the backstop: `DEFAULT_CLAIM_LEASE_MS (20 min) > DEFAULT_PI_MAX_RUNTIME_MS`? — NO, the backstop is deliberately longer than the lease, so the heartbeat (which renews the claim every 2 min *while pi streams*) is what keeps the two consistent, not a static ordering. See "Interaction with the claim lease" — this is a real coupling the executor must not break.
- `invokePi` is the exported standalone function (`src/worker.ts:123`), not a `Worker` method; the `Worker` injects a mock `invokePi` via its setter, so `Worker` tests are unaffected. Only `invokePi`'s own internals change, plus `saveTranscript`/attempt persistence already read `result.stdout`/`result.stderr`, so they inherit the partial output for free once `invokePi` returns accumulators.
- Timer/`setInterval` in tests: the fake-subprocess approach uses REAL short timers (tens of ms), matching the existing test style (`pollIntervalMs: 50`, `delay(...)`), rather than a mocked clock — keeps it minimal and consistent with `worker.test.ts`.

---

## Design decisions (explicit, with rationale)

### 1. Inactivity watchdog vs. simply raising the wall-clock limit

**Chosen: inactivity watchdog (reset on output) + a total-runtime backstop. Rejected: only raising `DEFAULT_PI_TIMEOUT_MS`.**

| Option | Kills a progressing 40-min session? | Kills a truly-hung session? | Verdict |
|--------|-------------------------------------|-----------------------------|---------|
| Raise wall-clock to e.g. 45 min | No (if long enough) | Only after the full 45 min — a real hang strands the worker for 45 min | Weak: trades false-kills for slow hang-detection; still guesses a magic number |
| **Inactivity window (5 min) + backstop (60 min)** | **No** — every model turn resets the timer | **Yes, after 5 min of silence** | **Chosen**: separates "slow but working" from "hung" using the signal the investigation proved exists (output arrives per turn) |

The investigation proved the model streams a turn every ~15–60s while working (frame `print_timing` logs, per-turn stdout flush). An inactivity timer keyed on that output is the direct, evidence-backed discriminator. The total-runtime backstop exists only so a pathological "one byte every 4 minutes forever" session cannot run unbounded — it is not the primary control.

The machinery stays **dumb**: no parsing of pi output, no model-awareness — just "bytes arrived → reset timer; silent too long → kill". That respects clockwork's non-negotiable that intelligence lives in prompts, not the worker.

### 2. Defaults, and interaction with the claim lease

| Constant (exported from `src/worker.ts`) | Default | Env var | Why |
|---|---|---|---|
| `DEFAULT_PI_INACTIVITY_MS` | `5 * 60 * 1000` (5 min) | `CLOCKWORK_PI_INACTIVITY_MS` | ~4× the worst single-turn silence observed; kills a genuinely silent session promptly without touching a working one. |
| `DEFAULT_PI_MAX_RUNTIME_MS` | `60 * 60 * 1000` (60 min) | `CLOCKWORK_PI_MAX_RUNTIME_MS` | Backstop only: absolute ceiling on one pi session so a trickle-forever session still terminates. Generous because the inactivity window is the real control. |

**`DEFAULT_PI_TIMEOUT_MS` is removed** and replaced by the two above. Any code/plan referencing it (notably the claim-lease plan's invariant assertion) must be updated — see Task 6.

**Interaction with the claim lease (critical, do not break):** the claim-lease plan keyed its safety on `claimLeaseMs (20 min) > DEFAULT_PI_TIMEOUT_MS (15 min)` — the idea being "a lease outlives one pi session even if no heartbeat lands." With an inactivity watchdog a single pi session can now legitimately run up to `DEFAULT_PI_MAX_RUNTIME_MS = 60 min`, which is LONGER than the 20-min lease. The static ordering invariant therefore no longer holds and is the WRONG guarantee. The correct guarantee is dynamic: **the heartbeat renews the claim every 2 min for as long as pi is alive**, and pi is alive precisely while it streams (inactivity watchdog) — so a working session's claim is continuously renewed and never lapses, regardless of total runtime. The executor MUST:
- Update the claim-lease plan's Task 3 invariant test (`DEFAULT_CLAIM_LEASE_MS > DEFAULT_PI_TIMEOUT_MS`) since `DEFAULT_PI_TIMEOUT_MS` no longer exists. Replace it with an assertion of the real coupling: `DEFAULT_HEARTBEAT_INTERVAL_MS < DEFAULT_CLAIM_LEASE_MS` (the heartbeat must renew well within the lease). Covered here in Task 6's acceptance criteria as a cross-plan consistency fix.
- Leave the heartbeat mechanism itself unchanged; it already renews on a `setInterval` independent of pi's runtime.

### 3. Streaming reads instead of `readableStreamToText`

`Bun.readableStreamToText(stream)` resolves only at EOF. Replace with a manual reader loop: `const reader = proc.stdout.getReader()`, repeatedly `await reader.read()`, decode each chunk with a `TextDecoder`, append to an accumulator string, and stamp `lastActivityAt = Date.now()`. Same for stderr. On kill the loops end (reader errors/closes) but the accumulators already hold everything received. `invokePi` returns `{ stdout: outAcc, stderr: errAcc + (timedOut ? watchdog note : ""), exitCode }`. `saveTranscript` (`src/worker.ts:588-594`) and the attempt record are unchanged — they already read `result.stdout`/`result.stderr`, so they now capture partial output automatically.

### 4. Testability: inject the spawn seam

`invokePi` gains an optional last parameter carrying a `spawn` function (default `Bun.spawn`) so a test can substitute a **fake subprocess** whose `stdout`/`stderr` are `ReadableStream`s that enqueue chunks on a schedule and whose `.exited`/`.kill()` are controllable. This is the minimal seam consistent with clockwork's existing injection style (the worker already injects `invokePi`; here we inject one level deeper for `invokePi`'s own unit tests). No real `pi`, no real model, deterministic timing with short real timers.

---

## Task list (7 tasks)

- **Task 1** — Introduce the spawn seam + a `PiSpawn`/`PiSubprocessLike` type on `invokePi` (default `Bun.spawn`); pure refactor, existing behaviour preserved (green suite).
- **Task 2** — New exported constants `DEFAULT_PI_INACTIVITY_MS`, `DEFAULT_PI_MAX_RUNTIME_MS`; extend `PiInvocation` with `inactivityMs?` / `maxRuntimeMs?`. Remove `DEFAULT_PI_TIMEOUT_MS`.
- **Task 3** — Streaming reads: replace `readableStreamToText` with chunked reader loops accumulating stdout/stderr; return the accumulators. Prove partial output is returned on a mid-stream kill.
- **Task 4** — Inactivity watchdog: kill only after `inactivityMs` of no output; reset on every chunk. Prove a session that keeps emitting past the old 15-min mark is NOT killed and a silent one IS.
- **Task 5** — Total-runtime backstop: kill after `maxRuntimeMs` regardless of activity. Prove a trickle-forever session is bounded.
- **Task 6** — Wire env vars through `src/index.ts`; reconcile the claim-lease plan's removed-`DEFAULT_PI_TIMEOUT_MS` invariant.
- **Task 7** — Full regression + `bun run check` green.

Tasks are sequential (each builds on the prior refactor). Task 6's `index.ts` change is independent of Tasks 3–5 once Task 2 lands.

---

### Task 1: Make `invokePi` spawn-injectable (pure refactor)

**Files:**
- Modify: `src/worker.ts` — `invokePi` (`src/worker.ts:123-177`); add exported types above it.
- Test: `src/worker.test.ts` — add a `describe("invokePi — spawn seam")` block at end of file.

**Acceptance Criteria:**
- [ ] A new exported interface `PiSubprocessLike` describes the subset of `Bun.Subprocess` `invokePi` uses: `{ stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void; readonly exitCode: number | null }`.
- [ ] A new exported type `PiSpawn = (args: string[], options: { cwd: string; stdin: "ignore"; stdout: "pipe"; stderr: "pipe"; env: Record<string, string> }) => PiSubprocessLike`.
- [ ] `invokePi` signature becomes `invokePi(invocation: PiInvocation, spawn: PiSpawn = Bun.spawn as unknown as PiSpawn): Promise<PiResult>` — default preserves production behaviour.
- [ ] With the default spawn, existing behaviour is byte-for-byte identical (all current Worker tests that inject a mock `invokePi` are unaffected because they never call the real one).
- [ ] A unit test injects a trivial fake spawn that returns a subprocess emitting a known stdout string then exiting 0, and asserts `invokePi` returns that stdout, empty stderr, exitCode 0.
- [ ] `bun run typecheck` passes.
- [ ] No changes to files outside the list above.

**Step 1: Write the failing test**

Append to `src/worker.test.ts`:

```typescript
import { invokePi, type PiSpawn, type PiSubprocessLike } from "./worker.ts"

// Build a fake subprocess whose stdout/stderr emit the given chunk schedule.
// Each entry: { at: msFromStart, stream: "out" | "err", text }. `exitAfterMs`
// resolves `.exited`. `kill()` flips a flag and closes the streams early.
function makeFakeSpawn(opts: {
	chunks: Array<{ at: number; stream: "out" | "err"; text: string }>
	exitAfterMs: number
	exitCode?: number
}): { spawn: PiSpawn; killed: () => boolean } {
	let wasKilled = false
	const spawn: PiSpawn = () => {
		const encoder = new TextEncoder()
		let outController: ReadableStreamDefaultController<Uint8Array> | null = null
		let errController: ReadableStreamDefaultController<Uint8Array> | null = null
		const timers: ReturnType<typeof setTimeout>[] = []
		const stdout = new ReadableStream<Uint8Array>({ start(c) { outController = c } })
		const stderr = new ReadableStream<Uint8Array>({ start(c) { errController = c } })
		for (const chunk of opts.chunks) {
			timers.push(setTimeout(() => {
				if (wasKilled) return
				const ctrl = chunk.stream === "out" ? outController : errController
				try { ctrl?.enqueue(encoder.encode(chunk.text)) } catch {}
			}, chunk.at))
		}
		let resolveExited: (code: number) => void = () => {}
		const exited = new Promise<number>((resolve) => { resolveExited = resolve })
		timers.push(setTimeout(() => {
			try { outController?.close() } catch {}
			try { errController?.close() } catch {}
			resolveExited(opts.exitCode ?? 0)
		}, opts.exitAfterMs))
		const proc: PiSubprocessLike = {
			stdout, stderr, exited,
			exitCode: null,
			kill() {
				wasKilled = true
				for (const t of timers) clearTimeout(t)
				try { outController?.close() } catch {}
				try { errController?.close() } catch {}
				resolveExited(opts.exitCode ?? 143)
			},
		}
		return proc
	}
	return { spawn, killed: () => wasKilled }
}

describe("invokePi — spawn seam", () => {
	it("returns the fake subprocess's stdout on a clean exit", async () => {
		const { spawn } = makeFakeSpawn({
			chunks: [{ at: 5, stream: "out", text: '{"verdict":"pass","feedback":"ok","artifacts":[]}' }],
			exitAfterMs: 20,
			exitCode: 0,
		})
		const result = await invokePi(
			{ prompt: "p", cwd: "/tmp", inactivityMs: 10_000, maxRuntimeMs: 30_000 },
			spawn,
		)
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('"verdict":"pass"')
		expect(result.stderr).toBe("")
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/worker.test.ts -t "spawn seam"`
Expected: FAIL — `invokePi` does not accept a second arg / `PiSpawn` import undefined / `inactivityMs` not on `PiInvocation` (that field lands in Task 2; for Task 1 you MAY omit `inactivityMs`/`maxRuntimeMs` from this test and add them back in Task 2's test — but simplest is to keep them and let Task 1 also add the fields. To keep tasks bite-sized, drop those two fields from THIS test in Task 1 and rely on the existing `timeoutMs`).

> Executor note: to keep Task 1 a pure seam refactor, write the Step-1 test WITHOUT `inactivityMs`/`maxRuntimeMs` (use no timing override; the default watchdog still applies). Add the inactivity/backstop fields and their tests in Tasks 2/4/5.

Corrected Step-1 invocation for Task 1:

```typescript
		const result = await invokePi({ prompt: "p", cwd: "/tmp" }, spawn)
```

**Step 3: Write minimal implementation**

In `src/worker.ts`, above `invokePi` (before line 123), add:

```typescript
// The subset of Bun.Subprocess that invokePi drives. Injected so tests supply a
// fake subprocess (scheduled stdout/stderr chunks + controllable exit/kill) and
// the streaming + watchdog logic is exercised with no real `pi` process.
export interface PiSubprocessLike {
	stdout: ReadableStream<Uint8Array>
	stderr: ReadableStream<Uint8Array>
	exited: Promise<number>
	readonly exitCode: number | null
	kill(): void
}

export type PiSpawn = (
	args: string[],
	options: {
		cwd: string
		stdin: "ignore"
		stdout: "pipe"
		stderr: "pipe"
		env: Record<string, string>
	},
) => PiSubprocessLike
```

Change the `invokePi` signature (line 123) to accept the seam and use it for the spawn (line 134):

```typescript
export async function invokePi(
	invocation: PiInvocation,
	spawn: PiSpawn = Bun.spawn as unknown as PiSpawn,
): Promise<PiResult> {
	const args = ["pi", "-p"]
	args.push("--provider", invocation.provider ?? DEFAULT_PI_PROVIDER)
	if (invocation.model) {
		args.push("--model", invocation.model)
	}
	for (const skill of invocation.skills ?? []) {
		args.push("--skill", skill)
	}
	args.push(invocation.prompt)

	const proc = spawn(args, {
		cwd: invocation.cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...(invocation.env ?? {}) },
	})
	// ... existing read/watchdog body unchanged for now ...
```

Leave the rest of the body (lines 145-176) exactly as-is in this task.

**Step 4: Run test to verify it passes**

Run: `bun test src/worker.test.ts -t "spawn seam"` → PASS.
Run: `bun run typecheck` → clean.

**Step 5: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "refactor: make invokePi spawn-injectable for deterministic tests"
```

---

### Task 2: New timing constants + PiInvocation fields; remove DEFAULT_PI_TIMEOUT_MS

**Files:**
- Modify: `src/worker.ts` — replace `DEFAULT_PI_TIMEOUT_MS` (`src/worker.ts:103`); extend `PiInvocation` (`src/worker.ts:88-99`).
- Test: `src/worker.test.ts` — add a `describe("invokePi — timing config")` block.

**Acceptance Criteria:**
- [ ] `DEFAULT_PI_TIMEOUT_MS` is removed from `src/worker.ts`.
- [ ] Exported: `DEFAULT_PI_INACTIVITY_MS = 5 * 60 * 1000` and `DEFAULT_PI_MAX_RUNTIME_MS = 60 * 60 * 1000`.
- [ ] `PiInvocation` gains `inactivityMs?: number` and `maxRuntimeMs?: number`; its `timeoutMs?` field is removed (nothing else sets it — confirm with a repo search before deleting).
- [ ] A test asserts the two constants have the stated values and `DEFAULT_PI_INACTIVITY_MS < DEFAULT_PI_MAX_RUNTIME_MS`.
- [ ] `bun run typecheck` passes (no remaining reference to `DEFAULT_PI_TIMEOUT_MS` or `timeoutMs` anywhere).
- [ ] No changes to files outside the list above (the claim-lease reconciliation is Task 6).

**Step 1: Write the failing test**

Append to `src/worker.test.ts`:

```typescript
import { DEFAULT_PI_INACTIVITY_MS, DEFAULT_PI_MAX_RUNTIME_MS } from "./worker.ts"

describe("invokePi — timing config", () => {
	it("exposes an inactivity window shorter than the runtime backstop", () => {
		expect(DEFAULT_PI_INACTIVITY_MS).toBe(5 * 60 * 1000)
		expect(DEFAULT_PI_MAX_RUNTIME_MS).toBe(60 * 60 * 1000)
		expect(DEFAULT_PI_INACTIVITY_MS).toBeLessThan(DEFAULT_PI_MAX_RUNTIME_MS)
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/worker.test.ts -t "timing config"`
Expected: FAIL — imports undefined.

**Step 3: Write minimal implementation**

In `src/worker.ts`, replace the `DEFAULT_PI_TIMEOUT_MS` block (line 101-103) with:

```typescript
// Watchdog model: an INACTIVITY window, not a wall-clock cap. The local reasoning
// model streams output per turn while it works (proven: docs/plans/2026-08-20-pi-
// hang-investigation.md); a session is "hung" only when it goes silent for longer
// than this. Reset on every chunk of pi output. This kills a genuinely stalled
// session promptly while NEVER killing one that is still making progress, however
// long the whole card takes.
export const DEFAULT_PI_INACTIVITY_MS = 5 * 60 * 1000

// Backstop only: absolute ceiling on a single pi session so a pathological "trickle
// a byte every few minutes forever" session still terminates. The inactivity window
// is the real control; this just bounds the worst case.
export const DEFAULT_PI_MAX_RUNTIME_MS = 60 * 60 * 1000
```

In `PiInvocation` (lines 88-99), remove `timeoutMs?: number` and add:

```typescript
	// Watchdog tuning. inactivityMs: kill after this long with NO pi output (resets
	// on each chunk). maxRuntimeMs: absolute backstop on total session length.
	inactivityMs?: number
	maxRuntimeMs?: number
```

Do NOT yet change the watchdog body (still Task 4/5). But since `DEFAULT_PI_TIMEOUT_MS` is gone, temporarily bridge the existing body: in `invokePi`, change `const timeoutMs = invocation.timeoutMs ?? DEFAULT_PI_TIMEOUT_MS` to `const timeoutMs = invocation.maxRuntimeMs ?? DEFAULT_PI_MAX_RUNTIME_MS` so it still compiles and behaves as a (now 60-min) wall-clock cap until Tasks 3-5 replace the body. This keeps the suite green between tasks.

> Executor note: run a repo-wide search for `DEFAULT_PI_TIMEOUT_MS` and `timeoutMs` before deleting. The claim-lease plan (a doc, not code) references `DEFAULT_PI_TIMEOUT_MS`; that reference is reconciled in Task 6. If any *source* file references it, fix that reference here.

**Step 4: Run test to verify it passes**

Run: `bun test src/worker.test.ts -t "timing config"` → PASS.
Run: `bun run typecheck` → clean.

**Step 5: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: pi inactivity + max-runtime constants; drop DEFAULT_PI_TIMEOUT_MS"
```

---

### Task 3: Stream reads — accumulate stdout/stderr chunk-by-chunk, return partial on kill

**Files:**
- Modify: `src/worker.ts` — the read/watchdog body of `invokePi` (`src/worker.ts:156-176`).
- Test: `src/worker.test.ts` — add cases to a `describe("invokePi — streaming capture")` block.

**Acceptance Criteria:**
- [ ] `invokePi` no longer calls `Bun.readableStreamToText`. It reads `proc.stdout` and `proc.stderr` via `getReader()` loops, decoding each chunk with a `TextDecoder` and appending to `outAcc` / `errAcc`.
- [ ] On a normal exit, `result.stdout` equals the full concatenation of stdout chunks and `result.stderr` the full stderr (behaviour parity with the old EOF read).
- [ ] On a kill BEFORE exit, `result.stdout` contains every chunk received up to the kill (NOT empty) — this is the core fix for the empty-transcript artifact.
- [ ] The two reader loops run concurrently (no pipe-buffer deadlock): both are started before awaiting either (`Promise.all` / concurrent), matching the old concurrent-drain intent.
- [ ] `exitCode` is `proc.exitCode ?? 0` on normal exit; on a watchdog kill it is `124` and `stderr` gets the `[clockwork: pi killed after ...]` note appended (message updated to name the reason — inactivity vs backstop — landed in Task 4/5).
- [ ] Covered by the tests below.
- [ ] No changes to files outside the list above.

**Step 1: Write the failing test**

Append to `src/worker.test.ts` (reuses `makeFakeSpawn` from Task 1):

```typescript
describe("invokePi — streaming capture", () => {
	it("returns partial stdout captured before a kill (not empty)", async () => {
		// Emit two chunks early, then go silent forever (no exit). A short
		// inactivity window forces a kill; the two chunks must still be returned.
		const { spawn, killed } = makeFakeSpawn({
			chunks: [
				{ at: 10, stream: "out", text: "turn-1 output\n" },
				{ at: 30, stream: "out", text: "turn-2 output\n" },
			],
			exitAfterMs: 10_000_000, // effectively never exits on its own
		})
		const result = await invokePi(
			{ prompt: "p", cwd: "/tmp", inactivityMs: 120, maxRuntimeMs: 5_000 },
			spawn,
		)
		expect(killed()).toBe(true)
		expect(result.exitCode).toBe(124)
		expect(result.stdout).toContain("turn-1 output")
		expect(result.stdout).toContain("turn-2 output")
		expect(result.stderr).toContain("watchdog")
	})

	it("returns full stdout+stderr on a clean exit", async () => {
		const { spawn } = makeFakeSpawn({
			chunks: [
				{ at: 5, stream: "out", text: "hello " },
				{ at: 10, stream: "err", text: "warn " },
				{ at: 15, stream: "out", text: "world" },
			],
			exitAfterMs: 30,
			exitCode: 0,
		})
		const result = await invokePi(
			{ prompt: "p", cwd: "/tmp", inactivityMs: 10_000, maxRuntimeMs: 30_000 },
			spawn,
		)
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe("hello world")
		expect(result.stderr).toBe("warn ")
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/worker.test.ts -t "streaming capture"`
Expected: FAIL — the "partial stdout before a kill" case returns empty stdout (old `readableStreamToText` discards on kill) and/or the inactivity kill does not yet exist.

**Step 3: Write minimal implementation**

Replace the body from line 156 (`const timeoutMs = ...`) to the `return` (line 176) of `invokePi` with a streaming reader + a placeholder watchdog that Task 4 refines. Minimal shape:

```typescript
	const inactivityMs = invocation.inactivityMs ?? DEFAULT_PI_INACTIVITY_MS
	const maxRuntimeMs = invocation.maxRuntimeMs ?? DEFAULT_PI_MAX_RUNTIME_MS

	let outAcc = ""
	let errAcc = ""
	let lastActivityAt = Date.now()
	const startedAt = Date.now()
	let timedOut = false

	const decoder = new TextDecoder()
	async function drain(
		stream: ReadableStream<Uint8Array>,
		onChunk: (text: string) => void,
	): Promise<void> {
		const reader = stream.getReader()
		try {
			for (;;) {
				const { done, value } = await reader.read()
				if (done) {
					break
				}
				if (value) {
					onChunk(decoder.decode(value, { stream: true }))
				}
			}
		} catch {
			// Reader closed/errored (e.g. on kill) — whatever we accumulated stands.
		} finally {
			try {
				reader.releaseLock()
			} catch {}
		}
	}

	const readOut = drain(proc.stdout, (t) => {
		outAcc += t
		lastActivityAt = Date.now()
	})
	const readErr = drain(proc.stderr, (t) => {
		errAcc += t
		lastActivityAt = Date.now()
	})

	// Watchdog: poll for inactivity or runtime-backstop breach. (Task 4/5 refine the
	// kill-reason message; Task 3 establishes the poll + partial-capture behaviour.)
	const watchdog = new Promise<void>((resolve) => {
		const tick = setInterval(() => {
			const now = Date.now()
			const idleFor = now - lastActivityAt
			const ranFor = now - startedAt
			if (idleFor >= inactivityMs || ranFor >= maxRuntimeMs) {
				timedOut = true
				clearInterval(tick)
				try {
					proc.kill()
				} catch {}
				resolve()
			}
		}, Math.max(20, Math.min(inactivityMs, 1000)))
	})

	await Promise.race([Promise.all([readOut, readErr, proc.exited]), watchdog])
	// Ensure any in-flight reads settle after a kill so accumulators are complete.
	await Promise.allSettled([readOut, readErr])

	return {
		stdout: outAcc,
		stderr: timedOut
			? errAcc + `\n[clockwork: pi killed after watchdog]`
			: errAcc,
		exitCode: timedOut ? 124 : proc.exitCode ?? 0,
	}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/worker.test.ts -t "streaming capture"` → PASS (both cases).

**Step 5: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: stream pi stdout/stderr incrementally; keep partial output on kill"
```

---

### Task 4: Inactivity watchdog — reset on output, kill only after silence

**Files:**
- Modify: `src/worker.ts` — the watchdog note/reason in `invokePi` (make the killed message state "inactivity").
- Test: `src/worker.test.ts` — add cases to `describe("invokePi — inactivity watchdog")`.

**Acceptance Criteria:**
- [ ] (a) A session that keeps emitting output at an interval SHORTER than `inactivityMs`, continuing PAST what the old 15-min wall-clock would have killed, is NOT killed: `result.exitCode` is the clean exit code and `killed()` is `false`.
- [ ] (b) A session that goes silent for longer than `inactivityMs` IS killed with exitCode 124, and the stderr note names inactivity (e.g. `pi killed after 120ms inactivity watchdog`).
- [ ] The inactivity timer RESETS on every chunk (proven by a schedule whose chunks straddle multiple inactivity windows but never leave a gap ≥ `inactivityMs`).
- [ ] Covered by the tests below.
- [ ] No changes to files outside the list above.

**Step 1: Write the failing test**

Append to `src/worker.test.ts`:

```typescript
describe("invokePi — inactivity watchdog", () => {
	it("(a) does NOT kill a session that keeps emitting inside the window", async () => {
		// Chunks every 40ms for ~10 windows, inactivity window 120ms => never idle
		// long enough to trip. Simulates a slow-but-progressing multi-turn session
		// that would have died under the old 15-min wall clock.
		const chunks = Array.from({ length: 10 }, (_, i) => ({
			at: 40 * (i + 1),
			stream: "out" as const,
			text: `turn ${i}\n`,
		}))
		const { spawn, killed } = makeFakeSpawn({
			chunks,
			exitAfterMs: 40 * 11, // clean exit shortly after the last chunk
			exitCode: 0,
		})
		const result = await invokePi(
			{ prompt: "p", cwd: "/tmp", inactivityMs: 120, maxRuntimeMs: 60_000 },
			spawn,
		)
		expect(killed()).toBe(false)
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain("turn 9")
	})

	it("(b) DOES kill a session that goes silent past the window", async () => {
		const { spawn, killed } = makeFakeSpawn({
			chunks: [{ at: 10, stream: "out", text: "started\n" }],
			exitAfterMs: 10_000_000, // never exits; goes silent after the one chunk
		})
		const result = await invokePi(
			{ prompt: "p", cwd: "/tmp", inactivityMs: 100, maxRuntimeMs: 60_000 },
			spawn,
		)
		expect(killed()).toBe(true)
		expect(result.exitCode).toBe(124)
		expect(result.stdout).toContain("started")
		expect(result.stderr.toLowerCase()).toContain("inactivity")
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/worker.test.ts -t "inactivity watchdog"`
Expected: (b) FAILS if the note does not yet say "inactivity"; (a) should already pass from Task 3's poll — if (a) fails, the timer is not resetting on chunks (fix in Step 3).

**Step 3: Write minimal implementation**

In `invokePi`, distinguish the kill reason and refine the note. Track why the watchdog fired:

```typescript
	let killReason: "inactivity" | "runtime" | null = null
	// ...inside the interval tick:
			if (idleFor >= inactivityMs) {
				killReason = "inactivity"
			} else if (ranFor >= maxRuntimeMs) {
				killReason = "runtime"
			}
			if (killReason !== null) {
				timedOut = true
				clearInterval(tick)
				try { proc.kill() } catch {}
				resolve()
			}
	// ...in the return:
		stderr: timedOut
			? errAcc + `\n[clockwork: pi killed after ${killReason === "inactivity" ? `${inactivityMs}ms inactivity` : `${maxRuntimeMs}ms max-runtime`} watchdog]`
			: errAcc,
```

Confirm `lastActivityAt = Date.now()` is set in BOTH `onChunk` callbacks (Task 3 already does this) so (a) passes.

**Step 4: Run test to verify it passes**

Run: `bun test src/worker.test.ts -t "inactivity watchdog"` → PASS (both).

**Step 5: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: inactivity watchdog for pi — reset on output, kill on silence"
```

---

### Task 5: Total-runtime backstop

**Files:**
- Modify: `src/worker.ts` — none beyond Task 4 (the `ranFor >= maxRuntimeMs` branch already exists); this task PROVES and locks it with a test.
- Test: `src/worker.test.ts` — add a case to `describe("invokePi — runtime backstop")`.

**Acceptance Criteria:**
- [ ] A session that emits a chunk just often enough to never trip the inactivity window, but exceeds `maxRuntimeMs`, IS killed with exitCode 124 and a note naming max-runtime.
- [ ] The clean-exit and inactivity paths are unaffected (regression: Task 3/4 tests still pass).
- [ ] Covered by the test below.
- [ ] No source change required if Task 4 already implements the `runtime` branch; if a change is needed, it is confined to `src/worker.ts`.

**Step 1: Write the failing test**

Append to `src/worker.test.ts`:

```typescript
describe("invokePi — runtime backstop", () => {
	it("kills a trickle-forever session once maxRuntimeMs is exceeded", async () => {
		// A chunk every 30ms (never idle for the 100ms inactivity window), but the
		// runtime backstop is 150ms => it must be killed for runtime, not inactivity.
		const chunks = Array.from({ length: 20 }, (_, i) => ({
			at: 30 * (i + 1),
			stream: "out" as const,
			text: `.${i}`,
		}))
		const { spawn, killed } = makeFakeSpawn({
			chunks,
			exitAfterMs: 10_000_000, // never exits on its own
		})
		const result = await invokePi(
			{ prompt: "p", cwd: "/tmp", inactivityMs: 100, maxRuntimeMs: 150 },
			spawn,
		)
		expect(killed()).toBe(true)
		expect(result.exitCode).toBe(124)
		expect(result.stderr.toLowerCase()).toContain("max-runtime")
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/worker.test.ts -t "runtime backstop"`
Expected: PASS if Task 4's `runtime` branch is correct; FAIL (note says "inactivity" or no kill) if the branch ordering is wrong. If it fails, ensure the tick checks `idleFor >= inactivityMs` and `ranFor >= maxRuntimeMs` independently and labels correctly.

**Step 3: Write minimal implementation**

Only if Step 2 failed: fix the branch ordering/labelling in the watchdog tick so a runtime breach with recent activity is labelled `"runtime"`. No other change.

**Step 4: Run test to verify it passes**

Run: `bun test src/worker.test.ts -t "runtime backstop"` → PASS.

**Step 5: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "test: lock pi max-runtime backstop kill path"
```

---

### Task 6: Wire env vars + reconcile the claim-lease invariant

**Files:**
- Modify: `src/index.ts` — env parsing block (`src/index.ts:8-14`) and, if applicable, worker construction. NOTE: `invokePi`'s timing is read from `PiInvocation`, not `WorkerConfig`. The worker builds the `PiInvocation` in `processCard` (`src/worker.ts:486-497`) WITHOUT timing fields, so `invokePi` uses its defaults. To make the env vars take effect, thread `inactivityMs`/`maxRuntimeMs` from env → `Worker` → the `PiInvocation`.
- Modify: `src/worker.ts` — add `piInactivityMs?`/`piMaxRuntimeMs?` to `WorkerConfig`, `public readonly` fields + defaults, and pass them in the `processCard` `invokeFn({...})` call (both the main call at line 486 and the extraction call at line 509).
- Modify (doc only): `docs/plans/2026-08-20-claim-lease-heartbeat-plan.md` — replace the removed `DEFAULT_PI_TIMEOUT_MS` invariant.
- Test: `src/worker.test.ts` — assert the worker forwards its configured timing into the `PiInvocation`.

**Acceptance Criteria:**
- [ ] `WorkerConfig` gains `piInactivityMs?: number` and `piMaxRuntimeMs?: number`; `Worker` exposes them as `public readonly`, defaulting to `DEFAULT_PI_INACTIVITY_MS` / `DEFAULT_PI_MAX_RUNTIME_MS`.
- [ ] `processCard` passes `inactivityMs: this.piInactivityMs, maxRuntimeMs: this.piMaxRuntimeMs` into BOTH `invokeFn(...)` calls.
- [ ] `src/index.ts` constructs the worker with `piInactivityMs: Number(process.env.CLOCKWORK_PI_INACTIVITY_MS ?? DEFAULT_PI_INACTIVITY_MS)` and `piMaxRuntimeMs: Number(process.env.CLOCKWORK_PI_MAX_RUNTIME_MS ?? DEFAULT_PI_MAX_RUNTIME_MS)`, importing both constants from `./worker.ts`.
- [ ] A worker test injects a mock `invokePi`, sets `piInactivityMs`/`piMaxRuntimeMs` to sentinel values, runs one card, and asserts the invocation object received those values.
- [ ] The claim-lease plan no longer references `DEFAULT_PI_TIMEOUT_MS`; its Task 3 invariant is replaced with `DEFAULT_HEARTBEAT_INTERVAL_MS < DEFAULT_CLAIM_LEASE_MS` and a note that a single pi session may now run up to `DEFAULT_PI_MAX_RUNTIME_MS`, kept safe by the heartbeat rather than a static ordering.
- [ ] `bun run typecheck` passes.
- [ ] No changes to files outside the list above.

**Step 1: Write the failing test**

Append to `src/worker.test.ts`:

```typescript
describe("Worker — forwards pi timing config into the invocation", () => {
	it("passes piInactivityMs / piMaxRuntimeMs into invokePi", async () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)
		store.createColumn({
			projectId: seeded.projectId, name: "Done", prompt: "final",
			skills: [], model: null, position: 1,
		})
		const seen: Array<{ inactivityMs?: number; maxRuntimeMs?: number }> = []
		const worker = new Worker({
			dbStore: store,
			projectId: seeded.projectId,
			token: "test",
			workerId: "w",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
			piInactivityMs: 12345,
			piMaxRuntimeMs: 67890,
		})
		worker.invokePi = mock((invocation) => {
			seen.push({ inactivityMs: invocation.inactivityMs, maxRuntimeMs: invocation.maxRuntimeMs })
			return Promise.resolve({
				stdout: JSON.stringify({ verdict: "pass", feedback: "ok", artifacts: [] }),
				stderr: "", exitCode: 0,
			})
		})

		const card0 = await worker["claimCard"]()
		await worker.processCard(card0!)

		expect(seen.length).toBeGreaterThanOrEqual(1)
		expect(seen[0]!.inactivityMs).toBe(12345)
		expect(seen[0]!.maxRuntimeMs).toBe(67890)

		store.close()
		fs.unlinkSync(path)
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/worker.test.ts -t "forwards pi timing config"`
Expected: FAIL — config fields don't exist / invocation lacks the timing fields.

**Step 3: Write minimal implementation**

`src/worker.ts` — add to `WorkerConfig` (after `buildCopyCommand?`):

```typescript
	// pi watchdog tuning forwarded into every PiInvocation this worker makes.
	piInactivityMs?: number
	piMaxRuntimeMs?: number
```

`public readonly` + constructor defaults (near the other fields):

```typescript
	public readonly piInactivityMs: number
	public readonly piMaxRuntimeMs: number
	// ...in the constructor:
	this.piInactivityMs = config.piInactivityMs ?? DEFAULT_PI_INACTIVITY_MS
	this.piMaxRuntimeMs = config.piMaxRuntimeMs ?? DEFAULT_PI_MAX_RUNTIME_MS
```

In `processCard`, add to the main `invokeFn({...})` (line 486) and the extraction call (line 509):

```typescript
			inactivityMs: this.piInactivityMs,
			maxRuntimeMs: this.piMaxRuntimeMs,
```

`src/index.ts` — extend the import (line 3) and worker construction:

```typescript
import { Worker, DEFAULT_PI_INACTIVITY_MS, DEFAULT_PI_MAX_RUNTIME_MS } from "./worker.ts"
// ...in new Worker({ ... }):
		piInactivityMs: Number(process.env.CLOCKWORK_PI_INACTIVITY_MS ?? DEFAULT_PI_INACTIVITY_MS),
		piMaxRuntimeMs: Number(process.env.CLOCKWORK_PI_MAX_RUNTIME_MS ?? DEFAULT_PI_MAX_RUNTIME_MS),
```

Doc reconcile — in `docs/plans/2026-08-20-claim-lease-heartbeat-plan.md`, update the Assumptions bullet and Task 3 invariant that reference `DEFAULT_PI_TIMEOUT_MS`: replace with the heartbeat-within-lease invariant and a note that a pi session may now run up to `DEFAULT_PI_MAX_RUNTIME_MS` (60 min) > the 20-min lease, kept safe because the heartbeat renews the claim every 2 min while pi streams.

**Step 4: Run test to verify it passes**

Run: `bun test src/worker.test.ts -t "forwards pi timing config"` → PASS.
Run: `bun run typecheck` → clean.

**Step 5: Commit**

```bash
git add src/worker.ts src/index.ts src/worker.test.ts docs/plans/2026-08-20-claim-lease-heartbeat-plan.md
git commit -m "feat: wire CLOCKWORK_PI_INACTIVITY_MS / _MAX_RUNTIME_MS; reconcile lease invariant"
```

---

### Task 7: Full regression + the gate

**Files:**
- No source changes (verification only). If red, fix under the failing task's test-first rules.

**Acceptance Criteria:**
- [ ] (d) A normal completing session still returns full stdout + verdict: the existing `pass moves forward`, `fail kicks back`, extraction-fallback, per-card-git, merge-to-main, milestone-SMS tests pass unchanged.
- [ ] (a)+(b)+(c) The new `invokePi` streaming/inactivity/backstop tests pass: partial-capture-on-kill (c), no-kill-while-active (a), kill-on-silence (b), runtime-backstop.
- [ ] (e) The ENTIRE existing suite passes (db, worker, api, context, verdict, notify, repo, ws, web).
- [ ] (f) `bun run check` — GREEN (`tsc --noEmit` clean AND all tests pass). This is the mandatory gate per AGENTS.md.
- [ ] No reference to `DEFAULT_PI_TIMEOUT_MS` or `timeoutMs` remains in `src/`.

**Step 1: Run the gate**

Run: `bun run check`
Expected: type-check clean, all tests pass.

**Step 2: If green, optional docs update**

Update `docs/impl-ref.md` (if present) to note the new `invokePi` streaming + inactivity/backstop watchdog and the two env vars. Then:

```bash
git add docs/impl-ref.md
git commit -m "docs: record pi streaming + inactivity watchdog in impl-ref"
```

---

## Acceptance-criteria coverage map

| Required criterion | Where covered |
|--------------------|---------------|
| (a) session emitting past the OLD 15-min mark is NOT killed (timer resets on output) | Task 4 test (a): 10 chunks inside the window, clean exit, `killed()===false`. |
| (b) a genuinely silent/hung session IS killed after the inactivity window | Task 4 test (b): one chunk then silence → exitCode 124, note says "inactivity". |
| (c) on a kill the transcript/attempt contains the partial output captured so far | Task 3 test: partial stdout returned on kill (not empty); `saveTranscript`/attempt read `result.stdout` unchanged, so they persist it. |
| (d) a normal completing session still returns full stdout + verdict | Task 3 clean-exit test + Task 7 regression (existing pass/fail/git/SMS tests). |
| (e) existing worker tests still pass | Task 7 full-suite regression. |
| (f) `bun run check` green | Task 7. |
| Testable WITHOUT real pi | Tasks 1–5 use `makeFakeSpawn` injected via the `PiSpawn` seam — scheduled chunk emission + controllable exit/kill, real short timers. |
| Claim-lease consistency (heartbeat keeps claim alive during long-but-active session) | Task 6: env wiring + doc reconcile; the heartbeat (claim-lease plan) renews every 2 min while pi streams, so a session up to the 60-min backstop never lapses its 20-min lease. |

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-08-20-pi-watchdog-streaming-plan.md`. Three execution options:

1. **Subagent-Driven (this session)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
2. **Parallel Subagent-Driven (this session)** — concurrent subagents for independent tasks. Note: these tasks are largely SEQUENTIAL (each builds on the prior `invokePi` refactor); only Task 6's `index.ts`/doc edits are separable once Task 2 lands. Parallelism buys little here. REQUIRED SUB-SKILL: superpowers:dispatching-parallel-agents.
3. **Parallel Session (separate)** — open a new session in a worktree and batch-execute with checkpoints. REQUIRED SUB-SKILL: superpowers:executing-plans.

Which approach?
