# Worker Silent-Failure Fix — Implementation Plan

**Date:** 2026-08-19
**Priority:** HIGH — this is the single blocker stopping cards from flowing. clockwork writes
real code but never advances the card.
**Method:** TDD (the codebase has a `bun run check` gate — tsc + tests must stay green).

## Symptom (observed live 2026-08-19)

A worker card drove qwen3.8 to write **real, correct GDScript** into the repo, but then:
- the card ended up **unclaimed, back in its column, retry 0**;
- **zero transcripts** were written;
- **no attempt** recorded, **no move**, **no thread entry**;
- the durable systemd service logged **nothing** per card.

So `processCard` runs pi successfully, then fails/stalls in the post-pi path, invisibly.

## Root causes (confirmed by reading `src/worker.ts` processCard, lines ~288-327)

1. **`saveTranscript` is OUTSIDE the try/catch** (line 292). It does
   `mkdirSync(recursive)` + `writeFileSync` under `this.transcriptsDir`. If that throws (bad
   path, perms, the transcripts dir race), the WHOLE `processCard` throws **unhandled** — no
   attempt, no move, and the loop's `claimCard`/`processCard` has no try/catch either, so the
   card is left mid-flight. This is the most likely primary cause (transcripts dir was empty).

2. **The `blocked` branch does nothing useful** (lines 319-325). On a `blocked` verdict it emits
   an event but does **not unclaim the card, not increment retry, not move it** to needs-human.
   A blocked card therefore stalls. And qwen3.8, with reasoning on, reliably writes the CODE but
   often omits the trailing `{"verdict":...}` JSON → `parseVerdict` returns `blocked` → this dead
   branch. So even once (1) is fixed, blocked cards won't progress.

3. **`index.ts` wires no `onEvent`** (and the loop swallows errors), so every failure above is
   invisible on the durable service — which is why this took live spelunking to diagnose.

4. **Contributing: no structured verdict from the model.** The deferred **C4
   grammar-constrained verdict fallback** exists precisely for this — the model writes code but
   not the verdict trailer. Without it, most real cards return `blocked`.

## Fixes (each a TDD step)

### 1. Make the whole post-pi path fault-tolerant + always resolve the card
- Move `saveTranscript` INSIDE a try/catch; a transcript-write failure must degrade to
  `transcriptPath = null` (the schema allows null) and STILL record the attempt, not kill the run.
- Wrap the entire `processCard` body so that on ANY throw the card is **unclaimed** and a
  `blocked`/error attempt is recorded — a card must never be left claimed by a crash.
- **Test:** inject an `invokePi` that succeeds + a `saveTranscript` that throws; assert an attempt
  is still recorded (transcriptPath null) and the card is not left claimed.

### 2. Fix the `blocked` branch to resolve the card
- On `blocked`: record the attempt (already), then **unclaim** the card and either leave it for
  re-claim with an incremented retry, OR (cleaner) treat repeated `blocked` like `fail` so the
  retry counter eventually parks it at needs-human. Decide: blocked = a retry (so a card that
  never yields a verdict parks at needs-human after N), which prevents infinite silent re-claim.
- **Test:** a card whose pi output has NO verdict trailer → parseVerdict blocked → after N blocks
  the card lands in needs-human, unclaimed, not looping.

### 3. Wire worker observability into `index.ts`
- Pass an `onEvent` to the `Worker` that logs each event (claimed/running/passed/failed/blocked/
  needsHuman/idle) to stdout with the card id + a timestamp, so the journal shows the board moving.
- Also log the aggregate at each transition. Keep it terse.
- **Test:** not strictly unit-testable, but verify on the live studio service that the journal
  now shows per-card events.

### 4. C4 — grammar-constrained verdict fallback (the real reliability fix)
- When `parseVerdict(result.stdout)` returns `blocked` due to a MISSING/malformed verdict (not a
  genuine model-declared block), make a **second, tiny constrained call** to the model to extract
  the verdict from the transcript: `pi`/HTTP with a `json_schema`/GBNF grammar forcing exactly
  `{"verdict":"pass"|"fail"|"blocked","feedback":string}`. Proven feasible — the vision-critique
  step already gets clean JSON from qwen3.8 (`frame-dense-low`).
- Distinguish "model explicitly said blocked" (respect it) from "no parseable verdict" (extract).
- **Test:** given a transcript that ends with prose + a clear success but no JSON verdict, the
  fallback returns `pass`; given genuine inability, `blocked`.

## Verification (from ground truth, on the studio service)

1. `bun run check` green (tsc + tests).
2. Redeploy the studio systemd service; unclaim the beam card.
3. Watch the JOURNAL show: claimed → running → (verdict) → moved/kicked, per card.
4. Confirm the beam card actually ADVANCES (an attempt row exists, a transcript file exists, the
   card left Implementation) — end to end, undisturbed (allow MINUTES; local-model cards are slow
   — do NOT interrupt).
5. Confirm a no-verdict card eventually parks at needs-human rather than looping.

## Notes / lessons baked in

- **Local-model cards take MINUTES.** Watching = patience, not seconds. The durable systemd
  service (studio) is the right substrate; don't debug by killing/restarting mid-card.
- Also fix the two smaller logged bugs while here if cheap: the stale-claim **lease expiry** (a
  dead worker strands its card) and the **RepoWorkspace-not-wired** gap (worker uses flat
  projectRoot; per-card clone unbuilt) — both in the exocortex inbox. The lease expiry pairs
  naturally with fix #1 (a card left claimed by a crash should also be reclaimable by lease).
