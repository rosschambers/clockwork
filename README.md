# clockwork

A lightweight autonomous build platform: a kanban board as a state machine. Cards flow through
**prompt-defined columns**; a single worker loop runs **pi** sessions against frame's local
models (via the frame-arbiter's low-priority ports) to implement and verify each stage; humans
watch a live web board; a director agent (Opus/Fable) plans and steers through the API at
periodic check-ins.

- **Design:** `docs/plans/2026-08-17-clockwork-design.md`
- **Implementation plan:** `docs/plans/2026-08-17-clockwork-implementation-plan.md`

Status: design complete, implementation not started.
