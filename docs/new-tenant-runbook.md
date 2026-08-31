# New Tenant Runbook — starting a project on clockwork

How to onboard a new product (a "tenant") onto the clockwork pipeline. Generalized from the
prism-drift precedent (the first tenant, a Godot mobile game). The platform machinery is
tenant-agnostic; the verification harness and the authoring conventions are where each tenant
does real setup work.

Design authority: `docs/plans/2026-08-17-clockwork-design.md` (decision 13: no template — the
director creates projects/columns/plans/cards via the API). Card-field details live in
`AGENTS.md` (authoring cards) and in the exocortex skill
`.opencode/skill/clockwork-card-authoring/` — keep all three in sync (see "Documentation
upkeep" in `AGENTS.md`).

## Phase 1 — Design (human + director, before any board work)

1. **Brainstorm the product into a design doc** (`docs/plans/YYYY-MM-DD-<thing>-design.md` in
   the tenant repo). This is the CONTRACT: pinned rules the pipeline may not violate,
   resolution/interaction semantics, starting values. The M1 lesson is absolute: clockwork
   builds exactly what the cards say — if the design is not in the contract, it does not
   exist. For a multi-layer app (schema / API / frontend), the contract MUST pin the
   interfaces between layers (schema shapes, endpoint request/response bodies) the same way a
   game design pins rules, because separate cards will build each side of every interface.
2. **Write the milestone implementation plan** (writing-plans discipline): each TASK becomes
   ONE card, scoped to a single worker session (one component / one endpoint / one screen).
   Every task lists **Files:** (these become card `targets`) and binary acceptance criteria
   (these are what Code-Review and QA check). Order tasks by dependency; the order becomes the
   `depends_on` chain.

## Phase 2 — Tenant repo scaffold (hand-done once)

3. Create the GitHub repo; register it as an exocortex submodule under `code/projects/`.
4. Write **`PROJECT.md`** — the durable agent brief and tier 1 of every session's context:
   vision + design-doc pointer, non-negotiable conventions, code standards, definition of
   done, the canonical verify sequence (the exact commands a worker must run and see pass),
   repository layout, current milestone.
5. Write **`AGENTS.md`** (thin: "Read PROJECT.md first" + a command table), the test harness
   the verify sequence runs, and CI.
6. Ensure the bare origin exists on the clockwork host: `scripts/ensure-bare-origin.ts`
   handles `$CLOCKWORK_REPOS/<project>` at deploy.

## Phase 3 — Board bootstrap

7. `bun scripts/bootstrap-project.ts <name> <github-repo>` — creates the project row and the
   9 default columns (Backlog, Impl-Planning, Implementation, Code-Review, QA, Deploy, Done,
   Needs-Human, Needs-Director) with the standards-encoded prompts and the dense model on the
   doer/verifier columns. It creates NOTHING else — no cards, no PROJECT.md, no scenarios.
8. **Tune columns per-tenant** via `PUT /api/columns/:id`: attach the tenant's QA skill to the
   QA column (`skills: ["<path in tenant repo>/SKILL.md"]`), and adjust prompts if the stack
   needs stack-specific discipline (prism-drift's Implementation prompt hard-requires
   timeout-wrapped godot commands; a web tenant's should hard-require the equivalent, for
   example a bounded dev-server lifecycle).
9. **Repoint the project at the local mirror** — `bootstrap-project.ts` registers the project
   with the GitHub URL directly, but the working pattern (prism-drift, project-bastion) is a
   local bare mirror clockwork fetches from, with GitHub as the sync upstream:
   `git clone --bare git@github.com:<owner>/<repo>.git ~/.clockwork-data/repos/<name>`, then
   `PUT /api/projects/:id` with **snake_case** fields
   `{"github_repo": "file:///home/<user>/.clockwork-data/repos/<name>", "github_upstream":
   "git@github.com:<owner>/<repo>.git"}` (camelCase is silently ignored). The per-project
   workspace clone is created automatically on the first claim (since `182ddac`; before that
   fix the fail-closed sync check ran before the clone existed and the first card of every
   new tenant parked at Needs-Director).
10. **Switch the worker to the tenant** — the worker serves ONE project, pinned by
    `CLOCKWORK_WORKER_PROJECT_ID` in the studio user unit
    (`~/.config/systemd/user/clockwork.service`); also update `CLOCKWORK_MILESTONE_LABEL` and
    the `CLOCKWORK_BUILD_COPY_COMMAND` workspace path. Before restarting, PROVE the worker is
    idle (`/proc/<bunpid>/task/*/children` empty — see "Diagnosing a stuck card" in
    AGENTS.md); a restart kills any live session.

## Phase 4 — Verification harness (per-tenant, NOT clockwork core)

9. Build the tenant's visual/functional QA skill inside the tenant repo. The prism-drift
   pattern: a pi skill (`tools/visual-qa-skill/SKILL.md`) that renders the real artifact and
   gets a vision-model verdict, with per-card scenario files
   (`scenarios/<CLOCKWORK_CARD_ID>.yaml`, falling back to `scenarios/main.yaml`). Web
   equivalent: Playwright (or similar) screenshots of the running page fed to the same vision
   verdict — same scenario-file convention. This visual feedback loop is a large part of why
   prism-drift worked; do not skip it for user-facing cards.

## Phase 5 — Card authoring (the highest-leverage step)

10. The director translates plan tasks into cards. **Follow the clockwork-card-authoring
    skill** — it carries the field-by-field requirements (`column_id`, `title`, `body` with the
    CONTRACT header, `targets`, `depends_on`, `scenario`) and the failure modes each field
    prevents. The chain endpoint (`POST /api/projects/:id/cards/chain`) queues a linear plan in
    one call with auto-chained dependencies.
11. Watch the first cards flow; tune column prompts as data. Fix machinery when cards wedge —
    never hand-write product (the governing rule).

## Known gaps for a multi-layer web tenant (versus prism-drift)

- **Layer discipline:** cards must state which layer they live in and cite the contract
  section that pins the interface they implement or consume.
- **Session runtime:** migrations, a dev server, and seeded data make Implementation/QA
  sessions heavier than godot-headless; the verify sequence in PROJECT.md must be fully
  scripted and bounded (timeouts) so a hung server cannot wedge a session.
- **Deliverable-gate extensions:** the `targets` parser recognizes common extensions; confirm
  the tenant's file types are covered (`src/targets.ts`) before authoring cards.
