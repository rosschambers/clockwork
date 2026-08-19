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

		try {
			if (!(await this.dirExists(repoPath))) {
				const remoteUrl = githubRepo.startsWith("file://")
					? githubRepo
					: `https://x-access-token:${this.gitToken}@${githubRepo}`
				await this.run(["clone", remoteUrl, repoPath])
			} else {
				await this.run(["-C", repoPath, "pull", "origin", this.defaultBranch])
			}

			const branch = `card/${cardId}`
			await this.run(["-C", repoPath, "config", "user.name", "clockwork"])
			await this.run(["-C", repoPath, "config", "user.email", "clockwork@local"])
			await this.run(["-C", repoPath, "checkout", "-B", branch, `origin/${this.defaultBranch}`])

			return { repoPath, branch }
		} finally {
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
}
