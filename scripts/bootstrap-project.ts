#!/usr/bin/env bun
/**
 * Bootstrap a new project via the clockwork API.
 * Creates: project, initial columns, example plan files.
 *
 * Usage:
 *   bun scripts/bootstrap-project.ts <name> <github-repo>
 *   bun scripts/bootstrap-project.ts my-game git@github.com:me/my-game.git
 *
 * ENV:
 *   CLOCKWORK_API_URL  — API base (default: http://localhost:3000)
 *   CLOCKWORK_TOKEN    — auth token if required
 */

const apiUrl = process.env.CLOCKWORK_API_URL ?? "http://localhost:3000"
const token = process.env.CLOCKWORK_TOKEN ?? null

function authHeader(): Record<string, string> {
	return token ? { Authorization: `Bearer ${token}` } : {}
}

async function fetchJson(path: string, method: string, body?: unknown): Promise<any> {
	const url = `${apiUrl}${path}`
	const res = await fetch(url, {
		method,
		headers: { "Content-Type": "application/json", ...authHeader() },
		body: body ? JSON.stringify(body) : undefined,
	})
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`${res.status} ${res.statusText}: ${text}`)
	}
	const data = await res.json()
	console.log(`  ${method} ${path} -> ${JSON.stringify(data)}`)
	return data
}

async function bootstrap(name: string, githubRepo: string) {
	console.log(`Creating project: ${name} (${githubRepo})`)

	// Create project
	const project = await fetchJson("/api/projects", "POST", {
		name,
		description: `Project: ${name}`,
		github_repo: githubRepo,
		branch: "main",
	})
	const projectId = project.id
	console.log(`Project created: ${projectId}`)

	// Define initial columns (from design doc's pipeline shape)
	// Backlog -> Impl-Planning -> Implementation -> Code-Review -> QA -> Deploy -> Done
	// + Needs-Director / Needs-Human park columns

	// The default, game-agnostic pipeline. Prompts encode the project's standing
	// principles (TDD, scope tightly, "green ticket != done — verify in the real
	// artifact", workers never self-certify). DENSE = frame's Qwen3.8 27B via the
	// arbiter low port (clockwork's default provider); doer + verifier columns use
	// it. Park/terminal columns need no model.
	const DENSE = "Qwen3.8-27B-Uncensored-Q4_K_M.gguf"
	const columns = [
		{
			name: "Backlog",
			prompt: `Backlog: planned work not yet started. No action — the director moves cards forward from here. If you are ever run on a Backlog card, emit verdict "blocked" with feedback "backlog card, awaiting director".`,
			position: 100,
			model: null,
			skills: [],
		},
		{
			name: "Impl-Planning",
			prompt: `You are an implementation PLANNER. Read the card and the project context (PROJECT.md + any plan slice provided). Produce a small, concrete implementation plan for THIS card only, written to the repo (e.g. a short markdown note the implementer will read). Rules:
- Scope tightly: one function / one component / one screen. If the card is too big to do in one focused session, say so and emit "fail" with feedback proposing a split (the director will re-slice).
- Prefer the simplest approach that works; reuse existing patterns/components in the repo over inventing new ones.
- State the definition of done for this card as a checkable condition (a command that must pass, a file that must exist, an observable behaviour).
- Do NOT write implementation code here. Plan only.
Emit "pass" when the plan is written and scoped; "fail" if it must be re-scoped; "blocked" if the card is ambiguous.`,
			position: 200,
			model: DENSE,
			skills: [],
		},
		{
			name: "Implementation",
			prompt: `You are an IMPLEMENTATION worker. Implement exactly what the card + its plan describe. Rules:
- Test-driven where the stack supports it: write/adjust the test first, watch it fail, then make it pass. Run the tests.
- Make focused changes only. Do NOT refactor unrelated code, do NOT expand scope, do NOT start new work.
- Reuse existing patterns, components, and utilities in the repo. Match the house code style.
- Work on the card's branch and commit with the card id in the message.
- A change is not done until it actually builds and its tests pass — verify, do not assume.
Emit "pass" with the artifacts you changed when the implementation is complete and tests pass; "fail" if you hit a wall the implementation can't clear; "blocked" if the plan is wrong or missing.`,
			position: 300,
			model: DENSE,
			skills: [],
		},
		{
			name: "Code-Review",
			prompt: `You are a strict CODE REVIEWER, separate from the implementer — you do NOT rubber-stamp. Read the card, its plan, and the actual diff/implementation. Reject (verdict "fail") if ANY of these hold, naming the specific problem in feedback:
- tests are missing, not run, or failing;
- the change drifts beyond the card's scope, or refactors unrelated code;
- it reinvents something the repo already provides, or adds needless complexity/dependencies (prefer the leanest solution);
- it doesn't match the house style, or leaves the build broken.
"A green checkbox is not done" — judge the actual code, not the claim. Emit "pass" only if the change is correct, tested, in-scope, and clean; otherwise "fail" with actionable feedback.`,
			position: 400,
			model: DENSE,
			skills: [],
		},
		{
			name: "QA",
			prompt: `You are an adversarial QA tester, separate from the implementer and reviewer. Verify the card's change WORKS in the real artifact, not just that a check went green. Rules:
- Run the project's full test/build and confirm it passes from ground truth (read the actual output).
- Probe edge cases, error paths, and integration points the card touches.
- Where the change is user-facing, verify the real behaviour (the built app / the actual screen), not a headless proxy for it.
Emit "pass" only when you have positively confirmed the change works and nothing regressed; "fail" with the exact reproduction + observed vs expected if it does not; "blocked" if you cannot run the verification (say why).`,
			position: 500,
			model: DENSE,
			skills: [],
		},
		{
			name: "Deploy",
			prompt: `You are a DEPLOYER. Only act on cards that passed review AND QA. Verify the branch is ready (tests green, reviewed), then merge to main / trigger the project's build-and-ship pipeline as defined in PROJECT.md. Verify the deploy landed from ground truth (the pipeline succeeded, the artifact exists) — never from a "done" reply. Emit "pass" once the change is shipped and verified; "fail" if the deploy fails (include the error).`,
			position: 600,
			model: DENSE,
			skills: [],
		},
		{
			name: "Done",
			prompt: `Terminal column: the card is complete and shipped. No action.`,
			position: 700,
			model: null,
			skills: [],
		},
		{
			name: "Needs-Human",
			prompt: `Park column (OFF the pipeline): this card is stuck or needs a human judgement call (retry-exhausted, or a subjective "is this good/fun" verdict). A human decides next steps. No agent action.`,
			position: 800,
			model: null,
			skills: [],
		},
		{
			name: "Needs-Director",
			prompt: `Park column (OFF the pipeline): this card needs the director (planning judgement, re-scoping, clarification). The director handles it at a check-in. No worker action.`,
			position: 900,
			model: null,
			skills: [],
		},
	]

	for (const col of columns) {
		await fetchJson(`/api/projects/${projectId}/columns`, "POST", col)
	}
	console.log(`Columns created: ${columns.length}`)

	// Return summary
	console.log(`\nProject "${name}" bootstrapped.`)
	console.log(`  ID: ${projectId}`)
	console.log(`  API: ${apiUrl}/api/projects/${projectId}`)
	console.log(`  Board: ${apiUrl}/`)
	console.log(`\nNext: Director creates cards via POST /api/projects/${projectId}/cards`)
}

const args = process.argv.slice(2)
if (args.length < 2) {
	console.log("Usage: bun scripts/bootstrap-project.ts <name> <github-repo>")
	console.log("Example: bun scripts/bootstrap-project.ts my-game git@github.com:me/my-game.git")
	process.exit(1)
}

bootstrap(args[0]!, args[1]!).catch((err) => {
	console.error("Error:", err.message)
	process.exit(1)
})
