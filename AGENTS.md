# clockwork — AGENTS.md

Kanban-state-machine build platform. Bun + TypeScript, SQLite (WAL), websockets, pi workers
against frame local models. Built strictly test-first.

## Source of truth

`docs/plans/2026-08-17-clockwork-design.md` holds every locked decision (19 of them) — read it
before changing behavior; do not re-litigate settled decisions without cause. The phased build
order is `docs/plans/2026-08-17-clockwork-implementation-plan.md`.

## Commands

| Command | Purpose |
|---------|---------|
| `bun install` | Install dependencies |
| `bun run check` | **The gate: `tsc --noEmit` + `bun test`.** Run this before committing. |
| `bun test` | Run the test suite only |
| `bun run typecheck` | Type-check only (`tsc --noEmit`) |

**Always run `bun run check`, not just `bun test`.** A green test suite alone once hid 145
type errors and a completely unwired integration layer (`index.ts` didn't compile; the worker
never assembled context, recorded attempts, or respected park columns). Type-check is
non-negotiable.

## Non-negotiables (from the design)

- The machinery stays DUMB — intelligence lives in column prompts (data), written plans, and
  verifier stages. No agent-to-agent reasoning.
- Workers never self-certify; verdicts drive card movement; malformed verdict = blocked.
- Sessions are short and assembled fresh (tiered, token-budgeted context) — never a long
  shared conversation.
- Kickback carries feedback; retry counter (3) parks cards at needs-human. No infinite loops.
- Model calls go through the frame-arbiter LOW ports — clockwork is background work by
  definition; Hugo preempts it.
- exocortex's brain/graph is out of bounds — clockwork has its own per-project markdown memory.

## Style

TypeScript, ES modules, `function` declarations top-level, explicit return types on exports,
no nested ternaries, tabs. Same conventions as frame-arbiter.
