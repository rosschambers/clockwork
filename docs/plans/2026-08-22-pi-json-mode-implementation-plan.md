# pi `--mode json` Streaming Implementation Plan

> **For OpenCode:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Run pi in `--mode json` so it streams per-token events (giving the inactivity watchdog a heartbeat and never false-killing a working session), and extract the model's verdict from the event stream via a new pure `extractAssistantText` fed into the unchanged `parseVerdict`.

**Architecture:** `invokePi` adds `--mode json`; the existing streaming reader already resets the watchdog on every chunk, so per-token events become heartbeats with no watchdog change. A new pure `extractAssistantText(stdout)` reconstructs the final assistant text from the last terminal event (`agent_end.messages[]`, else `turn_end`/`message_end.message`), joining `text`-type content parts and skipping `thinking`. `processCard` calls `parseVerdict(extractAssistantText(result.stdout))`. The raw JSON event stream stays the saved transcript.

**Tech Stack:** Bun + TypeScript (ES modules), `bun test`. No new dependencies.

**Assumptions:**
- Verified live 2026-08-22: `pi -p --mode json` emits one JSON object per line, streams `thinking_delta`/`text_delta` per token, and ends with an `agent_end` line whose `messages[]` holds the conversation. The last `role:"assistant"` message's `content[]` has `thinking` parts (skip) and `text` parts (join) — joining the text parts of the live sample returned exactly the `{"verdict":...}` trailer.
- The existing streaming reader in `invokePi` (chunked `getReader()` accumulator, stamps `lastActivityAt` per chunk) is already in place (shipped in the watchdog+streaming work). This plan only adds the `--mode json` flag and the extraction step; it does NOT re-architect the reader.
- `parseVerdict` (`src/verdict.ts`) is unchanged and still receives plain model text.
- House rules: strictly test-first; `bun run check` (tsc --noEmit + bun test) before every commit; TABS, `function` declarations top-level, explicit return types on exports, no nested ternaries.
- A real captured event sample is saved at `/tmp/opencode/pijson-sample.txt` (50 lines) for reference when writing fixtures; the plan inlines the minimal fixtures needed so it is self-contained.

---

## Task 1: `extractAssistantText` — reconstruct final assistant text from the JSON event stream

**Files:**
- Modify: `src/verdict.ts` (add the exported function; locate a spot near `parseVerdict`)
- Test: `src/verdict.test.ts` (new `describe("extractAssistantText")`)

**Acceptance Criteria:**
- [ ] `export function extractAssistantText(stdout: string): string` exists with that exact signature.
- [ ] Given a stream whose last `agent_end` event's last assistant message has `content` `[{type:"thinking",...},{type:"text",text:"<TRAILER>"}]`, returns `"<TRAILER>"`.
- [ ] `thinking` parts are excluded; multiple `text` parts are joined in order.
- [ ] When there is no `agent_end`, falls back to the last `turn_end` or `message_end` event's `message`.
- [ ] Returns `""` when there is no terminal event, or the final assistant message has no `text` part.
- [ ] Blank lines and non-JSON lines are ignored without throwing.
- [ ] `bun run check` green. No changes outside the two files.

**Step 1: Write the failing test**

Add to `src/verdict.test.ts`:

```typescript
import { extractAssistantText } from "./verdict.ts"

describe("extractAssistantText", () => {
	const trailer = '{"verdict": "pass", "feedback": "ok", "artifacts": []}'

	it("returns the text parts of the last assistant message in the final agent_end, skipping thinking", () => {
		const stream = [
			'{"type":"turn_start"}',
			'{"type":"agent_end","messages":[{"role":"user","content":[{"type":"text","text":"do it"}]},{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":' + JSON.stringify(trailer) + '}]}]}',
		].join("\n")
		expect(extractAssistantText(stream)).toBe(trailer)
	})

	it("falls back to turn_end.message when there is no agent_end", () => {
		const stream =
			'{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":' + JSON.stringify(trailer) + '}]}}'
		expect(extractAssistantText(stream)).toBe(trailer)
	})

	it("returns empty string when there is no terminal event (killed mid-turn)", () => {
		const stream = [
			'{"type":"turn_start"}',
			'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"partial"}}',
		].join("\n")
		expect(extractAssistantText(stream)).toBe("")
	})

	it("ignores blank and non-JSON lines", () => {
		const stream = [
			"",
			"not json at all",
			'{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"hi"}]}]}',
		].join("\n")
		expect(extractAssistantText(stream)).toBe("hi")
	})

	it("returns empty string for empty input", () => {
		expect(extractAssistantText("")).toBe("")
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test src/verdict.test.ts -t "extractAssistantText"`
Expected: FAIL — `extractAssistantText` is not exported.

**Step 3: Write minimal implementation**

Add to `src/verdict.ts`:

```typescript
interface PiTextPart {
	type: string
	text?: string
}

interface PiMessage {
	role?: string
	content?: PiTextPart[]
}

interface PiEvent {
	type?: string
	messages?: PiMessage[]
	message?: PiMessage
}

// Reconstruct the model's final reply text from a pi `--mode json` event stream.
// The stream is one JSON object per line; it ends with an `agent_end` event whose
// `messages[]` holds the conversation (fallback: `turn_end`/`message_end.message`).
// We take the LAST assistant message and join its `text`-type content parts,
// skipping `thinking`. Returns "" when no terminal event / no assistant text is
// present (e.g. the run was killed mid-turn) so the caller degrades to "blocked".
export function extractAssistantText(stdout: string): string {
	const events: PiEvent[] = []
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim()
		if (trimmed.length === 0) {
			continue
		}
		try {
			events.push(JSON.parse(trimmed) as PiEvent)
		} catch {
			// Not a JSON event line — ignore stray output.
		}
	}

	const terminal = findTerminalEvent(events)
	if (terminal === null) {
		return ""
	}

	const messages = terminal.messages ?? (terminal.message ? [terminal.message] : [])
	const assistant = lastAssistantMessage(messages)
	if (assistant === null) {
		return ""
	}

	return (assistant.content ?? [])
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("")
}

function findTerminalEvent(events: PiEvent[]): PiEvent | null {
	for (let i = events.length - 1; i >= 0; i -= 1) {
		if (events[i]!.type === "agent_end") {
			return events[i]!
		}
	}
	for (let i = events.length - 1; i >= 0; i -= 1) {
		const type = events[i]!.type
		if (type === "turn_end" || type === "message_end") {
			return events[i]!
		}
	}
	return null
}

function lastAssistantMessage(messages: PiMessage[]): PiMessage | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i]!.role === "assistant") {
			return messages[i]!
		}
	}
	return null
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/verdict.test.ts -t "extractAssistantText"`
Expected: PASS (5 tests).

**Step 5: Verify and commit**

Run: `bun run check`

```bash
git add src/verdict.ts src/verdict.test.ts
git commit -m "feat: extractAssistantText reconstructs verdict text from pi json event stream"
```

---

## Task 2: `invokePi` runs `--mode json`

**Files:**
- Modify: `src/worker.ts` (the `invokePi` arg-building block — locate by the existing `args.push("--provider", ...)` / `args.push("--skill", ...)` lines)
- Test: `src/worker.test.ts` (extend an existing `invokePi` spawn-seam test, or add one, asserting the args include `--mode json`)

**Acceptance Criteria:**
- [ ] The pi args include `--mode json` (before the prompt positional).
- [ ] A spawn-seam test captures the args passed to the fake spawn and asserts they contain `"--mode"` immediately followed by `"json"`.
- [ ] No other args change. `bun run check` green. No changes outside the two files.

**Step 1: Write the failing test**

Add to `src/worker.test.ts` (reuse the existing spawn-seam fake pattern — find the current `invokePi` spawn test and mirror it):

```typescript
it("invokes pi in --mode json", async () => {
	let captured: string[] = []
	const fakeSpawn = ((args: string[]) => {
		captured = args
		return makeFakeSubprocess('{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"{\\"verdict\\":\\"pass\\",\\"feedback\\":\\"\\",\\"artifacts\\":[]}"}]}]}')
	}) as unknown as PiSpawn
	await invokePi({ prompt: "p", cwd: "/tmp", provider: "prov" }, fakeSpawn)
	const i = captured.indexOf("--mode")
	expect(i).toBeGreaterThanOrEqual(0)
	expect(captured[i + 1]).toBe("json")
})
```

NOTE: reuse the file's existing `makeFakeSubprocess` helper and `PiSpawn` import if present; if the existing spawn-seam test uses a different fake shape, match THAT shape (the point is only to assert the args).

**Step 2: Run test to verify it fails**

Run: `bun test src/worker.test.ts -t "mode json"`
Expected: FAIL — `--mode` not in args.

**Step 3: Write minimal implementation**

In `src/worker.ts` `invokePi`, add after the provider push and before the prompt positional:

```typescript
	args.push("--mode", "json")
```

**Step 4: Run test to verify it passes**

Run: `bun test src/worker.test.ts -t "mode json"`
Expected: PASS.

**Step 5: Verify and commit**

Run: `bun run check`

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: run pi in --mode json for per-token streaming"
```

---

## Task 3: Wire `extractAssistantText` into the verdict path in `processCard`

**Files:**
- Modify: `src/worker.ts` (the two `parseVerdict(...)` call sites — main verdict + extraction-fallback rescue)
- Test: `src/worker.test.ts` (a `processCard`/worker-loop test proving a JSON-event stdout yields the right verdict)

**Acceptance Criteria:**
- [ ] The main verdict call is `parseVerdict(extractAssistantText(result.stdout))`.
- [ ] The extraction-fallback call is `parseVerdict(extractAssistantText(extraction.stdout))` (same wrapping).
- [ ] `extractAssistantText` is imported from `./verdict.ts`.
- [ ] A worker test where `invokePi` returns a JSON event stream ending in an `agent_end` with a `pass` trailer records a `pass` (card advances), and one ending with a `fail` trailer records a kickback.
- [ ] `bun run check` green. No changes outside the two files.

**Step 1: Write the failing test**

Add a worker test that injects `invokePi` returning a JSON-event stdout (mirror the existing worker-loop tests that set `worker.invokePi`). Assert the seeded card advances on a `pass` trailer wrapped in `agent_end`:

```typescript
worker.invokePi = mock(() =>
	Promise.resolve({
		stdout: '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"{\\"verdict\\":\\"pass\\",\\"feedback\\":\\"done\\",\\"artifacts\\":[]}"}]}]}',
		stderr: "",
		exitCode: 0,
	}),
)
```

(Use the same seed/assert scaffold as the existing "passes → moves forward" worker test.)

**Step 2: Run test to verify it fails**

Run: `bun test src/worker.test.ts -t "json"` (the new test)
Expected: FAIL — with the raw JSON stream, the current `parseVerdict(result.stdout)` sees the event JSON, not the trailer, and returns `blocked`, so the card does not advance.

**Step 3: Write minimal implementation**

In `src/worker.ts`: add `extractAssistantText` to the `./verdict.ts` import, and wrap both call sites:

```typescript
		let verdict = parseVerdict(extractAssistantText(result.stdout))
```
```typescript
				const rescued = parseVerdict(extractAssistantText(extraction.stdout))
```

**Step 4: Run test to verify it passes**

Run: `bun test src/worker.test.ts -t "json"`
Expected: PASS.

**Step 5: Verify and commit**

Run: `bun run check`

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: extract verdict from pi json event stream in processCard"
```

---

## Task 4: Watchdog heartbeat regression + full gate

**Files:**
- Test: `src/worker.test.ts` (an `invokePi` test proving events past the inactivity window do NOT kill)

**Acceptance Criteria:**
- [ ] An `invokePi` test with a tiny `inactivityMs` and a fake subprocess that emits an event chunk on an interval SHORTER than `inactivityMs`, continuing PAST what would have been a kill, completes normally (not exit 124) — proving each event resets the watchdog.
- [ ] The full suite (`bun run check`) is green.

**Step 1: Write the failing/locking test**

Add (mirroring the existing inactivity-watchdog tests, which already emit chunks on a schedule — this is largely a lock test confirming JSON-event chunks behave as heartbeats):

```typescript
it("does not kill a --mode json session that keeps emitting events inside the window", async () => {
	// fake subprocess: emit a small JSON event every (inactivityMs/3), for several
	// intervals past inactivityMs; assert exitCode !== 124 and the final verdict parses.
})
```

Reuse the existing inactivity-watchdog fake-subprocess helper; set `inactivityMs` to e.g. 90ms and emit every 30ms for ~300ms.

**Step 2: Run test to verify it passes (or fails if a regression exists)**

Run: `bun test src/worker.test.ts -t "keeps emitting events"`
Expected: PASS (the streaming reader already resets on each chunk; this locks the behavior for JSON events).

**Step 3: Full gate**

Run: `bun run check`
Expected: tsc clean + all tests pass.

**Step 4: Commit**

```bash
git add src/worker.test.ts
git commit -m "test: lock json-event chunks as inactivity-watchdog heartbeats"
```

---

## Definition of done (whole feature)

- [ ] `invokePi` runs `--mode json` (Task 2).
- [ ] `extractAssistantText` reconstructs the verdict text from the terminal event, skipping thinking, fallback to turn_end/message_end, "" on no terminal event (Task 1).
- [ ] `processCard` parses the verdict via `parseVerdict(extractAssistantText(...))` at both call sites (Task 3).
- [ ] A long, actively-streaming session is not killed by the inactivity watchdog (Task 4).
- [ ] The saved transcript remains the raw JSON event stream (no code change — `saveTranscript` still writes `result.stdout`; verified incidentally).
- [ ] `bun run check` green throughout; no new dependencies.

## Ordering

Sequential: 1 → 2 → 3 → 4. Task 3 depends on 1 (uses `extractAssistantText`) and is cleaner after 2. Task 4 is a lock test last.

## Execution handoff

Small, sequential, single-subsystem (invokePi + verdict). Recommend: **Subagent-Driven this session** (one subagent, tasks 1-4 in order, edit-only, coordinator commits per task) OR do it directly. REQUIRED SUB-SKILL if delegating: superpowers:subagent-driven-development.
