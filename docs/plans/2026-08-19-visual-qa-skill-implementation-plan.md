# Visual-QA Skill — Implementation Plan (for clockwork to build)

**Date:** 2026-08-19
**Prereq (DONE, proven live):** the two hard primitives exist and work:
- `harness/render-on-studio.sh` + `harness/capture_helper.gd` — render a Godot scenario on
  studio's RTX 3060 (Xvfb+Vulkan), producing one PNG per state + `manifest.json`
  (`{captures:[{step,png,expect}]}`).
- Vision critique: `pi -p --provider frame-dense-low @<png> "<prompt>"` returns an accurate,
  structured `{"verdict","feedback"}` — passes matches, fails mismatches. Verified adversarially.

**What clockwork builds (this plan):** the *glue* that turns those primitives into an automated
visual-QA column — a **`visual-qa` skill** the worker loads on a QA card, which renders the
project's scenario on studio, pulls the frames, critiques each against its expected description
via the frame vision model, and emits ONE aggregate structured verdict.

This is a normal clockwork skill + column config. It does NOT change clockwork's core.

## The pieces to build (each a card, TDD where the stack allows)

### 1. `visual-qa` skill (a pi skill bundle)
`harness/skills/visual-qa/SKILL.md` + a runner script. The skill instructs the QA agent to:
1. Locate the project's scenario script (`tests/visual/*.gd`, convention below).
2. Run the render on studio via SSH (see card 2), giving it the project dir + scenario + an
   out dir on a path shared with serve.
3. Read `manifest.json`; for each capture, call the vision model with the exact prompt shape
   proven in the prereq (image + "Expected: <expect>. Reply ONLY JSON {verdict,feedback}").
4. Aggregate: if ALL captures pass -> overall `pass`; if ANY fails -> overall `fail` with the
   per-state feedback for the failing states; if a state can't be rendered/critiqued ->
   `blocked` with why.
Acceptance: given a manifest with 2 captures, the skill produces one aggregate verdict; a single
failing state makes the whole card fail with that state's feedback named.

### 2. serve->studio render transport
A script (`harness/dispatch-render.sh`) the skill calls: `rsync`/`scp` the project to studio,
run `render-on-studio.sh` over SSH, `rsync` the out dir (PNGs + manifest) back to a serve path
the QA agent can read. Handle studio-asleep: if SSH to studio fails, emit `blocked` ("render
host studio unreachable") — do NOT fail the card (the card re-queues; studio-sleeps is tolerated
by design). Acceptance: with studio up, a project dir round-trips and PNGs come back; with studio
down, the skill returns a clean `blocked`, not a crash.

### 3. Scenario convention + a starter scenario
Document the convention in the game's `PROJECT.md`/`AGENTS.md`: visual scenarios live at
`tests/visual/<name>.gd`, are SceneTree scripts that `preload("res://harness/capture_helper.gd")`,
reach each state, and call `Capture.grab(self, step, expect)` then `Capture.finish(); quit()`.
The game repo vendors `harness/capture_helper.gd` (copied from clockwork's harness). Build a
starter `tests/visual/smoke.gd` that renders the game's main scene and captures one frame with a
sensible `expect`. Acceptance: `render-on-studio.sh` on the game repo produces a PNG + manifest.

### 4. Wire a `Visual-QA` column into the default pipeline
Add a `Visual-QA` column (after `QA`, before `Deploy`) to the bootstrap default columns, with the
`visual-qa` skill in its `skills` and a prompt telling the agent to run the visual scenario and
judge it. Keep the existing text `QA` column for logic/build verification — `Visual-QA` is the
*visual* gate. Acceptance: a project bootstrapped after this has the Visual-QA column with the
skill attached.

### 5. Attempt artifacts include the screenshots
The QA attempt should reference the captured PNGs (copy them into the card's
`transcripts/<project>/<card>/attempt-N/` dir) so a human can see exactly what the vision model
judged at a check-in. Acceptance: after a visual-QA run, the attempt dir contains the PNGs + the
per-state verdicts.

## Notes / constraints for the implementer
- The vision prompt shape is PROVEN — reuse it verbatim; do not invent a new one.
- Render host is **studio** for now (a serve 1080 is a future swap — see the exocortex inbox item);
  keep the host in one config constant so the swap is one line.
- Everything the worker runs must degrade to `blocked` (never crash) when studio is unreachable.
- Reuse the existing structured-verdict contract + parser — the vision critique already emits it.

## Definition of done for the whole harness (Phase 1 milestone)
A clockwork project with a trivial Godot scene flows a card through `Visual-QA`: the scene is
rendered on studio, screenshotted, the frame vision model judges it against the expected
description, and the card passes (or fails with real visual feedback) — end to end, autonomously.
Tag `phase-1` when this works.
