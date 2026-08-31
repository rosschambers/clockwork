# pi `--mode json` Streaming — Design

**Problem.** clockwork runs pi in the default **text** mode, which buffers all stdout and
flushes only at each model turn's end (proven: 65s silence then a whole turn at once,
`docs/plans/2026-08-20-pi-hang-investigation.md`). A heavy single-turn stage (the prism-drift
HUD Implementation) runs 11-14 minutes emitting *zero* stdout, so even the 10-minute inactivity
watchdog kills it. The watchdog is starved of a heartbeat because text mode gives it nothing to
reset on within a turn.

**Goal.** Run pi in `--mode json`, which streams one JSON event per line **token-by-token**
(`thinking_delta`/`text_delta`), so the existing inactivity watchdog sees activity on every
token (~18-25/sec while working) and never kills a session that is making progress — while a
genuine hang (no tokens at all) still trips the watchdog. Extract the model's verdict from the
event stream and feed it to the unchanged `parseVerdict`.

**Confirmed live (2026-08-22):** `pi -p --mode json` streams `thinking_delta`/`text_delta`
events per token; the stream ends with a single `agent_end` line whose `messages[]` array holds
the full conversation. The **last assistant message**'s `content[]` contains `thinking` parts
(skip) and `text` parts (the reply, including the `{"verdict":...}` trailer). Verified: joining
the `text`-type parts of the final assistant message yields exactly the verdict JSON.

---

## Architecture

Three changes; the proven `parseVerdict` logic is untouched.

### 1. `invokePi` runs `--mode json`

Add `--mode json` to the pi args. The existing streaming reader (chunked `getReader()` loop
accumulating stdout, stamping `lastActivityAt` on every chunk) already turns per-token events
into watchdog heartbeats — no watchdog change needed. The accumulated stdout is now a stream of
per-line JSON event objects instead of raw model text.

### 2. New pure `extractAssistantText(stdout: string): string` (in `verdict.ts`)

- Split stdout into lines; JSON-parse each (ignore blank/unparseable lines — robust to stray
  output).
- Find the **last** event with `type === "agent_end"` (has `messages[]`). If none, fall back to
  the last `turn_end`/`message_end` (has a single `message`).
- From that event take the **last `role === "assistant"` message**, join its `content[]` parts
  where `part.type === "text"` (skip `thinking`), in order.
- Return the joined text. If no terminal event / no assistant text is found (e.g. the run was
  killed mid-turn before any turn completed), return `""`.

### 3. Verdict path in `processCard`

`parseVerdict(result.stdout)` → `parseVerdict(extractAssistantText(result.stdout))`. Same for
the extraction-fallback call. `extractAssistantText("")` → `""` → `parseVerdict("")` →
`blocked "Empty output"` (existing behavior). The saved transcript remains the **raw JSON event
stream** (full fidelity for debugging); extraction is a separate read.

---

## Behaviors / acceptance criteria (binary)

1. `invokePi` passes `--mode json` to pi.
2. `extractAssistantText` returns the joined `text` parts of the last assistant message from the
   last `agent_end` event.
3. It **skips `thinking` parts** — only answer text feeds the verdict.
4. It falls back to `turn_end`/`message_end`'s `message` when no `agent_end` is present.
5. It returns `""` when the stream has no terminal event (killed mid-turn) or no assistant text.
6. Unparseable / blank lines are ignored without throwing.
7. `processCard` extracts before `parseVerdict`; the verdict for a normal run is identical to
   what text mode would have produced.
8. The inactivity watchdog now resets on every streamed event (no code change; verified by an
   `invokePi` test where a fake subprocess emits events past the inactivity window and is NOT
   killed).
9. `bun run check` green; no new dependencies; TABS, explicit return types, no nested ternaries.

## Testing

- `verdict.test.ts` (or a new `extract.test.ts`): `extractAssistantText` against a **real
  captured event stream** (saved fixture): returns the verdict trailer; a thinking-only final
  message returns `""`; a stream with only deltas and no terminal event returns `""`; a
  `turn_end`-terminated stream works; stray non-JSON lines are ignored.
- `worker.test.ts`: `invokePi` fake-subprocess emits a JSON event stream ending in `agent_end`
  with a `pass` trailer → the worker records `pass`. A stream that keeps emitting events past
  the (tiny, test-configured) inactivity window is NOT killed (heartbeat proof).
- Existing `parseVerdict` text tests stay as-is — still valid for the extracted text.

## Assumptions

- pi `--mode json` emits one JSON object per line; the terminal event is `agent_end` with
  `messages[]` (confirmed live). `turn_end`/`message_end` carry a single `message` as fallback.
- The final assistant message's `text` parts, concatenated, are the model's reply that carries
  the `{"verdict":...}` trailer (confirmed: extraction on the live sample returned exactly the
  trailer).
- pi keeps emitting events while the model generates (per-token deltas), giving the watchdog a
  sub-second heartbeat during any active turn.

## Out of scope (YAGNI)

- `--mode rpc` (json suffices).
- Parsing/among-turn tool-call events for richer observability (a separate observability effort).
- Changing `parseVerdict` itself.
