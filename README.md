# clockwork

A lightweight autonomous build platform: a kanban board as a state machine. Cards flow through
**prompt-defined columns**; a single worker loop runs **pi** sessions against frame's local
models (via the frame-arbiter's low-priority ports) to implement and verify each stage; humans
watch a live web board; a director agent (Opus/Fable) plans and steers through the API at
periodic check-ins.

## Quickstart

What you need:

- **[Bun](https://bun.sh)** — runtime for the board server and worker loop.
- **The [pi](https://github.com/earendil-works/pi) agent runtime** (`@earendil-works/pi-coding-agent`) —
  the worker spawns `pi` sessions to do the actual coding.
- **Any OpenAI-compatible model endpoint** — a local llama-server, Ollama, vLLM, or a hosted
  API. Point pi at it via a provider entry in `~/.pi/agent/models.json`
  (see `docker/pi-models.json` for the shape; replace `your-model-host` with your endpoint).

Run the board plus one worker locally:

```bash
bun install
cp .env.example .env            # set CLOCKWORK_TOKEN at minimum
bun run src/index.ts            # board + API on http://localhost:3000
```

Create a project through the API (or `scripts/bootstrap-project.ts`), then set
`CLOCKWORK_WORKER_PROJECT_ID=<project-id>` in the environment and restart — the same process
runs the worker loop for that project, claiming cards and running pi sessions against your
model endpoint. `bun run check` (typecheck + tests) is the development gate.

For the Docker path, copy `docker/pi-models.json` to `docker/pi-models.local.json`
(untracked), fill in your real model endpoint, and build — the Dockerfile prefers the local
file.

> **Honesty note:** this project was built for a personal homelab (a specific GPU host, a
> priority-arbiter proxy in front of local llama-server instances, tailnet-only binding,
> SMS webhooks). It works anywhere Bun + pi + an OpenAI-compatible endpoint exist, but some
> docs — especially `docs/plans/` and the deploy notes — reflect that original environment
> and mention hosts and services you will not have. Read them as a worked example, not as
> requirements.

- **Design:** `docs/plans/2026-08-17-clockwork-design.md`
- **Implementation plan:** `docs/plans/2026-08-17-clockwork-implementation-plan.md`
- **Implementation reference (current code):** `docs/impl-ref.md`
- **Card authoring (incl. `depends_on` dependency ordering):** `AGENTS.md`

Status: built and running. Deployed as a `systemd --user` service on the `studio` host,
building the prism-drift game project. Core pipeline (prompt-defined columns, single pi worker,
verdict-driven movement, live board, notifications), per-card git isolation (branch → commit →
merge-on-Done), dependency-aware scheduling (`depends_on`), SMS notifications, and a visual-QA
skill (GPU render → vision verdict) are all live. See `docs/impl-ref.md` for the current shape.
