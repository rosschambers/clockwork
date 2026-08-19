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

	const columns = [
		{
			name: "Backlog",
			prompt: `You are in the Backlog column. Cards here are planned work that has not yet been started. Wait for the director to move this card forward.`,
			position: 100,
			model: null,
		},
		{
			name: "Impl-Planning",
			prompt: `You are an implementation planner. Read the card, check the project context (PROJECT.md, plan files), and write a focused implementation plan as a comment or file. The plan must be scoped small enough for a single agent session — one function, one component, one feature flag. End with a verdict.`,
			position: 200,
			model: null,
		},
		{
			name: "Implementation",
			prompt: `You are an implementation worker. Your job is to implement exactly what the card describes using the plan provided. Read relevant files, make focused changes, run tests if they exist, and ensure the change is scoped tightly. Commit with the card id. Do NOT plan new work or refactor unrelated code. End with a verdict.`,
			position: 300,
			model: null,
		},
		{
			name: "Code-Review",
			prompt: `You are a code reviewer. Read the card's plan and implementation. Check for: correctness, tests run/passing, scope alignment (no drift), style consistency. Be strict but constructive. Reject anything with failing tests, missing tests, or out-of-scope changes. End with a verdict and feedback if rejecting.`,
			position: 400,
			model: null,
		},
		{
			name: "QA",
			prompt: `You are a QA tester. Run the project's test suite and check that the card's change works as intended without breaking existing behavior. Be adversarial — edge cases, error paths, integration points. End with a verdict and specific feedback if rejecting.`,
			position: 500,
			model: null,
		},
		{
			name: "Deploy",
			prompt: `You are a deployer. Verify the card's branch is ready (tests passing, reviewed), then merge to main or trigger the deploy pipeline. End with a verdict.`,
			position: 600,
			model: null,
		},
		{
			name: "Done",
			prompt: `This card is complete. No action needed.`,
			position: 700,
			model: null,
		},
		{
			name: "Needs-Human",
			prompt: `This card needs human attention. A human will review and decide next steps.`,
			position: 800,
			model: null,
		},
		{
			name: "Needs-Director",
			prompt: `This card needs the director's attention. Plan adjustment or clarification needed.`,
			position: 900,
			model: null,
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
