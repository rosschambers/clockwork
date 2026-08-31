# Investigation: Implementation stage "writes a plan doc, not code" + intermittent pi `exit 1` empty transcripts

**Date:** 2026-08-21
**Scope:** INVESTIGATION ONLY. Nothing operational was changed — no service restart, no
cards unclaimed/moved/re-queued, no code edits, no re-queue. This document reports evidence
and root cause; a separate "Recommended fixes" section lists options but implements none.
The only writes performed were read-only DB queries (`bun:sqlite` opened `readonly`) and one
throwaway curl/pi request in `/tmp` to reproduce the 503.

**Companion doc:** `2026-08-20-pi-hang-investigation.md` covered the *exit 124* watchdog-kill
empty transcript. This is a **different, separate failure — exit 1**. exit 124 did NOT occur
in this run; every failing attempt here is exit 1. The two do not contradict.

**Subject:** project `a2afe5dc-1459-4201-9a7d-90152b4ab7e9` (prism-drift), card
`f2161b35-333c-481c-927b-ebaeea450436` — "Render: layout foundation + palette". Card now
parked in **Needs-Human** (retry count 3 ≥ max 3).

---

## TL;DR (bottom line up front)

**The two reported failures are one compounding failure, and (A) is a misdiagnosis of the
symptom.** The card never wrote code because the **Implementation stage never once ran the
model successfully** — every Implementation attempt died with
`503 preempted by higher-priority request` (empty stdout, exit 1). The only *successful*
attempts on this card were **Impl-Planning** attempts, and Impl-Planning's job **is** to write
a plan note (`docs/plans/task-render1-layout-foundation-impl-note.md`). So the "plan doc
instead of code" commits are correct Impl-Planning output; they are not the Implementation
stage misbehaving. The card ping-ponged Impl-Planning → Implementation → (503 kickback) →
Impl-Planning → … three times, exhausting retries, and parked — with the deliverable
(`scripts/main.gd` edits) never attempted.

- **(A) root cause:** *There is no plan-vs-code confusion.* The plan-note commits come from the
  **Impl-Planning** column (which is *supposed* to write a plan note). Implementation produced
  **zero** attempts that reached the model — all six-minus-three real attempts are Impl-Planning
  passes; all three Implementation attempts are 503-empty. `scripts/main.gd` is **unchanged vs
  main** on the card branch (0 card-authored edits). The board is behaving exactly as its prompts
  say; the pipeline is just never getting a live Implementation run to complete. **Confidence:
  High.**
- **(B) root cause:** **frame-arbiter preemption.** clockwork runs on the arbiter LOW port
  (`frame-dense-low` → `http://frame…:8185/v1`). Any HIGH (Hugo/murmur8) request preempts ALL
  in-flight LOW jobs (one global GPU lane), returning a buffered `503 preempted by
  higher-priority request` with header `x-arbiter-preempted: true`. pi surfaces that 503 as
  **exit 1 with empty stdout and no retry**. Reproduced deterministically. It hits Implementation
  and not Impl-Planning because Implementation is a **long multi-turn agentic session** (many
  sequential LOW model calls over ~40 min) — a much larger window in which some Hugo request
  preempts one of its calls — whereas Impl-Planning is a short single-pass write that usually
  completes between HIGH requests. **Confidence: High** (deterministic repro + the exact 503
  bytes are in the transcripts and are emitted ONLY on preemption).

---

## Evidence

### The attempt sequence (the smoking gun)

Read-only query of the clockwork SQLite (`/home/<user>/.clockwork-data/db/clockwork.sqlite`,
opened `readonly`) joining `attempts.verdict.columnId` → column name, chronological:

```
column=Impl-Planning   verdict=pass     file=attempt-1787318989946.txt  "Plan written to docs/plans/task-render1-layout-foundation-impl-note.md…"
column=Implementation  verdict=blocked  file=attempt-1787321526532.txt  "The transcript is empty…"
column=Impl-Planning   verdict=pass     file=attempt-1787321701211.txt  "Plan at …impl-note.md is committed and re-verified…"
column=Implementation  verdict=fail     file=attempt-1787323102503.txt  "The transcript is empty…"
column=Impl-Planning   verdict=pass     file=attempt-1787323264006.txt  "Plan at …impl-note.md is committed and re-verified…"
column=Implementation  verdict=blocked  file=attempt-1787324013929.txt  "The agent transcript is empty…"
```

Pattern: **Impl-Planning pass → Implementation 503-empty → kickback → Impl-Planning pass →
Implementation 503-empty → …** three cycles, then retry ceiling → Needs-Human. The three
Implementation attempts are exactly the three 74-byte transcripts; the three Impl-Planning
attempts are the three "real" ones.

Every Implementation transcript is identical (`cat` on studio):

```
# exit 1

## stdout


## stderr
503 preempted by higher-priority request
```

The three Impl-Planning transcripts each end in a `pass` verdict whose `feedback`/`artifacts`
are the plan note — e.g. attempt-1787318989946:

> `Plan written to docs/plans/task-render1-layout-foundation-impl-note.md. Summary: … `
> `{"verdict": "pass", …, "artifacts": ["docs/plans/task-render1-layout-foundation-impl-note.md"]}`

The later two literally announce themselves as planning, not implementation:

> attempt-1787321701211: *"The plan from the prior **Impl-Planning** pass stands and I verified
> it against the live repo… **DoD is checkable**…"*
> attempt-1787323264006: *"Re-verified the existing plan note… **confirming it for the
> implementer**."*

### (A) The card body and prompts are correct — nothing tells Implementation to write a plan

- **Card body** (`GET /api/projects/…/cards`): *"Implement Task 1 in
  docs/plans/2026-08-20-m1-themed-render-plan.md: palette constants + the single
  cell_rect(col,row) function… Only main.gd / project.godot / main.tscn. …a broken/misplaced
  grid will FAIL this card."* — an implement instruction, not a plan instruction.
- **Implementation column prompt** (`GET /api/projects/…/columns`): *"You are an IMPLEMENTATION
  worker. Implement exactly what the card + its plan describe… Work on the card branch, commit
  with the card id… Not done until it builds and tests pass…"* — never says "write a plan note."
- **Impl-Planning column prompt:** *"You are an implementation PLANNER… Produce a small,
  concrete implementation plan for THIS card only, written to the repo (e.g. a short markdown
  note the implementer will read)… Do NOT write implementation code here. Plan only."* — this
  is the column that (correctly) produced the impl-note.
- **The many `docs/plans/*-impl-note.md` files are not a repo convention the model is imitating**
  — they are the direct, designed output of this board's Impl-Planning stage.

**Workspace ground truth** (`/home/<user>/.clockwork-data/workspaces/a2afe5dc…`, branch
`card/f2161b35…`):

```
git log --oneline -3
  683035e clockwork: f2161b35… (Impl-Planning)
  b895fef clockwork: f2161b35… (Impl-Planning)
  23ab0e1 visualqa4-skill: …            ← parent/main, unrelated

git diff --name-only main
  docs/plans/task-render1-layout-foundation-impl-note.md
  tools/visual-qa-skill/capture.gd.uid   ← inherited from branch base, not card work

git diff --stat main -- scripts/main.gd   → (empty; main.gd UNCHANGED by the card)
```

Both card-authored commits are tagged `(Impl-Planning)`. **There is no `(Implementation)`
commit** — because every Implementation attempt returned a `blocked`/`fail` verdict, and the
worker skips the commit on `blocked` (`worker.ts:563`, `verdict !== "blocked"`) and a `fail`
run changed nothing anyway. The `cell_rect`/`PALETTE` tokens that *do* appear in `main.gd` are
from an earlier unrelated task (`839b95f task8-minimal-render`) on main, not this card.

**Is the correct plan in the assembled context?** Partly, and it doesn't matter for this bug:
`worker.ts:459` calls `assembleContext({ planFiles: [] … })`, so the `## Plan` section is
**always empty** — the render plan `docs/plans/2026-08-20-m1-themed-render-plan.md` is **never
injected** into the prompt. The model only sees the card body's *reference* to that path and
must open it from the working directory itself (it is present in the workspace, 9568 bytes, and
its Task 1 is a complete code-ready spec). This is a latent weakness (see fixes) but is NOT the
cause of the plan-doc symptom — the plan-doc comes from Impl-Planning doing its job, and
Implementation never ran far enough to read anything.

### (B) The 503 is arbiter preemption, reproduced deterministically

- **Provider config is valid** (`/home/<user>/.clockwork-home/.pi/agent/models.json`):
  `frame-dense-low` → `http://frame…:8185/v1`, model `Qwen3.8-27B-Uncensored-Q4_K_M.gguf`.
  Implementation column: `model=Qwen3.8-27B…`, `skills=[]` (no `--skill`, no bad `--model`).
- **pi itself is fine.** Manual run as the worker does it
  (`HOME=/home/<user>/.clockwork-home`, `pi -p --provider frame-dense-low "Reply with exactly
  the word: OK"` in `/tmp`) → **exit 0, output `OK`**. So exit 1 is not a bad arg, missing
  model, or pi crash-on-prompt.
- **Forced-preemption repro** (throwaway curl on studio): fire a long LOW request at port 8185,
  then 3 s later a HIGH request at port 8085 (same dense model):

  ```
  HIGH_HTTP=200
  LOW_HTTP=503
  low body: preempted by higher-priority request
  ```

  Identical bytes to the failing Implementation transcripts.
- **The 503 string is emitted ONLY on preemption.** `frame-arbiter/src/arbiter.ts:66-71`
  `preemptedResponse()` returns exactly `"preempted by higher-priority request"`, status 503,
  header `x-arbiter-preempted: true`. Arbiter design (its AGENTS.md): *"any high request
  preempts ALL running low jobs across every model"*, *"Low responses are buffered — so a
  mid-generation preemption is reported as a clean 503"*. A LOW job stays cancellable for its
  **whole** backend round-trip.
- **Why Implementation and not Impl-Planning:** the Implementation attempts ran long
  (attempt-1787321526532: started 13:29:49, returned 14:12:06 = **~42.6 min**) — a long
  multi-turn agentic session making many sequential LOW model calls. Each call is independently
  preemptable; over 40 minutes the probability that *some* Hugo/murmur8 request lands during one
  of them approaches certainty. Impl-Planning is a single short write (2–3 min) that usually
  slips between HIGH requests. Arbiter `/status` at investigation time: `lowInFlight:0`, healthy.
- **The worker never reacts to exit 1.** `invokePi` returns `exitCode: 1` but `processCard`
  only special-cases the watchdog (`exitCode: timedOut ? 124 …`, `worker.ts:180`); otherwise it
  just runs `parseVerdict(result.stdout)` on empty stdout → `blocked`, then kickback
  (`worker.ts:504`, `581-589`). So a preemption silently **consumes a retry** and is
  indistinguishable downstream from "model produced no verdict." Three preemptions = card
  parked at Needs-Human.

---

## Recommended fixes (NOT implemented — options with confidence)

### For (A) — make the pipeline actually reach a live Implementation run, and prove the deliverable exists

1. **[Highest leverage] Treat a preemption 503 as a *retryable transient*, not a stage failure
   (fixes A by fixing B).** Since A is entirely caused by B, the single most valuable change is
   to stop counting preemptions as verdicts/retries — see (B) fix 1. Once Implementation gets to
   *complete* a run, the plan-doc-instead-of-code symptom disappears on its own. **Confidence:
   High that this resolves the observed card.**
2. **Add a deliverable-exists gate in Code-Review/QA (defense in depth).** The Implementation
   prompt already forbids scope drift, but nothing asserts the *target files changed*. Add to the
   Implementation prompt an explicit self-check ("`git diff --name-only` MUST include
   `scripts/main.gd`; emit `fail` if your only changes are under `docs/`"), and to Code-Review a
   hard reject if the card's named target file is unchanged. This catches any future
   "planned-but-didn't-implement" regardless of cause. **Confidence: Medium-High.**
3. **Feed the real plan into context.** `worker.ts` passes `planFiles: []`, so
   `assembleContext`'s `## Plan` tier is dead code in production and the render plan is never
   injected — the model must discover and open it. Wire the card's referenced plan slice (or the
   file the card body names) into `planFiles` so the implementer is handed Task 1's acceptance
   criteria directly. **Confidence: Medium** (a robustness improvement; not the current root
   cause).

### For (B) — the pi exit-1 empty-transcript preemption

1. **[Highest leverage] Retry on arbiter preemption inside `invokePi` (or the worker) instead of
   emitting a verdict.** Detect it unambiguously: pi exit ≠ 0 with stderr containing `preempted
   by higher-priority request` (or, better, teach pi/the transport to read the
   `x-arbiter-preempted: true` header). On that signal, **do not** save an attempt, **do not**
   consume a retry, **do not** kick back — wait a short backoff and re-invoke the same stage.
   Preemption is *by design* on the LOW port; it must be transparent to card state.
   **Confidence: High** this is the correct fix and directly unblocks the card.
2. **Have pi retry the single preempted model call internally** (transport-level retry-on-503
   for `x-arbiter-preempted`), so a 40-minute agentic session survives a mid-session preemption
   instead of the whole session aborting on one cancelled call. Best long-term fix; larger
   change, lives in pi, not clockwork. **Confidence: High on correctness, lower on effort/scope.**
3. **Distinguish exit 1 from "no verdict" in the worker.** At minimum, when pi exits non-zero,
   record the attempt as an explicit `infrastructure-error` (not `blocked`) so it is visible and
   does not silently burn a retry. Weakest option alone (does not prevent the failure), but cheap
   observability. **Confidence: High it improves diagnosis; Low it fixes the card by itself.**

### Note on interaction with the exit-124 watchdog work

The prior `2026-08-20-pi-watchdog-streaming-plan.md` (inactivity watchdog + streaming) is
orthogonal but synergistic: streaming stdout would also make a preempted session's *partial*
output visible instead of an 82-byte empty file, aiding diagnosis. Neither the watchdog bump
nor streaming addresses the 503 itself — that needs a preemption-aware retry (B-1).
