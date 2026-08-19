import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { RepoWorkspace } from "./repo.ts"
import { DbStore } from "./db.ts"
import fs from "node:fs"

function makeTempDir(): string {
	return fs.mkdtempSync("/tmp/clockwork-repo-test-")
}

function cleanup(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true })
	} catch {
		// ignore
	}
}

function seedRemote(projectRoot: string): { remotePath: string; defaultBranch: string } {
	const remotePath = `${projectRoot}/remote-bare.git`
	fs.mkdirSync(remotePath)

	const workPath = `${projectRoot}/remote-work`
	fs.mkdirSync(workPath)

	const run = (args: string[], cwd?: string): void => {
		const p = Bun.spawnSync(["git", ...args], { cwd: cwd ?? workPath })
		if (p.exitCode !== 0) {
			const err = p.stderr ? new TextDecoder().decode(p.stderr) : ""
			throw new Error(`git ${args.join(" ")}: ${err.trim()}`)
		}
	}

	run(["init", "--bare"], remotePath)
	run(["init"])
	run(["config", "user.name", "test"])
	run(["config", "user.email", "test@test"])
	run(["remote", "add", "origin", remotePath])

	fs.writeFileSync(`${workPath}/README.md`, "# Test")
	run(["add", "."])
	run(["commit", "-m", "initial"])
	run(["push", "-u", "origin", "main"])

	cleanup(workPath)

	return { remotePath, defaultBranch: "main" }
}

async function prepareCard(
	ws: RepoWorkspace,
	projectRoot: string,
	projectId: string,
	cardId: string,
	githubRepo: string,
	defaultBranch: string,
): Promise<{ repoPath: string; branch: string }> {
	const result = await ws.prepareCardWorkspace(projectId, cardId, githubRepo)
	expect(result.repoPath).toBe(`${projectRoot}/${projectId}`)
	expect(result.branch).toBe(`card/${cardId}`)
	return result
}

describe("RepoWorkspace", () => {
	let projectRoot: string
	let store: DbStore

	beforeEach(() => {
		projectRoot = makeTempDir()
		const dbPath = `${projectRoot}/test.sqlite`
		store = new DbStore(dbPath)
		store.initialize()
	})

	afterEach(() => {
		store.close()
		cleanup(projectRoot)
	})

	describe("prepareCardWorkspace", () => {
		it("clones non-existent project -> creates workspace", async () => {
			const { remotePath } = seedRemote(projectRoot)
			const ws = new RepoWorkspace(
				{
					projectRoot,
					gitToken: "fake-token",
					defaultBranch: "main",
				},
				store,
			)

			const result = await prepareCard(ws, projectRoot, "proj-1", "card-1", `file://${remotePath}`, "main")

			expect(fs.existsSync(result.repoPath)).toBe(true)
			expect(fs.existsSync(`${result.repoPath}/.git`)).toBe(true)
		})

		it("clones existing project -> uses existing workspace", async () => {
			const { remotePath } = seedRemote(projectRoot)
			const ws = new RepoWorkspace(
				{
					projectRoot,
					gitToken: "fake-token",
					defaultBranch: "main",
				},
				store,
			)

			await ws.prepareCardWorkspace("proj-1", "card-1", `file://${remotePath}`)
			const firstStat = fs.statSync(`${projectRoot}/proj-1`)

			await ws.prepareCardWorkspace("proj-1", "card-2", `file://${remotePath}`)
			const secondStat = fs.statSync(`${projectRoot}/proj-1`)

			expect(firstStat.mtimeMs).toBe(secondStat.mtimeMs)
		})

		it("creates branch from default branch", async () => {
			const { remotePath } = seedRemote(projectRoot)
			const ws = new RepoWorkspace(
				{
					projectRoot,
					gitToken: "fake-token",
					defaultBranch: "main",
				},
				store,
			)

			const { branch, repoPath } = await prepareCard(
				ws,
				projectRoot,
				"proj-1",
				"card-1",
				`file://${remotePath}`,
				"main",
			)

			expect(branch).toBe("card/card-1")

			const p = Bun.spawnSync(["git", "branch", "--show-current"], {
				cwd: repoPath,
			})
			expect(p.exitCode).toBe(0)
			expect(
				p.stdout ? new TextDecoder().decode(p.stdout).trim() : "",
			).toBe("card/card-1")
		})
	})

	describe("commitCardWork", () => {
		it("commits with card id message", async () => {
			const { remotePath } = seedRemote(projectRoot)
			const ws = new RepoWorkspace(
				{
					projectRoot,
					gitToken: "fake-token",
					defaultBranch: "main",
				},
				store,
			)

			const { repoPath } = await prepareCard(
				ws,
				projectRoot,
				"proj-1",
				"card-1",
				`file://${remotePath}`,
				"main",
			)

			fs.writeFileSync(`${repoPath}/test.txt`, "changed")

			store.createProject({
				name: "Test Project",
				description: "",
				githubRepo: null,
				branch: null,
			})
			const project = store.createProject({
				name: "Test Project",
				description: "",
				githubRepo: null,
				branch: null,
			})
			const col = store.createColumn({
				projectId: project.id,
				name: "Implementation",
				prompt: "Implement.",
				skills: [],
				model: null,
				position: 0,
			})

			const result = await ws.commitCardWork(repoPath, "card-1", col.id)
			expect(result).toBe(true)

			const p = Bun.spawnSync(["git", "log", "-1", "--format=%s"], {
				cwd: repoPath,
			})
			expect(p.exitCode).toBe(0)
			const msg = p.stdout
				? new TextDecoder().decode(p.stdout).trim()
				: ""
			expect(msg).toContain("card-1")
		})
	})

	describe("pushCardBranch", () => {
		it("pushes card branch to origin", async () => {
			const { remotePath } = seedRemote(projectRoot)
			const ws = new RepoWorkspace(
				{
					projectRoot,
					gitToken: "fake-token",
					defaultBranch: "main",
				},
				store,
			)

			const { repoPath, branch } = await prepareCard(
				ws,
				projectRoot,
				"proj-1",
				"card-1",
				`file://${remotePath}`,
				"main",
			)

			store.createProject({
				name: "Test Project",
				description: "",
				githubRepo: null,
				branch: null,
			})
			fs.writeFileSync(`${repoPath}/change.txt`, "changed")

			const project = store.createProject({
				name: "Test Project",
				description: "",
				githubRepo: null,
				branch: null,
			})
			const col = store.createColumn({
				projectId: project.id,
				name: "Implementation",
				prompt: "Implement.",
				skills: [],
				model: null,
				position: 0,
			})
			await ws.commitCardWork(repoPath, "card-1", col.id)

			const result = await ws.pushCardBranch(repoPath, branch)
			expect(result).toBe(true)

			const p = Bun.spawnSync(["git", "branch", "-r"], {
				cwd: repoPath,
			})
			const output = p.stdout
				? new TextDecoder().decode(p.stdout)
				: ""
			expect(output).toContain(`origin/${branch}`)
		})
	})

	describe("multiple cards", () => {
		it("each card gets its own branch, no interference", async () => {
			const { remotePath } = seedRemote(projectRoot)
			const ws = new RepoWorkspace(
				{
					projectRoot,
					gitToken: "fake-token",
					defaultBranch: "main",
				},
				store,
			)

			const card1 = await prepareCard(
				ws,
				projectRoot,
				"proj-1",
				"card-1",
				`file://${remotePath}`,
				"main",
			)
			const card2 = await prepareCard(
				ws,
				projectRoot,
				"proj-1",
				"card-2",
				`file://${remotePath}`,
				"main",
			)

			expect(card1.branch).toBe("card/card-1")
			expect(card2.branch).toBe("card/card-2")
			expect(card1.branch).not.toBe(card2.branch)

			// Verify both branches exist in the repo
			const p = Bun.spawnSync(["git", "branch"], {
				cwd: card1.repoPath,
			})
			const output = p.stdout
				? new TextDecoder().decode(p.stdout)
				: ""
			expect(output).toContain("card/card-1")
			expect(output).toContain("card/card-2")
		})
	})
})
