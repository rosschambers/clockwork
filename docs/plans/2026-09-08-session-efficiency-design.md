# Session Efficiency Design — pre-loaded targets, column focus, cross-session notes

**Problem:** Every clockwork session wastes 30-50% of its 75-minute budget on codebase
exploration (reading files one-by-one via tool calls at 35 tok/s, re-verifying state from
prior stages, running gates that belong to other columns). This affects every card on every
column — not a single-card scope issue.

**Root cause:** The assembled context includes the card body (which names targets) and
feedback from prior sessions, but NOT the actual source code. The model must discover every
file through tool calls. Combined with behavioral drift (exploring beyond scope, running
wrong-column gates) and zero cross-session memory (re-discovering what the last session
already learned), sessions routinely spend 40-50 minutes before producing any output.

## Layer 1 — Target file pre-loading

### What

The context assembler reads the card's `targets` array and the workspace directory, loads
each file's contents, and injects them as a `## Target Files` section in the assembled
prompt — between the plan slices and the card thread.

### Which files

- Every path in `card.targets` (the declared deliverables).
- For each target, its test counterpart if one exists: `scripts/foo.gd` looks up
  `tests/test_foo.gd`, and vice versa. Heuristic: strip the directory prefix, toggle
  `test_` prefix, check the opposite directory.
- The card body can optionally list additional files with an `include:` line for related
  interfaces the card references but does not modify.

### Token budget

A typical card has 4-8 targets. Godot scripts average 100-300 lines (~2-6k chars each).
Including 8 files at 4k chars average = 32k chars = 8k tokens. If including all targets
would exceed 40% of the remaining budget after PROJECT.md and column extras (~26k tokens),
truncate the largest files to function signatures + the lines referenced in the card body.
In practice this cap should never fire — game scripts are small.

### Format in the prompt

```
## Target Files (pre-loaded — do not re-read these)

### scripts/sim/grid_combat.gd

[file contents in a fenced code block]

### tests/test_grid_combat.gd

[file contents in a fenced code block]
```

### Implementation

A new `loadTargetFiles(targets: string[], workDir: string, maxChars: number)` function in
`context.ts`. Called from `processCard` in `worker.ts` before `assembleContext()`. Returns
an array of `PlanSlice`-shaped objects (title = file path, content = file contents). These
merge into the existing plan-slices tier so the existing token-budget truncation logic
applies without changes.

The test counterpart lookup is a pure function:
`scripts/sim/foo.gd` -> check `tests/test_foo.gd` exists -> include if found.
`tests/test_foo.gd` -> check `scripts/sim/foo.gd` exists -> include if found.
Missing counterparts are silently skipped (doc-only cards, new files not yet created).

## Layer 2 — Column behavioral constraints

### Principle

Intelligence lives in prompts and data, not machinery (locked design decision). Layer 2
ships as **stronger column prompt text** — no new code for the core mechanism. Each column
gets a "STAY IN LANE" block appended to its prompt.

### Per-column rules

| Column         | DO                                                       | DO NOT                                            |
|----------------|----------------------------------------------------------|---------------------------------------------------|
| Impl-Planning  | Read contract + targets. Write plan/DoD. Emit verdict.   | Write code. Run tests. Run godot.                 |
| Test-Writing   | Write FAILING tests. Run only the NEW tests to confirm red. | Write production code. Run the full suite.      |
| Implementation | Make targets pass their tests. Run the card's tests.     | Re-plan. Refactor unrelated files.                |
| Code-Review    | Read the diff + tests. Judge against DoD. Run tests.     | Rewrite code — fail with specific feedback.       |
| Visual-Check   | Run visual harness once. Compare to scenario.            | Edit code. Re-run more than once.                 |

### Anti-drift rules (carried by every column prompt)

- "The target files are pre-loaded in your context under ## Target Files. Do not re-read
  them via tool calls unless you are editing them in place."
- "Do not re-verify state a prior stage's verdict already confirmed."
- "Emit the verdict JSON as soon as the DoD is met — do not explore further."

### Implementation

Data-only change: update the column prompt text in the project's bootstrap defaults or
via the API. The existing column `prompt` field carries this. No new DB columns.

Optional future addition: a `forbiddenPatterns` array on columns, injected into the prompt
as "these commands are out of scope for this stage." Prompt-level only — no command
interception (pi runs bash freely; sandboxing is a separate, larger effort).

## Layer 3 — Cross-session context (session notes)

### What

When a session ends (pass, fail, or watchdog kill), the worker extracts a short structured
note from the transcript event stream and saves it as a `note` entry in the card thread.
The next session gets these notes in its assembled context alongside the verdict history.

### What gets extracted (mechanical, not LLM)

- **Files touched:** paths of files read/written/edited (from tool-call events in stdout).
- **Test results:** the "N run, M failed" line from any godot test run.
- **HEAD commit:** the hash and whether the tree is clean (from the commitCardWork result).
- **Remaining work:** the last ~500 chars of assistant text before the session ended — the
  model's last thoughts before being killed or emitting the verdict.

This is deterministic extraction from the event stream's JSON structure — grep for
`"type":"tool_result"` with read/write names, `"type":"text"` blocks, and the commit hash
from the worker's own state. No LLM call, no summarization model, no hallucination risk.

### Token cost

Each note is ~200-500 chars (~50-125 tokens). With `maxThreadEntries` at 20, a card with
20 prior sessions uses ~2.5k tokens of notes. Trivial within the 64k budget.

### Format in the context

```
## Card Thread

  - [verdict] [Test-Writing] fail: Session killed by the 75-minute max-runtime watchdog...
  - [note] Session 2026-09-08T15:58: touched tests/test_grid_combat.gd (write), scripts/sim/grid_combat.gd (read). Tests: 171/16 failed. HEAD: 824fb16. Remaining: writing test_melee_engagement, reached line 45 of the function.
```

### Implementation

In `worker.ts`'s `processCard`, after `commitCardWork` and before the verdict switch:
1. Parse the captured stdout for tool-call file paths and test-output lines.
2. Build the note string.
3. Call `dbStore.addCardThreadEntry({ cardId, entryType: "note", content })`.

The existing thread assembly in `context.ts` already includes `note` entries — no changes
needed there.

## Token budget composition

| Component                  | Tokens  | Source                                     |
|----------------------------|---------|--------------------------------------------|
| PROJECT.md                 | ~1,800  | always included                            |
| Card body + verdict JSON   | ~500    | column extras                              |
| Column prompt (with L2)    | ~800    | column extras (expanded)                   |
| Plan slices                | ~2,000  | plan doc if present                        |
| **Target files (L1)**      | **~8,000** | **card targets + test counterparts**    |
| Card thread (verdicts)     | ~1,500  | existing                                   |
| **Session notes (L3)**     | **~1,500** | **mechanical extracts**                 |
| **Total clockwork context**| **~16,100** |                                        |
| Pi overhead (tools/system) | ~25,000 | pi's own injection                         |
| **Available for conversation** | **~23,000** | **tool calls + generation**        |

23k conversation tokens = ~15-20 tool call round trips. With pre-loaded targets, those
calls are writes and godot runs — not reads — which is the desired shift.

## What stays unchanged

- Sessions are assembled fresh — no persistent conversation (locked design decision).
- The verdict contract (pass/fail/blocked JSON trailer).
- The retry/kickback flow + retry accounting.
- The watchdog (inactivity + max-runtime).
- The deliverable gate (targets checked against branch diff).
- The card thread's verdict entries (notes supplement, do not replace).
- The "machinery stays DUMB" principle — all three layers add data to the prompt, not
  agent-to-agent reasoning.

## Expected impact

- Layer 1 eliminates ~30 min of file reading per session.
- Layer 2 prevents ~10-15 min of wrong-column work and exploration.
- Layer 3 saves ~5-10 min of re-discovery on subsequent sessions.
- Net: a 75-min session that spends 40-50 min on overhead should spend ~10-15 min,
  leaving 60+ minutes for actual work.

## Implementation order

1. **Layer 1** (highest impact, moderate code): `loadTargetFiles` in context.ts +
   call site in worker.ts. Test-first.
2. **Layer 3** (mechanical, small code): session note extraction in worker.ts.
   Test-first.
3. **Layer 2** (zero code, data-only): update column prompts for bastion. Can ship
   immediately as a data change while L1/L3 are being built.
