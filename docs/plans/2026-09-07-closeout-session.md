# Closeout-Session on Budget Hard-Stop — Implementation Plan

> **For OpenCode:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When the max-runtime (budget) watchdog kills a work session, run one short sequential
"closeout" pi session in the same workspace that commits whatever exists and emits an honest
`pass|fail|blocked` verdict of what's done vs remaining — replacing today's canned deterministic
fail — so a card that was actually finished at the buzzer can advance instead of burning retries.

**Architecture:** Strictly serial on the single worker (no parallel sessions). The work session is
killed and fully drained first (`invokePi` returns exit 124 with a `max-runtime` stderr marker);
*then* `processCard` makes a second `invokePi` call — the same pattern the C4 verdict-extraction
fallback (`src/worker.ts:927`) already uses — with a distinct "wrap up, do NOT continue the work"
closeout prompt run in the same `workDir`. That session runs `git status` + the tenant's gate
command, commits what exists, and prints the verdict JSON, which becomes the card's verdict and
drives normal flow: a `pass` advances (subject to the existing deliverable gate), a `fail`/`blocked`
retries the SAME stage via the retry-in-place path shipped 2026-09-07 (resuming from committed WIP).
The closeout applies ONLY to the **max-runtime** kill (the budget hard-stop). An **inactivity**
kill (a genuinely silent/hung session) keeps today's deterministic `synthesizeWatchdogVerdict` fail
+ retry-in-place — spawning a second session on a hung box is pointless and risks a second hang.

**Tech Stack:** Bun + TypeScript (ES modules, tabs, `function` declarations, explicit return types
on exports, no nested ternaries). SQLite via the existing `DbStore`. Tests: `bun test`; the gate is
`bun run check` (`tsc --noEmit` + `bun test`). pi runs `--mode json`; verdicts are reconstructed
with `extractAssistantText` and parsed with `parseVerdict` (both already imported in `worker.ts`).

**Assumptions:**
- Read `docs/plans/2026-08-17-clockwork-design.md` first (locked decisions). This plan refines the
  watchdog/verdict FAILURE TAXONOMY; it does not change decision 17 (kickback for genuine failures)
  or the "machinery stays dumb" rule — the closeout is a data-driven prompt, not agent reasoning.
- The retry-in-place feature (a watchdog `fail` routed to `retryInPlace` when `watchdogVerdict !==
  null`) is already merged in `src/worker.ts` (`case "fail"` at ~line 1012, `retryInPlace` at
  ~line 1262). This plan builds ON it.
- The `max-runtime` vs `inactivity` distinction is available: `invokePi` writes
  `[clockwork: pi killed after <n>ms max-runtime watchdog]` vs `... inactivity watchdog]` into
  `stderr` (`src/worker.ts:497-499`), and `synthesizeWatchdogVerdict` already regex-captures the
  `(inactivity|max-runtime)` group (`WATCHDOG_KILL_PATTERN`, `src/worker.ts:174`).
- The closeout session gets its OWN short watchdog (default ~10 min inactivity, ~12 min runtime),
  independent of the work session's budget, so it cannot itself run for another hour.
- A tenant's gate command is per-project. There is no gate-command field on the project today, so
  the closeout prompt asks the model to "run the project's check/build/test command as documented
  in the repo (AGENTS.md / PROJECT.md / justfile) if one exists" rather than hardcoding one. Adding
  a structured `gate_command` column is explicitly OUT OF SCOPE here (YAGNI — revisit if the prose
  instruction proves unreliable).
- Everything the closeout does (git status, gate, commit) is what a normal pi session already can
  do in `workDir`; commit uses the existing `RepoWorkspace.commitCardWork`, not a new git path.

---

## Task 0: Read the code and confirm the seam

**Files:**
- Read: `src/worker.ts` — `invokePi` (347-502), the watchdog return (495-501),
  `synthesizeWatchdogVerdict` (174-194), `processCard` (from ~788): the preemption loop (862-876),
  the infra-failure path (885-907), `watchdogVerdict`/`parseVerdict`/C4 block (911-944), the
  WIP-commit block (985-992), the verdict `switch` (994-1025), `retryInPlace` (1262-1343).
- Read: `docs/plans/2026-08-17-clockwork-design.md` (decisions 6, 17), `AGENTS.md` (verdict
  classification history; the "machinery stays dumb" non-negotiable).

**Acceptance Criteria:**
- [ ] You can state, in one sentence each, where the max-runtime kill is detected, where the canned
      verdict is produced today, and where the second `invokePi` will be inserted.
- [ ] No code changes in this task.

---

## Task 1: A helper that classifies a watchdog kill as `runtime` vs `inactivity`

The closeout must fire only on the budget (runtime) kill. Extract the kill-kind so both the closeout
router (Task 3) and `synthesizeWatchdogVerdict` read one source of truth.

**Files:**
- Modify: `src/worker.ts` (near `WATCHDOG_KILL_PATTERN`, ~line 174)
- Test: `src/worker.test.ts`

**Acceptance Criteria:**
- [ ] New exported function `watchdogKillKind(result: PiResult): "inactivity" | "runtime" | null`.
- [ ] Returns `null` when `result.exitCode !== 124` OR the stderr marker is absent.
- [ ] Returns `"runtime"` for a `max-runtime` marker, `"inactivity"` for an `inactivity` marker.
- [ ] `synthesizeWatchdogVerdict` is refactored to call `watchdogKillKind` internally (no behavior
      change to its output).
- [ ] Covered by the tests below. No changes to files outside the list above.

**Step 1: Write the failing test**

```typescript
describe("watchdogKillKind", () => {
	it("classifies runtime, inactivity, and non-watchdog results", () => {
		expect(watchdogKillKind({ stdout: "", stderr: "[clockwork: pi killed after 3600000ms max-runtime watchdog]", exitCode: 124 })).toBe("runtime")
		expect(watchdogKillKind({ stdout: "", stderr: "[clockwork: pi killed after 600000ms inactivity watchdog]", exitCode: 124 })).toBe("inactivity")
		expect(watchdogKillKind({ stdout: "", stderr: "", exitCode: 124 })).toBeNull()
		expect(watchdogKillKind({ stdout: "", stderr: "boom", exitCode: 1 })).toBeNull()
	})
})
```

Add `watchdogKillKind` to the existing import line at the top of `src/worker.test.ts`.

**Step 2: Run test to verify it fails**

Run: `bun test src/worker.test.ts -t "watchdogKillKind"`
Expected: FAIL — `watchdogKillKind` is not exported.

**Step 3: Write minimal implementation**

```typescript
export function watchdogKillKind(result: PiResult): "inactivity" | "runtime" | null {
	if (result.exitCode !== 124) {
		return null
	}
	const match = result.stderr.match(WATCHDOG_KILL_PATTERN)
	if (!match) {
		return null
	}
	return match[2] === "inactivity" ? "inactivity" : "runtime"
}
```

Then refactor `synthesizeWatchdogVerdict` to derive `kind` from `watchdogKillKind(result)` (return
`null` if it is `null`), preserving its current feedback string exactly.

**Step 4: Run tests to verify they pass**

Run: `bun test src/worker.test.ts -t "watchdogKillKind"` then `bun test src/worker.test.ts -t "watchdog kill yields"`
Expected: both PASS (the refactor keeps `synthesizeWatchdogVerdict` behavior).

**Step 5: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: watchdogKillKind helper (runtime vs inactivity) + synthesize refactor"
```

---

## Task 2: The closeout prompt builder (pure function)

A pure builder makes the prompt testable and keeps `processCard` readable.

**Files:**
- Modify: `src/worker.ts` (near `EXTRACTION_PROMPT`, ~line 311)
- Test: `src/worker.test.ts`

**Acceptance Criteria:**
- [ ] New exported function `buildCloseoutPrompt(card: { title: string; body: string }): string`.
- [ ] The returned prompt EXPLICITLY forbids continuing the feature work ("do NOT start or continue
      implementing").
- [ ] It instructs, in order: (1) `git status` / review the diff, (2) run the project's documented
      check/build/test command if one exists, (3) commit anything uncommitted, (4) emit EXACTLY one
      verdict JSON object `{"verdict": "pass"|"fail"|"blocked", "feedback": "...", "artifacts": []}`
      and nothing else, where `pass` means the acceptance criteria are DEMONSTRABLY met, `fail` means
      real progress exists but the criteria are not yet met (name what remains in `feedback`), and
      `blocked` means it cannot assess.
- [ ] The prompt includes the card title and body so the model knows the acceptance criteria.
- [ ] Covered by the test below.

**Step 1: Write the failing test**

```typescript
describe("buildCloseoutPrompt", () => {
	it("forbids continuing work and demands a single verdict JSON", () => {
		const p = buildCloseoutPrompt({ title: "Grid serializer", body: "AC: round-trips deterministically" })
		expect(p).toContain("do NOT")
		expect(p.toLowerCase()).toContain("git status")
		expect(p).toContain('"verdict"')
		expect(p).toContain("Grid serializer")
		expect(p).toContain("round-trips deterministically")
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/worker.test.ts -t "buildCloseoutPrompt"`
Expected: FAIL — not defined.

**Step 3: Write minimal implementation**

```typescript
export function buildCloseoutPrompt(card: { title: string; body: string }): string {
	return [
		"The work session for this card hit its time budget and was stopped. You are the CLOSEOUT session.",
		"Do NOT start or continue implementing the feature. Your only job is to honestly assess and record the current state.",
		"",
		"Steps, in order:",
		"1. Run `git status` and review the working tree / diff to see what the work session actually produced.",
		"2. If the repo documents a check/build/test command (AGENTS.md, PROJECT.md, justfile, package.json scripts), run it once to gauge whether the work is sound. If none exists, skip.",
		"3. Commit anything uncommitted with a clear message (the work must survive for the next attempt).",
		"4. Emit EXACTLY ONE JSON object and nothing else:",
		'{"verdict": "pass" | "fail" | "blocked", "feedback": "<one sentence: what is done and what remains>", "artifacts": []}',
		'- "pass": the card\'s acceptance criteria are DEMONSTRABLY met (gate green, deliverable present).',
		'- "fail": real progress exists but the criteria are not yet met — name what remains in feedback.',
		'- "blocked": you cannot assess the state.',
		"",
		"Card: " + card.title,
		"",
		card.body,
	].join("\n")
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/worker.test.ts -t "buildCloseoutPrompt"`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: buildCloseoutPrompt for the budget-kill closeout session"
```

---

## Task 3: Closeout config knobs on the Worker

The closeout session needs its own short watchdog and an on/off switch, defaulted sensibly.

**Files:**
- Modify: `src/worker.ts` — `WorkerConfig` (~line 33-55), the `Worker` public fields (~547-586),
  and constructor defaults.
- Test: `src/worker.test.ts`

**Acceptance Criteria:**
- [ ] `WorkerConfig` gains optional `closeoutEnabled?: boolean`, `closeoutInactivityMs?: number`,
      `closeoutMaxRuntimeMs?: number`.
- [ ] New module consts `DEFAULT_CLOSEOUT_INACTIVITY_MS = 5 * 60 * 1000` and
      `DEFAULT_CLOSEOUT_MAX_RUNTIME_MS = 12 * 60 * 1000` (exported).
- [ ] `Worker` exposes `readonly closeoutEnabled: boolean` (default `true`),
      `readonly closeoutInactivityMs: number`, `readonly closeoutMaxRuntimeMs: number`, wired from
      config with the defaults above.
- [ ] Existing Worker construction tests still pass (additive, all optional).

**Step 1: Write the failing test**

```typescript
it("defaults closeout knobs and honors overrides", () => {
	const { store, path } = createTempDb()
	const base = { dbStore: store, projectId: "p", token: "t", workerId: "w", projectRoot: "/tmp", transcriptsDir: "/tmp/x", pollIntervalMs: 50, maxRetries: 3, onEvent: () => {} }
	const a = new Worker(base as unknown as WorkerConfig)
	expect(a.closeoutEnabled).toBe(true)
	expect(a.closeoutMaxRuntimeMs).toBe(12 * 60 * 1000)
	const b = new Worker({ ...base, closeoutEnabled: false, closeoutMaxRuntimeMs: 60000 } as unknown as WorkerConfig)
	expect(b.closeoutEnabled).toBe(false)
	expect(b.closeoutMaxRuntimeMs).toBe(60000)
	a.stop(); b.stop(); store.close(); fs.unlinkSync(path)
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/worker.test.ts -t "closeout knobs"`
Expected: FAIL — fields undefined.

**Step 3: Write minimal implementation**

Add the config fields, the two exported consts, the three public readonly fields, and the
constructor assignments (`config.closeoutEnabled ?? true`, etc.).

**Step 4: Run test to verify it passes**

Run: `bun test src/worker.test.ts -t "closeout knobs"`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: closeout session config knobs (enabled + short watchdog)"
```

---

## Task 4: Run the closeout session and use its verdict (the core wiring)

Insert the second `invokePi` between the watchdog detection and the verdict `switch`. On a
**runtime** kill (and only then, and only when `closeoutEnabled`), run the closeout prompt in
`workDir`; parse its output; use that verdict in place of the canned one. On failure of the closeout
itself (throw, or its own watchdog kill, or an unparseable verdict), fall back to today's
`synthesizeWatchdogVerdict` result so behavior never regresses.

**Files:**
- Modify: `src/worker.ts` — `processCard`, immediately after
  `const watchdogVerdict = synthesizeWatchdogVerdict(result)` and the `let verdict = ...` (~916-917),
  BEFORE the C4 block (925) and BEFORE the WIP-commit block (985).
- Test: `src/worker.test.ts`

**Acceptance Criteria:**
- [ ] When the work `result` is a **runtime** watchdog kill and `closeoutEnabled` is true, a SECOND
      `invokePi` is called with: `prompt = buildCloseoutPrompt(card)`, `cwd = workDir`,
      `provider = this.piProvider`, `model = column.model ?? undefined`,
      `inactivityMs = this.closeoutInactivityMs`, `maxRuntimeMs = this.closeoutMaxRuntimeMs`,
      `env = { CLOCKWORK_CARD_ID: card.id }`.
- [ ] The closeout's verdict (`parseVerdict(extractAssistantText(closeout.stdout))`) REPLACES
      `verdict` when it parses to a non-parse-failure verdict.
- [ ] If the closeout throws, is itself a watchdog kill (`watchdogKillKind(closeout) !== null`), or
      yields a parse-failure verdict, `verdict` stays the deterministic `synthesizeWatchdogVerdict`
      result (no regression, no strand).
- [ ] An **inactivity** watchdog kill does NOT trigger a closeout (still the canned fail →
      retry-in-place).
- [ ] A non-watchdog result (normal pass/fail/blocked) is untouched — no closeout call.
- [ ] The closeout call happens BEFORE the WIP-commit block, so if the closeout committed, the later
      best-effort `commitCardWork` is a harmless no-op; and BEFORE the C4 block, which is skipped for
      watchdog kills anyway (`watchdogVerdict === null` guard at 925).
- [ ] A closeout `pass` flows into `case "pass"` (advances, subject to the deliverable gate); a
      closeout `fail` flows into `case "fail"` and — because it is still a watchdog-origin kill —
      routes to `retryInPlace`. **Design note:** the `case "fail"` router currently keys off
      `watchdogVerdict !== null`. That is still true here (the work session WAS a watchdog kill), so a
      closeout `fail` correctly retries in place. Verify this holds; if the closeout replaced the
      verdict such that `watchdogVerdict` is stale, keep a local boolean
      `const wasWatchdogKill = watchdogVerdict !== null` and route on THAT in the `switch` so a
      closeout fail retries in place and a closeout pass advances.

**Step 1: Write the failing tests** (new `describe` block; card starts at `Implementation` with a
`Impl-Planning` before it and a `Needs Human` park column, mirroring the retry-in-place tests):

```typescript
describe("Worker — budget-kill closeout session", () => {
	// helpers: createTempDb, columns Impl-Planning(0)/Implementation(1)/Done(2)/Needs Human(99),
	// a card at Implementation. See the "watchdog timeout retries in place" block for the exact setup.

	function runtimeKill(): PiResult {
		return { stdout: "", stderr: "\n[clockwork: pi killed after 3600000ms max-runtime watchdog]", exitCode: 124 }
	}

	it("a runtime kill runs a closeout session whose PASS advances the card", async () => {
		// invokePi: first call -> runtimeKill(); second call -> piJsonStream({verdict:"pass",feedback:"AC met"})
		// assert: exactly 2 invokePi calls; the card advanced OUT of Implementation (columnId !== implementationColumn.id and !== planningColumn.id); no retry consumed.
	})

	it("a runtime kill whose closeout returns FAIL retries in place (same column, +1 stage retry)", async () => {
		// invokePi: first -> runtimeKill(); second -> piJsonStream({verdict:"fail",feedback:"boss AI still stubbed"})
		// assert: card stays in Implementation, unclaimed, stageRetries[impl] === 1.
	})

	it("an INACTIVITY kill does NOT run a closeout (single invokePi, canned fail, retry-in-place)", async () => {
		// invokePi: single mock returning an inactivity-kill PiResult.
		// assert: invokePi called exactly once; card stays in Implementation with stageRetries[impl] === 1.
	})

	it("a closeout that itself watchdog-kills falls back to the deterministic fail (retry-in-place)", async () => {
		// invokePi: first -> runtimeKill(); second -> runtimeKill() (closeout also killed).
		// assert: card stays in Implementation, stageRetries[impl] === 1, no throw.
	})

	it("closeoutEnabled=false skips the closeout entirely", async () => {
		// Worker built with closeoutEnabled:false; invokePi single mock -> runtimeKill().
		// assert: invokePi called exactly once; behavior identical to today (retry-in-place).
	})
})
```

Use a call-counting mock, for example:
```typescript
let calls = 0
worker.invokePi = mock(() => {
	calls += 1
	return Promise.resolve(calls === 1 ? runtimeKill() : { stdout: piJsonStream({ verdict: "pass", feedback: "AC met" }), stderr: "", exitCode: 0 })
})
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/worker.test.ts -t "budget-kill closeout"`
Expected: FAIL — no second call is made; the PASS test finds the card still in Implementation.

**Step 3: Write minimal implementation**

In `processCard`, right after `let verdict = watchdogVerdict ?? parseVerdict(replyText)` (~917):

```typescript
const wasWatchdogKill = watchdogVerdict !== null
if (this.closeoutEnabled && watchdogKillKind(result) === "runtime") {
	emitEvent(this.onEvent, { type: "running", cardId: card.id })
	try {
		const closeout = await invokeFn({
			prompt: buildCloseoutPrompt({ title: card.title, body: card.body }),
			cwd: workDir,
			provider: this.piProvider,
			model: column.model ?? undefined,
			inactivityMs: this.closeoutInactivityMs,
			maxRuntimeMs: this.closeoutMaxRuntimeMs,
			env: { CLOCKWORK_CARD_ID: card.id },
		})
		if (watchdogKillKind(closeout) === null) {
			const closeoutVerdict = parseVerdict(extractAssistantText(closeout.stdout))
			if (!isParseFailureVerdict(closeoutVerdict)) {
				verdict = closeoutVerdict
			}
		}
	} catch {
		// Closeout is best-effort — keep the deterministic watchdog verdict.
	}
}
```

Then change the `switch (verdict.verdict)` `case "fail"` router from `if (watchdogVerdict !== null)`
to `if (wasWatchdogKill)` so a closeout `fail` still retries in place (the work session was a
watchdog kill, even though `verdict` is now the closeout's). Leave `case "pass"` and `case "blocked"`
unchanged — a closeout `pass` correctly advances through the existing deliverable gate.

**Step 4: Run the full gate**

Run: `bun run check`
Expected: `tsc` clean, all tests pass (the five new closeout tests + the existing retry-in-place and
watchdog tests). If the retry-in-place router test now reads `wasWatchdogKill`, confirm it still
passes; update its comment if needed.

**Step 5: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: budget-kill closeout session — honest verdict drives advance-or-retry-in-place"
```

---

## Task 5: Persist the closeout as its own attempt (observability)

The check-in surface should show the closeout ran and what it decided, not silently swallow it.

**Files:**
- Modify: `src/worker.ts` — in the closeout block, on a successful closeout, save its transcript and
  record a distinguishable thread entry.
- Test: `src/worker.test.ts`

**Acceptance Criteria:**
- [ ] On a closeout that returns a parseable verdict, `saveTranscript(card, closeout)` is called
      (best-effort; a throw must not break processCard) and a card thread entry of type `note` is
      added, e.g. `content: "[closeout] <verdict>: <feedback>"`.
- [ ] The existing single-attempt persistence for the card's own verdict (the `createAttempt` block
      at ~956) is unchanged and still records the FINAL verdict (which is now the closeout's when it
      replaced it).
- [ ] A test asserts a `note` thread entry containing `"[closeout]"` exists after a runtime-kill
      closeout pass.

**Steps:** red test asserting the thread entry → add the `saveTranscript` + `addCardThreadEntry`
inside the closeout success branch (wrapped so it cannot throw out of `processCard`) → green →
`bun run check` → commit `feat: record the closeout session as a card thread note`.

---

## Task 6: Docs upkeep (REQUIRED by clockwork AGENTS.md)

Any verdict/retry/park behavior change must review both operator docs.

**Files:**
- Modify: `docs/new-tenant-runbook.md` — add a short "Budget hard-stop → closeout session" note under
  the watchdog/timeout discussion: a card that hits the runtime budget now gets a wrap-up session
  that commits WIP and honestly scores done-vs-remaining; a genuinely finished card can advance.
- Modify (in the exocortex superrepo):
  `.opencode/skill/clockwork-card-authoring/SKILL.md` — extend the "Watchdog-timeout retry
  semantics" note: on a max-runtime (budget) kill a closeout session now runs `git status` + gate +
  commit and emits an honest verdict, so a card done-at-the-buzzer advances instead of always
  retrying; an inactivity (hang) kill still gets the deterministic fail + retry-in-place. This makes
  "done but unscorable" (the M2-15/M2-16b pain) much rarer.

**Acceptance Criteria:**
- [ ] Both docs describe the closeout trigger (runtime kill only), what it does, and that its verdict
      can advance a finished card.
- [ ] The card-authoring skill's existing retry-in-place note is updated, not duplicated.
- [ ] Commit (clockwork repo): `docs: runbook — budget-kill closeout session`. The skill edit lives
      in the exocortex superrepo and is committed there separately.

---

## Task 7: Full-gate verification + manual reasoning check

**Acceptance Criteria:**
- [ ] `bun run check` is fully green (paste the summary line with pass/fail counts).
- [ ] Re-read the AGENTS.md "verdict classification history": confirm the closeout does NOT
      reintroduce a bare-substring infra classifier and does NOT hand an empty transcript to a model
      that could hallucinate (the closeout parses ITS OWN fresh output, and falls back to the
      deterministic verdict if that output is empty/killed).
- [ ] Confirm the closeout never runs on inactivity kills or normal verdicts (cost containment).
- [ ] Confirm no parallel pi sessions: the work session's `invokePi` has fully resolved before the
      closeout `invokePi` is called (they are sequential `await`s in `processCard`).

---

## Out of scope (YAGNI — do NOT build here)

- A structured per-project `gate_command` DB column. The prose instruction to "run the documented
  check command" is the first cut; add a column only if it proves unreliable in practice.
- A closeout for inactivity kills. A silent/hung session is unlikely to run a useful wrap-up and
  risks a second hang; keep the deterministic fail + retry-in-place there.
- Any change to the retry counter semantics or the deliverable gate — the closeout reuses both as-is.
- Merging the closeout with the C4 extraction fallback. They fire on different conditions (missing
  verdict vs budget kill) and want different prompts; keep them separate for clarity.

## Execution note

This plan is TDD, one behavior per task, `bun run check` green before each commit. Tasks 1-5 are the
code (sequential — each builds on the last); Task 6 is docs; Task 7 is verification. Suitable for
subagent-driven execution with a review between Task 4 (the core wiring) and Task 5.
