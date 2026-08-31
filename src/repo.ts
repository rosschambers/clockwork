import { DbStore } from "./db.ts"
import fs from "node:fs"

export interface RepoWorkspaceConfig {
	projectRoot: string
	gitToken: string
	defaultBranch: string
}

export class RepoWorkspace {
	private projectRoot: string
	private gitToken: string
	private defaultBranch: string
	private dbStore: DbStore
	private inFlight: Set<string>

	constructor(config: RepoWorkspaceConfig, dbStore: DbStore) {
		this.projectRoot = config.projectRoot
		this.gitToken = config.gitToken
		this.defaultBranch = config.defaultBranch
		this.dbStore = dbStore
		this.inFlight = new Set()
	}

	async prepareCardWorkspace(
		projectId: string,
		cardId: string,
		githubRepo: string,
	): Promise<{ repoPath: string; branch: string }> {
		const repoPath = `${this.projectRoot}/${projectId}`

		if (!this.inFlight.has(projectId)) {
			this.inFlight.add(projectId)
		} else {
			await new Promise<void>((resolve) => {
				const check = () => {
					if (!this.inFlight.has(projectId)) {
						resolve()
					} else {
						setTimeout(check, 50)
					}
				}
				check()
			})
		}

		let stashed = false
		try {
			// A dir can exist but NOT be a valid git repo — a failed/partial clone
			// leaves a non-repo dir that would make every later `git -C` command fail
			// with "not a git repository", wedging the whole pipeline. So gate on
			// "is a valid repo", and if the dir exists but isn't one, wipe and re-clone.
			const isRepo = (await this.dirExists(repoPath)) && (await this.isGitRepo(repoPath))
			if (!isRepo) {
				if (await this.dirExists(repoPath)) {
					fs.rmSync(repoPath, { recursive: true, force: true })
				}
				const remoteUrl = githubRepo.startsWith("file://")
					? githubRepo
					: `https://x-access-token:${this.gitToken}@${githubRepo}`
				await this.run(["clone", remoteUrl, repoPath])
			} else {
				// Refresh from origin, but NEVER `pull origin <default>` blindly: the
				// clone may still be checked out on a prior card branch that has diverged
				// from origin/<default>, which turns the pull into a divergent-branch
				// merge and fails ("Need to specify how to reconcile divergent branches"),
				// wedging every card. Instead fetch, then check out the default branch and
				// fast-forward IT only. The card branch is (re)created off the refreshed
				// origin/<default> just below.
				await this.run(["-C", repoPath, "fetch", "origin", this.defaultBranch])
				// A prior card's pi session can die mid-work leaving UNCOMMITTED changes on
				// the currently-checked-out card branch. `git checkout <default>` + `merge
				// --ff-only` then abort ("Your local changes ... would be overwritten"),
				// throwing out of prepare and looping the card forever. Stash any dirty
				// state (including untracked, -u) so the refresh cannot be blocked. The
				// stash is disposable: the card branch is re-checked-out fresh just below,
				// and any work worth keeping should have been committed — a dead session's
				// scratch is not. Best-effort: a stash failure must not wedge prepare.
				stashed = await this.stashIfDirty(repoPath)
				await this.run(["-C", repoPath, "checkout", this.defaultBranch])
				await this.run(["-C", repoPath, "merge", "--ff-only", `origin/${this.defaultBranch}`])
			}

			const branch = `card/${cardId}`
			await this.run(["-C", repoPath, "config", "user.name", "clockwork"])
			await this.run(["-C", repoPath, "config", "user.email", "clockwork@local"])

			// A card crosses several pipeline stages, each a separate worker run that
			// calls this method. On the FIRST stage the branch does not exist yet, so
			// create it off the default branch. On LATER stages the branch already
			// exists with the earlier stages' commits, so just check it out — never
			// `-B` reset, which would discard the prior stages' work.
			if (await this.branchExists(repoPath, branch)) {
				await this.run(["-C", repoPath, "checkout", branch])
			} else {
				await this.run(["-C", repoPath, "checkout", "-b", branch, `origin/${this.defaultBranch}`])
			}

			// Prune leftover card/* branches from earlier cards so they cannot be
			// mis-verified or accumulate. The branch we just checked out (the one
			// under prep) is kept, and the current branch is never deleted.
			await this.pruneStaleCardBranches(repoPath, branch)

			return { repoPath, branch }
		} finally {
			// Drop the disposable stash from a dead session's uncommitted scratch. The
			// card branch has been re-checked-out fresh above, so we deliberately do NOT
			// restore it. Best-effort: a drop failure must not throw out of prepare.
			if (stashed) {
				await this.dropStash(repoPath)
			}
			this.inFlight.delete(projectId)
		}
	}

	async commitCardWork(
		repoPath: string,
		cardId: string,
		columnId: string,
	): Promise<boolean> {
		await this.run(["-C", repoPath, "add", "."])

		const column = this.dbStore.getColumnById(columnId)
		const colName = column ? column.name : ""
		const msg = `clockwork: ${cardId}${colName ? ` (${colName})` : ""}`

		await this.run(["-C", repoPath, "commit", "-m", msg])
		return true
	}

	async mergeCardToMain(
		repoPath: string,
		_cardId: string,
		branch: string,
	): Promise<boolean> {
		// Fast-forward-or-merge the finished card branch into the default branch so
		// later cards (which branch off the default) see the work. Update the default
		// from origin first so the merge is onto the latest, then merge the card
		// branch with a merge commit (--no-ff keeps each card a legible unit).
		await this.run(["-C", repoPath, "checkout", this.defaultBranch])
		await this.run(["-C", repoPath, "pull", "origin", this.defaultBranch])
		await this.run([
			"-C",
			repoPath,
			"merge",
			"--no-ff",
			"-m",
			`clockwork: merge ${branch}`,
			branch,
		])
		// Push the merge to origin. Later/dependent cards branch and pull from
		// origin/<default>; if the merge stays LOCAL, they branch off a stale main and
		// never see this card's finished work — which stranded the dependency chain in
		// production (card 2 blocked because card 1's merge was never pushed).
		await this.run(["-C", repoPath, "push", "origin", this.defaultBranch])
		return true
	}

	// Deterministic core of the deliverable gate: the set of paths a card branch
	// changed relative to its base. `git diff --name-only base...cardBranch` uses
	// the three-dot form so the comparison is against the merge-base, isolating
	// only the card's own work from unrelated base movement.
	async computeChangedFiles(repoPath: string, base: string, cardBranch: string): Promise<string[]> {
		const proc = Bun.spawn(
			["git", "-C", repoPath, "diff", "--name-only", `${base}...${cardBranch}`],
			{ stdout: "pipe", stderr: "pipe" },
		)
		const out = proc.stdout ? await new Response(proc.stdout).text() : ""
		await proc.exited
		return out.split("\n").map((f) => f.trim()).filter((f) => f !== "")
	}

	async pushCardBranch(repoPath: string, branch: string): Promise<boolean> {
		await this.run([
			"-C",
			repoPath,
			"push",
			"--force-with-lease",
			"--set-upstream",
			"origin",
			branch,
		])
		return true
	}

	// Non-throwing git runner: captures exit code + stdout/stderr so callers can
	// branch on the result instead of catching thrown errors. Used by the sync
	// operations (fail-closed) where a non-zero exit is an expected, classified
	// outcome — not a pipeline-killing exception.
	private async runCapture(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" })
		const stdout = proc.stdout ? await new Response(proc.stdout).text() : ""
		const stderr = proc.stderr ? await new Response(proc.stderr).text() : ""
		const code = await proc.exited
		return { code, stdout, stderr }
	}

	// Sync-DOWN: fast-forward the pipeline repo from its GitHub upstream. Fail-closed
	// and never auto-merges a real divergence. Pure git plumbing; the worker decides
	// what to do with the result (route a divergence to the director).
	async syncDownFromUpstream(
		pipelineRepoPath: string,
		upstreamUrl: string,
		branch: string,
	): Promise<{ ok: boolean; action: "ff" | "noop" | "diverged" | "error"; ahead: number; behind: number }> {
		// A brand-new tenant has no workspace clone yet — sync-down runs before
		// prepareCardWorkspace creates it. That is not divergence and not a fetch
		// error: the clone that follows comes fresh from the project repo, so there
		// is no pipeline-side state to protect. Fail-closed only applies to an
		// EXISTING workspace whose fetch genuinely fails.
		const workspaceExists = (await this.dirExists(pipelineRepoPath)) && (await this.isGitRepo(pipelineRepoPath))
		if (!workspaceExists) {
			return { ok: true, action: "noop", ahead: 0, behind: 0 }
		}
		const fetched = await this.runCapture(["-C", pipelineRepoPath, "fetch", upstreamUrl, branch])
		if (fetched.code !== 0) {
			return { ok: false, action: "error", ahead: 0, behind: 0 }
		}
		const counts = await this.runCapture(["-C", pipelineRepoPath, "rev-list", "--left-right", "--count", `${branch}...FETCH_HEAD`])
		if (counts.code !== 0) {
			return { ok: false, action: "error", ahead: 0, behind: 0 }
		}
		const parts = counts.stdout.trim().split(/\s+/)
		const ahead = Number(parts[0] ?? "0")
		const behind = Number(parts[1] ?? "0")
		if (behind === 0) {
			// Equal or local strictly ahead: nothing to pull down. Push (sync-up) carries local up.
			return { ok: true, action: "noop", ahead, behind }
		}
		if (ahead > 0) {
			// Both ahead and behind — real divergence. Do NOT merge; leave repo untouched.
			return { ok: false, action: "diverged", ahead, behind }
		}
		const merged = await this.runCapture(["-C", pipelineRepoPath, "merge", "--ff-only", "FETCH_HEAD"])
		if (merged.code !== 0) {
			return { ok: false, action: "error", ahead, behind }
		}
		return { ok: true, action: "ff", ahead, behind }
	}

	// Sync-UP: push the pipeline repo's default branch up to GitHub. Never forces.
	// A non-fast-forward rejection is a classified, non-blocking outcome (the local
	// merge already landed); any other error is surfaced as a plain failure.
	async pushUpToUpstream(
		pipelineRepoPath: string,
		upstreamUrl: string,
		branch: string,
	): Promise<{ ok: boolean; rejected: boolean }> {
		const pushed = await this.runCapture(["-C", pipelineRepoPath, "push", upstreamUrl, branch])
		if (pushed.code === 0) {
			return { ok: true, rejected: false }
		}
		const stderr = pushed.stderr.toLowerCase()
		if (stderr.includes("rejected") || stderr.includes("non-fast-forward") || stderr.includes("fetch first")) {
			return { ok: false, rejected: true }
		}
		return { ok: false, rejected: false }
	}

	// The ONE real merge of the pipeline repo with its GitHub upstream, performed
	// by the director's /sync/reconcile action. Fetches upstream, merges; on a
	// clean merge dual-pushes (origin + upstream); on conflict returns the
	// conflicted file list and ABORTS the merge (never auto-resolves). Any other
	// git error returns a clean failure (design §C).
	async reconcileSync(
		pipelineRepoPath: string,
		upstreamUrl: string,
		branch: string,
	): Promise<{ ok: boolean; merged: boolean; conflicts: string[] }> {
		const fetched = await this.runCapture(["-C", pipelineRepoPath, "fetch", upstreamUrl, branch])
		if (fetched.code !== 0) {
			return { ok: false, merged: false, conflicts: [] }
		}
		const merged = await this.runCapture(["-C", pipelineRepoPath, "merge", "FETCH_HEAD"])
		if (merged.code !== 0) {
			const conflictOut = await this.runCapture(["-C", pipelineRepoPath, "diff", "--name-only", "--diff-filter=U"])
			const conflicts = conflictOut.stdout.split("\n").map((f) => f.trim()).filter((f) => f !== "")
			await this.runCapture(["-C", pipelineRepoPath, "merge", "--abort"])
			return { ok: false, merged: false, conflicts }
		}
		// Clean: dual-push (origin first, then the GitHub upstream). Best-effort on
		// push failure — the merge itself is the reconcile; a push hiccup is
		// surfaced via ok:false while merged stays true.
		const pushedOrigin = await this.runCapture(["-C", pipelineRepoPath, "push", "origin", branch])
		const pushedUpstream = await this.runCapture(["-C", pipelineRepoPath, "push", upstreamUrl, branch])
		const ok = pushedOrigin.code === 0 && pushedUpstream.code === 0
		return { ok, merged: true, conflicts: [] }
	}

	private async run(args: string[]): Promise<void> {
		const proc = Bun.spawn(["git", ...args], {
			stdout: "pipe",
			stderr: "pipe",
		})
		const stdout = proc.stdout
			? await new Response(proc.stdout).text()
			: ""
		const stderr = proc.stderr
			? await new Response(proc.stderr).text()
			: ""
		const exitCode = await proc.exited
		if (exitCode !== 0) {
			throw new Error(`git ${args.join(" ")}: ${stderr.trim()}`)
		}
	}

	private dirExists(path: string): boolean {
		return fs.existsSync(path)
	}

	private async isGitRepo(repoPath: string): Promise<boolean> {
		const proc = Bun.spawn(
			["git", "-C", repoPath, "rev-parse", "--is-inside-work-tree"],
			{ stdout: "pipe", stderr: "pipe" },
		)
		const exitCode = await proc.exited
		return exitCode === 0
	}

	// Stash any uncommitted changes (including untracked, -u) so a following branch
	// checkout cannot be blocked by "local changes would be overwritten". Returns
	// whether a stash was actually created (nothing to stash => false). Best-effort:
	// a stash failure returns false rather than throwing, so prepare never wedges on
	// a stash hiccup — the subsequent checkout may still succeed on its own.
	private async stashIfDirty(repoPath: string): Promise<boolean> {
		if (!(await this.isDirty(repoPath))) {
			return false
		}
		const proc = Bun.spawn(
			["git", "-C", repoPath, "stash", "push", "-u", "-m", "clockwork-prepare-autostash"],
			{ stdout: "pipe", stderr: "pipe" },
		)
		const exitCode = await proc.exited
		return exitCode === 0
	}

	// True when the working tree has any staged, unstaged, or untracked changes.
	private async isDirty(repoPath: string): Promise<boolean> {
		const proc = Bun.spawn(
			["git", "-C", repoPath, "status", "--porcelain"],
			{ stdout: "pipe", stderr: "pipe" },
		)
		const out = proc.stdout ? await new Response(proc.stdout).text() : ""
		await proc.exited
		return out.trim() !== ""
	}

	// Drop the most recent stash. Best-effort: swallow errors so a drop hiccup cannot
	// throw out of prepare's finally block.
	private async dropStash(repoPath: string): Promise<void> {
		try {
			await this.run(["-C", repoPath, "stash", "drop"])
		} catch {
			// Best-effort: a failed drop must not wedge prepare.
		}
	}

	private async branchExists(repoPath: string, branch: string): Promise<boolean> {
		const proc = Bun.spawn(
			["git", "-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
			{ stdout: "pipe", stderr: "pipe" },
		)
		const exitCode = await proc.exited
		return exitCode === 0
	}

	private async pruneStaleCardBranches(repoPath: string, keepBranch: string): Promise<void> {
		const proc = Bun.spawn(
			["git", "-C", repoPath, "for-each-ref", "--format=%(refname:short)", "refs/heads/card/"],
			{ stdout: "pipe", stderr: "pipe" },
		)
		const out = proc.stdout ? await new Response(proc.stdout).text() : ""
		await proc.exited
		const current = await this.currentBranch(repoPath)
		const branches = out.split("\n").map((b) => b.trim()).filter((b) => b !== "")
		for (const branch of branches) {
			if (branch === keepBranch || branch === current) {
				continue
			}
			try {
				await this.run(["-C", repoPath, "branch", "-D", branch])
			} catch {
				// Best-effort: a stale branch we cannot delete must not wedge prepare.
			}
		}
	}

	private async currentBranch(repoPath: string): Promise<string> {
		const proc = Bun.spawn(
			["git", "-C", repoPath, "branch", "--show-current"],
			{ stdout: "pipe", stderr: "pipe" },
		)
		const out = proc.stdout ? await new Response(proc.stdout).text() : ""
		await proc.exited
		return out.trim()
	}
}
