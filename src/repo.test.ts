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

function seedUpstreamAndPipeline(projectRoot: string): { upstreamPath: string; pipelinePath: string } {
	const upstreamPath = `${projectRoot}/upstream-bare.git`
	fs.mkdirSync(upstreamPath)
	const seedWork = `${projectRoot}/upstream-seed`
	fs.mkdirSync(seedWork)
	const run = (args: string[], cwd: string): void => {
		const p = Bun.spawnSync(["git", ...args], { cwd })
		if (p.exitCode !== 0) {
			throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr ?? new Uint8Array()).trim()}`)
		}
	}
	run(["init", "--bare"], upstreamPath)
	run(["init"], seedWork)
	run(["config", "user.name", "test"], seedWork)
	run(["config", "user.email", "test@test"], seedWork)
	run(["remote", "add", "origin", upstreamPath], seedWork)
	fs.writeFileSync(`${seedWork}/README.md`, "# Upstream")
	run(["add", "."], seedWork)
	run(["commit", "-m", "initial"], seedWork)
	run(["push", "-u", "origin", "main"], seedWork)
	cleanup(seedWork)

	// The pipeline repo is a plain clone of the upstream — upstream is reachable as
	// file://<upstreamPath>. Its own default branch tracks upstream/main at seed time.
	const pipelinePath = `${projectRoot}/pipeline`
	const clone = Bun.spawnSync(["git", "clone", `file://${upstreamPath}`, pipelinePath], {})
	if (clone.exitCode !== 0) {
		throw new Error("clone failed")
	}
	Bun.spawnSync(["git", "-C", pipelinePath, "config", "user.name", "clockwork"], {})
	Bun.spawnSync(["git", "-C", pipelinePath, "config", "user.email", "clockwork@local"], {})
	return { upstreamPath, pipelinePath }
}

function commitFile(repoOrBareWorkPath: string, name: string, content: string): void {
	fs.writeFileSync(`${repoOrBareWorkPath}/${name}`, content)
	Bun.spawnSync(["git", "-C", repoOrBareWorkPath, "add", "."], {})
	Bun.spawnSync(["git", "-C", repoOrBareWorkPath, "commit", "-m", `add ${name}`], {})
}

function headSha(repoPath: string): string {
	const p = Bun.spawnSync(["git", "-C", repoPath, "rev-parse", "HEAD"], {})
	return new TextDecoder().decode(p.stdout ?? new Uint8Array()).trim()
}

// Advance the UPSTREAM bare repo by pushing a new commit from a throwaway clone.
function advanceUpstream(projectRoot: string, upstreamPath: string, name: string, content: string): void {
	const work = `${projectRoot}/upstream-advance-${name}`
	Bun.spawnSync(["git", "clone", `file://${upstreamPath}`, work], {})
	Bun.spawnSync(["git", "-C", work, "config", "user.name", "test"], {})
	Bun.spawnSync(["git", "-C", work, "config", "user.email", "test@test"], {})
	commitFile(work, name, content)
	Bun.spawnSync(["git", "-C", work, "push", "origin", "main"], {})
	cleanup(work)
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

		it("re-preparing the SAME card keeps its prior commit (does not reset to origin)", async () => {
			const { remotePath } = seedRemote(projectRoot)
			const ws = new RepoWorkspace(
				{ projectRoot, gitToken: "fake-token", defaultBranch: "main" },
				store,
			)
			store.createProject({ name: "P", description: "", githubRepo: null, branch: null })

			// Stage 1: prepare the card branch and commit some work on it.
			const { repoPath } = await ws.prepareCardWorkspace("proj-1", "card-1", `file://${remotePath}`)
			fs.writeFileSync(`${repoPath}/stage1.txt`, "stage one work")
			await ws.commitCardWork(repoPath, "card-1", "col-1")

			// Stage 2: the SAME card is processed again (next pipeline stage).
			await ws.prepareCardWorkspace("proj-1", "card-1", `file://${remotePath}`)

			// The stage-1 commit's file must still be present — the branch was reused,
			// not reset to origin/main (which would discard the earlier stage's work).
			expect(fs.existsSync(`${repoPath}/stage1.txt`)).toBe(true)
			const log = Bun.spawnSync(["git", "-C", repoPath, "log", "--oneline"], {})
			const text = log.stdout ? new TextDecoder().decode(log.stdout) : ""
			expect(text).toContain("card-1")
		})

		it("prepares a new card after origin advanced while on a prior card branch (ff main, do not pull into the card branch)", async () => {
			const { remotePath } = seedRemote(projectRoot)
			const ws = new RepoWorkspace(
				{ projectRoot, gitToken: "fake-token", defaultBranch: "main" },
				store,
			)
			store.createProject({ name: "P", description: "", githubRepo: null, branch: null })

			// Stage 1: prepare card-1 and commit work on its branch — this leaves the
			// clone on card/card-1 with a commit origin/main does not have (divergent).
			const { repoPath } = await ws.prepareCardWorkspace("proj-1", "card-1", `file://${remotePath}`)
			fs.writeFileSync(`${repoPath}/card1-work.txt`, "card 1 work")
			await ws.commitCardWork(repoPath, "card-1", "col-1")

			// Origin's main advances (another card merged, or a human/sync pushed) WHILE
			// the clone is still on the card-1 branch. Simulate by committing to the bare
			// remote's main through a throwaway clone.
			const bump = `${projectRoot}/bump-work`
			const g = (args: string[], cwd: string): void => {
				const p = Bun.spawnSync(["git", ...args], { cwd })
				if (p.exitCode !== 0) {
					throw new Error(`git ${args.join(" ")}: ${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`)
				}
			}
			fs.mkdirSync(bump)
			g(["clone", remotePath, bump], projectRoot)
			g(["config", "user.name", "t"], bump)
			g(["config", "user.email", "t@t"], bump)
			fs.writeFileSync(`${bump}/advanced.txt`, "origin moved on")
			g(["add", "."], bump)
			g(["commit", "-m", "advance main"], bump)
			g(["push", "origin", "main"], bump)

			// Stage 2: prepare a DIFFERENT card. The clone is still on card/card-1 and
			// origin/main has advanced. This must NOT fail with "divergent branches"
			// (the bug: `git pull origin main` ran while HEAD was on the card branch).
			const result = await ws.prepareCardWorkspace("proj-1", "card-2", `file://${remotePath}`)
			expect(result.branch).toBe("card/card-2")
			// card-2 branched off the ADVANCED origin/main, so it has the new file.
			expect(fs.existsSync(`${repoPath}/advanced.txt`)).toBe(true)
		})

		it("prepares a card even when the current card branch has UNCOMMITTED changes and origin advanced (stashes before default checkout)", async () => {
			const { remotePath } = seedRemote(projectRoot)
			const ws = new RepoWorkspace(
				{ projectRoot, gitToken: "fake-token", defaultBranch: "main" },
				store,
			)
			store.createProject({ name: "P", description: "", githubRepo: null, branch: null })

			// Stage 1: prepare card-1 so the clone is checked out on card/card-1.
			const { repoPath } = await ws.prepareCardWorkspace("proj-1", "card-1", `file://${remotePath}`)

			// Origin's main advances WHILE the dirty card-1 branch is checked out, and it
			// changes the SAME file (README.md) the dead session left dirty. `git checkout
			// main` then refuses ("Your local changes to README.md would be overwritten by
			// checkout") because main's README.md differs from the working-tree edit. This
			// is the exact wedge that made prepare throw. Prepare must stash first.
			const bump = `${projectRoot}/bump-dirty`
			const g = (args: string[], cwd: string): void => {
				const p = Bun.spawnSync(["git", ...args], { cwd })
				if (p.exitCode !== 0) {
					throw new Error(`git ${args.join(" ")}: ${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`)
				}
			}
			fs.mkdirSync(bump)
			g(["clone", remotePath, bump], projectRoot)
			g(["config", "user.name", "t"], bump)
			g(["config", "user.email", "t@t"], bump)
			fs.writeFileSync(`${bump}/README.md`, "# Test changed on main")
			fs.writeFileSync(`${bump}/advanced.txt`, "origin moved on")
			g(["add", "."], bump)
			g(["commit", "-m", "advance main"], bump)
			g(["push", "origin", "main"], bump)

			// The pi session dies mid-work leaving UNCOMMITTED edits on the card branch —
			// a tracked-file modification to the SAME file main changed, plus a new
			// untracked file. AFTER the push so the local edit is the current tree state.
			fs.writeFileSync(`${repoPath}/README.md`, "# Test half-done edit")
			fs.writeFileSync(`${repoPath}/scratch.txt`, "uncommitted scratch from a dead session")

			// Stage 2: prepare a DIFFERENT card. Must NOT throw "workspace prepare failed"
			// / "local changes would be overwritten by checkout".
			const result = await ws.prepareCardWorkspace("proj-1", "card-2", `file://${remotePath}`)
			expect(result.branch).toBe("card/card-2")
			// card-2 branched off the ADVANCED origin/main, so it has the new file.
			expect(fs.existsSync(`${repoPath}/advanced.txt`)).toBe(true)
		})

		it("recovers when the workspace dir exists but is not a git repo (partial/failed clone)", async () => {
			const { remotePath } = seedRemote(projectRoot)
			const ws = new RepoWorkspace(
				{ projectRoot, gitToken: "fake-token", defaultBranch: "main" },
				store,
			)
			// Simulate a wedged workspace: the dir exists (with a stray file) but has no
			// .git — the exact state a failed/partial clone leaves behind.
			const repoPath = `${projectRoot}/proj-1`
			fs.mkdirSync(repoPath, { recursive: true })
			fs.writeFileSync(`${repoPath}/stray.md`, "leftover from a failed clone")

			// Must NOT throw "not a git repository"; it should recover by re-cloning.
			const result = await ws.prepareCardWorkspace("proj-1", "card-1", `file://${remotePath}`)
			expect(fs.existsSync(`${result.repoPath}/.git`)).toBe(true)
			// The seed repo's README is present => a real clone happened.
			expect(fs.existsSync(`${result.repoPath}/README.md`)).toBe(true)
		})

		it("prunes stale card/* branches on prepare, keeping the current card's branch", async () => {
			const { remotePath } = seedRemote(projectRoot)
			const ws = new RepoWorkspace(
				{ projectRoot, gitToken: "fake-token", defaultBranch: "main" },
				store,
			)

			// Stage a stale branch from an earlier card.
			await ws.prepareCardWorkspace("proj-1", "old", `file://${remotePath}`)
			const repoPath = `${projectRoot}/proj-1`
			// Move off card/old so it is deletable, then prepare a new card.
			await ws.prepareCardWorkspace("proj-1", "new", `file://${remotePath}`)

			const branches = Bun.spawnSync(["git", "-C", repoPath, "branch"], {})
			const text = new TextDecoder().decode(branches.stdout!)
			expect(text).toContain("card/new")
			expect(text).not.toContain("card/old")
		})

		it("mergeCardToMain lands the card's commit on the default branch", async () => {
			const { remotePath } = seedRemote(projectRoot)
			const ws = new RepoWorkspace(
				{ projectRoot, gitToken: "fake-token", defaultBranch: "main" },
				store,
			)
			store.createProject({ name: "P", description: "", githubRepo: null, branch: null })

			const { repoPath, branch } = await ws.prepareCardWorkspace("proj-1", "card-1", `file://${remotePath}`)
			fs.writeFileSync(`${repoPath}/feature.txt`, "the card's work")
			await ws.commitCardWork(repoPath, "card-1", "col-1")

			await ws.mergeCardToMain(repoPath, "card-1", branch)

			// On the default branch now, the card's file is present.
			const current = Bun.spawnSync(["git", "-C", repoPath, "branch", "--show-current"], {})
			expect(new TextDecoder().decode(current.stdout!).trim()).toBe("main")
			expect(fs.existsSync(`${repoPath}/feature.txt`)).toBe(true)
			const log = Bun.spawnSync(["git", "-C", repoPath, "log", "--oneline"], {})
			expect(new TextDecoder().decode(log.stdout!)).toContain("card-1")

			// CRITICAL: the merge must be PUSHED to origin. Later/dependent cards branch
			// and pull from origin/main; if the merge stays local, they never see the
			// finished work (the production bug that stranded card 2). Verify the REMOTE
			// bare repo's main now contains the card's file.
			const remoteLog = Bun.spawnSync(["git", "-C", remotePath, "log", "main", "--oneline", "--name-only"], {})
			expect(new TextDecoder().decode(remoteLog.stdout!)).toContain("feature.txt")
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

	describe("computeChangedFiles", () => {
		it("lists files changed on the card branch vs base", async () => {
			const { remotePath } = seedRemote(projectRoot)
			const ws = new RepoWorkspace(
				{ projectRoot, gitToken: "fake-token", defaultBranch: "main" },
				store,
			)
			const { repoPath, branch } = await ws.prepareCardWorkspace("proj-1", "card-1", `file://${remotePath}`)
			fs.writeFileSync(`${repoPath}/scripts-main.gd`, "extends Node")
			await ws.commitCardWork(repoPath, "card-1", "col-1")

			const changed = await ws.computeChangedFiles(repoPath, "origin/main", branch)
			expect(changed).toContain("scripts-main.gd")
		})
	})

	describe("multiple cards", () => {
		it("each card gets its own distinct branch (earlier card branches are pruned on prepare)", async () => {
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

			// Preparing card-2 prunes the stale card-1 branch (no merge happened for
			// card-1, so it is leftover). The current card's branch is what remains.
			const p = Bun.spawnSync(["git", "branch"], {
				cwd: card1.repoPath,
			})
			const output = p.stdout
				? new TextDecoder().decode(p.stdout)
				: ""
			expect(output).toContain("card/card-2")
			expect(output).not.toContain("card/card-1")
		})
	})

	describe("syncDownFromUpstream", () => {
		it("upstream ahead -> fast-forwards the pipeline repo", async () => {
			const { upstreamPath, pipelinePath } = seedUpstreamAndPipeline(projectRoot)
			const ws = new RepoWorkspace({ projectRoot, gitToken: "fake", defaultBranch: "main" }, store)

			advanceUpstream(projectRoot, upstreamPath, "upstream-feature.txt", "from github")

			const result = await ws.syncDownFromUpstream(pipelinePath, `file://${upstreamPath}`, "main")
			expect(result.action).toBe("ff")
			expect(result.ok).toBe(true)
			expect(fs.existsSync(`${pipelinePath}/upstream-feature.txt`)).toBe(true)
		})

		it("equal -> noop, repo unchanged", async () => {
			const { upstreamPath, pipelinePath } = seedUpstreamAndPipeline(projectRoot)
			const ws = new RepoWorkspace({ projectRoot, gitToken: "fake", defaultBranch: "main" }, store)
			const before = headSha(pipelinePath)

			const result = await ws.syncDownFromUpstream(pipelinePath, `file://${upstreamPath}`, "main")
			expect(result.action).toBe("noop")
			expect(headSha(pipelinePath)).toBe(before)
		})

		it("diverged -> returns diverged and leaves the repo byte-for-byte unchanged", async () => {
			const { upstreamPath, pipelinePath } = seedUpstreamAndPipeline(projectRoot)
			const ws = new RepoWorkspace({ projectRoot, gitToken: "fake", defaultBranch: "main" }, store)

			// Local commit only on the pipeline repo (ahead).
			commitFile(pipelinePath, "local-only.txt", "pipeline work")
			// Upstream commit only on github (behind) -> now both ahead and behind.
			advanceUpstream(projectRoot, upstreamPath, "github-only.txt", "github work")

			const before = headSha(pipelinePath)
			const result = await ws.syncDownFromUpstream(pipelinePath, `file://${upstreamPath}`, "main")
			expect(result.action).toBe("diverged")
			expect(result.ok).toBe(false)
			expect(result.ahead).toBeGreaterThan(0)
			expect(result.behind).toBeGreaterThan(0)
			expect(headSha(pipelinePath)).toBe(before)
			expect(fs.existsSync(`${pipelinePath}/github-only.txt`)).toBe(false)
		})

		it("bad upstream url -> fail-closed error, never throws", async () => {
			const { pipelinePath } = seedUpstreamAndPipeline(projectRoot)
			const ws = new RepoWorkspace({ projectRoot, gitToken: "fake", defaultBranch: "main" }, store)
			const result = await ws.syncDownFromUpstream(pipelinePath, "file:///nonexistent/nope.git", "main")
			expect(result.action).toBe("error")
			expect(result.ok).toBe(false)
		})

		it("missing pipeline repo (new tenant, first claim) -> noop, not fail-closed", async () => {
			// A brand-new tenant has NO workspace clone yet: sync-down runs before
			// prepareCardWorkspace creates it. That is not divergence and not a fetch
			// error — the clone that follows comes fresh from the project repo. The
			// first card of every new tenant used to park at Needs-Director on this
			// (project-bastion, 2026-08-29).
			const { upstreamPath } = seedUpstreamAndPipeline(projectRoot)
			const ws = new RepoWorkspace({ projectRoot, gitToken: "fake", defaultBranch: "main" }, store)
			const missingPipelinePath = `${projectRoot}/never-cloned-project`
			const result = await ws.syncDownFromUpstream(missingPipelinePath, `file://${upstreamPath}`, "main")
			expect(result.action).toBe("noop")
			expect(result.ok).toBe(true)
		})
	})

	describe("pushUpToUpstream", () => {
		it("clean push -> upstream gains the commit", async () => {
			const { upstreamPath, pipelinePath } = seedUpstreamAndPipeline(projectRoot)
			const ws = new RepoWorkspace({ projectRoot, gitToken: "fake", defaultBranch: "main" }, store)

			commitFile(pipelinePath, "pushed.txt", "local work to mirror")
			const result = await ws.pushUpToUpstream(pipelinePath, `file://${upstreamPath}`, "main")
			expect(result.ok).toBe(true)
			expect(result.rejected).toBe(false)

			const remoteLog = Bun.spawnSync(["git", "-C", upstreamPath, "log", "main", "--oneline", "--name-only"], {})
			expect(new TextDecoder().decode(remoteLog.stdout ?? new Uint8Array())).toContain("pushed.txt")
		})

		it("upstream moved ahead -> rejected, no force", async () => {
			const { upstreamPath, pipelinePath } = seedUpstreamAndPipeline(projectRoot)
			const ws = new RepoWorkspace({ projectRoot, gitToken: "fake", defaultBranch: "main" }, store)

			// Upstream advances independently; local also commits -> local push is non-ff.
			advanceUpstream(projectRoot, upstreamPath, "upstream-moved.txt", "moved on github")
			commitFile(pipelinePath, "diverging-local.txt", "local diverge")

			const result = await ws.pushUpToUpstream(pipelinePath, `file://${upstreamPath}`, "main")
			expect(result.ok).toBe(false)
			expect(result.rejected).toBe(true)

			// The upstream still has its own commit and was NOT overwritten by a force.
			const remoteLog = Bun.spawnSync(["git", "-C", upstreamPath, "log", "main", "--oneline", "--name-only"], {})
			expect(new TextDecoder().decode(remoteLog.stdout ?? new Uint8Array())).toContain("upstream-moved.txt")
		})
	})

	describe("reconcileSync", () => {
		it("clean merge -> merged true, upstream + origin updated", async () => {
			const { upstreamPath, pipelinePath } = seedUpstreamAndPipeline(projectRoot)
			const ws = new RepoWorkspace({ projectRoot, gitToken: "fake", defaultBranch: "main" }, store)
			// Non-conflicting divergence: upstream adds a new file, local adds a different file.
			advanceUpstream(projectRoot, upstreamPath, "github-side.txt", "from github")
			commitFile(pipelinePath, "local-side.txt", "from pipeline")

			const result = await ws.reconcileSync(pipelinePath, `file://${upstreamPath}`, "main")
			expect(result.merged).toBe(true)
			expect(result.conflicts).toEqual([])
			expect(fs.existsSync(`${pipelinePath}/github-side.txt`)).toBe(true)
		})

		it("conflicting divergence -> merged false, conflict file list, merge aborted", async () => {
			const { upstreamPath, pipelinePath } = seedUpstreamAndPipeline(projectRoot)
			const ws = new RepoWorkspace({ projectRoot, gitToken: "fake", defaultBranch: "main" }, store)
			// Both sides edit README.md differently -> real conflict.
			advanceUpstream(projectRoot, upstreamPath, "README.md", "# github version")
			commitFile(pipelinePath, "README.md", "# pipeline version")

			const result = await ws.reconcileSync(pipelinePath, `file://${upstreamPath}`, "main")
			expect(result.merged).toBe(false)
			expect(result.conflicts).toContain("README.md")
			// Merge aborted: no MERGE_HEAD left dangling.
			expect(fs.existsSync(`${pipelinePath}/.git/MERGE_HEAD`)).toBe(false)
		})
	})
})
