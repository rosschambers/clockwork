import { parseVerdict, type Verdict } from "./verdict.ts"
import { DbStore, type DbCard, type DbColumn } from "./db.ts"
import { notify, columnNotificationType, type NotifyEvent } from "./notify.ts"
import { assembleContext, type ThreadEntry } from "./context.ts"
import path from "node:path"
import { mkdirSync, writeFileSync } from "node:fs"

// Appended to every column prompt so the model ends with a machine-parseable
// verdict. A missing/malformed verdict is treated as `blocked` by parseVerdict.
const VERDICT_INSTRUCTION = `

---
When finished, emit EXACTLY ONE JSON object as the very last thing in your output:
{"verdict": "pass" | "fail" | "blocked", "feedback": "<why>", "artifacts": ["<path>", ...]}
- "pass": the work/verification for this stage succeeded.
- "fail": it did not meet the bar; put the specific problem in "feedback".
- "blocked": you could not proceed (missing input, ambiguous task); explain in "feedback".`

export interface WorkerConfig {
	dbStore: DbStore
	projectId: string
	token: string
	workerId: string
	piCommand?: string
	maxRetries?: number
	pollIntervalMs?: number
	projectRoot: string
	transcriptsDir: string
	tokenBudget?: number
	// pi provider (endpoint) for all sessions. Defaults to the arbiter LOW port.
	piProvider?: string
	onEvent?: (e: WorkerEvent) => void
	notifyUrl?: string
	notifyToken?: string
}

export type InvokePiFn = (invocation: PiInvocation) => Promise<PiResult>

export type WorkerEvent =
	| { type: "claimed"; cardId: string }
	| { type: "running"; cardId: string }
	| { type: "passed"; cardId: string; feedback: string; artifacts: string[] }
	| { type: "failed"; cardId: string; feedback: string }
	| { type: "blocked"; cardId: string; reason: string }
	| { type: "needsHuman"; cardId: string; reason: string }
	| { type: "idle"; reason: string }

export interface PiResult {
	stdout: string
	stderr: string
	exitCode: number
}

export interface PiInvocation {
	prompt: string
	cwd: string
	// pi provider carrying the endpoint. Defaults to the arbiter LOW port
	// (frame-dense-low) so clockwork work is background/preemptible by design.
	provider?: string
	model?: string
	skills?: string[]
	env?: Record<string, string>
}

// clockwork is background work by definition, so it targets the frame-arbiter
// LOW port (a Hugo request preempts it). This is the provider the container's
// pi config must define -> http://frame:8185/v1 (dense 27B).
export const DEFAULT_PI_PROVIDER = "frame-dense-low"

// Run one pi session non-interactively against a frame model. The prompt is the
// fully-assembled context (column prompt + card + memory). Model + skills come
// from the column. Bun.spawn returns a Subprocess synchronously; we await
// `.exited` and read the piped streams.
export async function invokePi(invocation: PiInvocation): Promise<PiResult> {
	const args = ["pi", "-p"]
	args.push("--provider", invocation.provider ?? DEFAULT_PI_PROVIDER)
	if (invocation.model) {
		args.push("--model", invocation.model)
	}
	for (const skill of invocation.skills ?? []) {
		args.push("--skill", skill)
	}
	args.push(invocation.prompt)

	const proc = Bun.spawn(args, {
		cwd: invocation.cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...(invocation.env ?? {}) },
	})

	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	])
	await proc.exited

	return { stdout, stderr, exitCode: proc.exitCode ?? 0 }
}

function emitEvent(
	onEvent: ((e: WorkerEvent) => void) | undefined,
	event: WorkerEvent
): void {
	if (onEvent) {
		onEvent(event)
	}
}

// Park columns sit OFF the linear pipeline (cards wait for a human there); they
// must be excluded from positional advance/kickback math.
function normalizeThreadType(entryType: string): ThreadEntry["entryType"] {
	if (entryType === "feedback" || entryType === "verdict" || entryType === "note") {
		return entryType
	}
	return "note"
}

function isParkColumn(column: DbColumn): boolean {
	const name = column.name.toLowerCase()
	return name.includes("needs-human") || name.includes("needs-director") ||
		name.includes("needs human") || name.includes("needs director")
}

export class Worker {
	public readonly dbStore: DbStore
	public readonly projectId: string
	public readonly token: string
	public readonly workerId: string
	public readonly maxRetries: number
	public readonly pollIntervalMs: number
	public readonly projectRoot: string
	public readonly transcriptsDir: string
	public readonly tokenBudget: number | undefined
	public readonly piProvider: string
	public readonly onEvent: ((e: WorkerEvent) => void) | undefined
	public readonly notifyUrl: string | undefined
	public readonly notifyToken: string | undefined

	private running = false
	private _loopPromise: Promise<void> = Promise.resolve()
	private _invokePi: InvokePiFn | null = null

	constructor(config: WorkerConfig) {
		this.dbStore = config.dbStore
		this.projectId = config.projectId
		this.token = config.token
		this.workerId = config.workerId
		this.maxRetries = config.maxRetries ?? 3
		this.pollIntervalMs = config.pollIntervalMs ?? 1000
		this.projectRoot = config.projectRoot
		this.transcriptsDir = config.transcriptsDir
		this.tokenBudget = config.tokenBudget
		this.piProvider = config.piProvider ?? DEFAULT_PI_PROVIDER
		this.onEvent = config.onEvent
		this.notifyUrl = config.notifyUrl
		this.notifyToken = config.notifyToken
	}

	set invokePi(fn: InvokePiFn | null) {
		this._invokePi = fn
	}

	get invokePi(): InvokePiFn | null {
		return this._invokePi
	}

	private async tryNotify(event: NotifyEvent): Promise<void> {
		if (!this.notifyUrl || !this.notifyToken) {
			return
		}
		await notify(event, this.notifyUrl, this.notifyToken)
	}

	start(): void {
		if (this.running) {
			return
		}
		this.running = true
		this._loopPromise = this.loop()
	}

	stop(): void {
		this.running = false
	}

	async stopped(): Promise<void> {
		await this._loopPromise
	}

	private async loop(): Promise<void> {
		while (this.running) {
			const card = await this.claimCard()

			if (!card) {
				emitEvent(this.onEvent, {
					type: "idle",
					reason: "No claimable cards",
				})
				await this.poll()
				continue
			}

			emitEvent(this.onEvent, { type: "claimed", cardId: card.id })
			await this.processCard(card)
		}
	}

	private async poll(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs))
	}

	private async claimCard(): Promise<DbCard | null> {
		const parkIds = new Set(
			this.dbStore.getColumnsByProject(this.projectId).filter(isParkColumn).map((c) => c.id)
		)
		const eligible = this.dbStore.getCardsByProject(this.projectId).filter((card) => {
			if (card.claimState !== null) return false
			if (card.retryCount >= this.maxRetries) return false
			if (parkIds.has(card.columnId)) return false
			return true
		})

		if (eligible.length === 0) {
			return null
		}

		eligible.sort((a, b) => {
			if (a.position !== b.position) {
				return a.position - b.position
			}
			return a.createdAt.getTime() - b.createdAt.getTime()
		})

		// Atomic claim: only one worker can win the card even under concurrency.
		for (const candidate of eligible) {
			const claimed = this.dbStore.claimCardIfFree(candidate.id, this.workerId)
			if (claimed) {
				return claimed
			}
		}
		return null
	}

	async processCard(card: DbCard): Promise<void> {
		const invokeFn = this._invokePi ?? invokePi
		const column = this.dbStore.getColumnById(card.columnId)
		if (!column) {
			emitEvent(this.onEvent, { type: "blocked", cardId: card.id, reason: "Card's column not found" })
			this.dbStore.unclaimCard(card.id)
			return
		}

		// Assemble a short, fresh session: column prompt + card + verdict contract
		// as the column-extras tier, plus PROJECT.md and the card's feedback thread.
		const thread: ThreadEntry[] = this.dbStore.getCardThreads(card.id).map((t) => ({
			id: t.id,
			entryType: normalizeThreadType(t.entryType),
			timestamp: t.createdAt.getTime(),
			content: t.content,
		}))
		const columnExtras = `# Stage: ${column.name}\n\n${column.prompt}\n\n## Card: ${card.title}\n\n${card.body}${VERDICT_INSTRUCTION}`
		const assembled = assembleContext({
			projectRoot: this.projectRoot,
			planFiles: [],
			cardThread: thread,
			columnExtras,
			cardId: card.id,
			tokenBudget: this.tokenBudget,
		})

		emitEvent(this.onEvent, { type: "running", cardId: card.id })

		const startedAt = new Date()
		const result = await invokeFn({
			prompt: assembled.systemPrompt,
			cwd: this.projectRoot,
			provider: this.piProvider,
			model: column.model ?? undefined,
			skills: column.skills,
			env: {
				CLOCKWORK_PROJECT_ROOT: this.projectRoot,
				CLOCKWORK_CARD_ID: card.id,
				CLOCKWORK_WORKER_ID: this.workerId,
			},
		})

		const verdict = parseVerdict(result.stdout)

		// Persist the full transcript + verdict as an attempt (the check-in
		// debugging surface). Never let a persistence hiccup lose the verdict.
		const transcriptPath = this.saveTranscript(card, result)
		try {
			this.dbStore.createAttempt({
				cardId: card.id,
				transcriptPath,
				verdict: { verdict: verdict.verdict, feedback: verdict.feedback, artifacts: verdict.artifacts, columnId: card.columnId },
				startedAt,
				completedAt: new Date(),
			})
			this.dbStore.addCardThreadEntry({
				cardId: card.id,
				entryType: "verdict",
				content: `[${column.name}] ${verdict.verdict}: ${verdict.feedback}`,
			})
		} catch (err) {
			emitEvent(this.onEvent, { type: "blocked", cardId: card.id, reason: `attempt persistence failed: ${String(err)}` })
		}

		switch (verdict.verdict) {
			case "pass": {
				await this.moveForward(card, verdict)
				break
			}
			case "fail": {
				await this.kickback(card, verdict)
				break
			}
			case "blocked": {
				emitEvent(this.onEvent, {
					type: "blocked",
					cardId: card.id,
					reason: verdict.feedback,
				})
				break
			}
		}
	}

	private saveTranscript(card: DbCard, result: PiResult): string {
		const dir = path.join(this.transcriptsDir, this.projectId, card.id)
		mkdirSync(dir, { recursive: true })
		const file = path.join(dir, `attempt-${Date.now()}.txt`)
		writeFileSync(file, `# exit ${result.exitCode}\n\n## stdout\n${result.stdout}\n\n## stderr\n${result.stderr}\n`)
		return file
	}

	// Pipeline columns in board order, EXCLUDING park columns (needs-human /
	// needs-director). Park columns are off the linear flow, so a pass/fail must
	// never advance a card into or out of them by positional adjacency.
	private pipelineColumns(): DbColumn[] {
		return this.dbStore
			.getColumnsByProject(this.projectId)
			.filter((c) => !isParkColumn(c))
	}

	private async moveForward(card: DbCard, verdict: Verdict): Promise<void> {
		const columns = this.pipelineColumns()
		const currentIndex = columns.findIndex((c) => c.id === card.columnId)

		if (currentIndex < 0 || currentIndex >= columns.length - 1) {
			// Already at last column or column not found — stay put
			emitEvent(this.onEvent, {
				type: "blocked",
				cardId: card.id,
				reason: "No next column",
			})
			return
		}

		const nextColumn = columns[currentIndex + 1]
		if (!nextColumn) {
			emitEvent(this.onEvent, { type: "blocked", cardId: card.id, reason: "No next column" })
			return
		}
		const nextPos = this.dbStore.getCardsByProject(this.projectId).filter(
			(c) => c.columnId === nextColumn.id
		).length

		this.dbStore.moveCard(card.id, nextColumn.id, nextPos, false)
		this.dbStore.unclaimCard(card.id)

		await this.tryNotify({
			type: columnNotificationType(nextColumn.name) ?? "deploy-done",
			projectId: this.projectId,
			projectTitle: "",
			cardId: card.id,
			cardTitle: card.title,
			column: nextColumn.name,
			feedback: verdict.feedback,
		})

		emitEvent(this.onEvent, {
			type: "passed",
			cardId: card.id,
			feedback: verdict.feedback,
			artifacts: verdict.artifacts,
		})
	}

	private async kickback(card: DbCard, verdict: Verdict): Promise<void> {
		const columns = this.pipelineColumns()
		const currentIndex = columns.findIndex((c) => c.id === card.columnId)

		// This fail consumes a retry. If the NEW count reaches the ceiling, the
		// card is exhausted and parks at needs-human in THIS pass (no separate
		// re-claim). "after N retries -> needs-human" is thus literal.
		const newRetry = card.retryCount + 1
		if (newRetry >= this.maxRetries) {
			this.dbStore.updateCard(card.id, { retryCount: newRetry })
			const needsHumanColumn = this.dbStore
				.getColumnsByProject(this.projectId)
				.find((c) => c.name.toLowerCase().includes("human"))
			if (!needsHumanColumn) {
				// No needs-human column configured — a hard misconfiguration. Unclaim
				// so the single worker isn't wedged; surface it loudly.
				this.dbStore.unclaimCard(card.id)
				emitEvent(this.onEvent, {
					type: "needsHuman",
					cardId: card.id,
					reason: `Retry exhausted (${newRetry} >= ${this.maxRetries}) but NO needs-human column exists`,
				})
				return
			}
			const pos = this.dbStore
				.getCardsByProject(this.projectId)
				.filter((c) => c.columnId === needsHumanColumn.id).length

			this.dbStore.moveCard(card.id, needsHumanColumn.id, pos, false)
			this.dbStore.unclaimCard(card.id)

			await this.tryNotify({
				type: "retry-exhausted",
				projectId: this.projectId,
				projectTitle: "",
				cardId: card.id,
				cardTitle: card.title,
				column: needsHumanColumn.name,
				feedback: `Retry count ${newRetry} >= max ${this.maxRetries}`,
			})

			emitEvent(this.onEvent, {
				type: "needsHuman",
				cardId: card.id,
				reason: `Retry count ${newRetry} >= max ${this.maxRetries}`,
			})
			return
		}

		// Normal kickback: move back one column, incrementing the retry counter.
		if (currentIndex <= 0) {
			// Already at first column — just increment retry and unclaim.
			this.dbStore.updateCard(card.id, { retryCount: newRetry })
			this.dbStore.unclaimCard(card.id)
			emitEvent(this.onEvent, {
				type: "failed",
				cardId: card.id,
				feedback: verdict.feedback,
			})
			return
		}

		const prevColumn = columns[currentIndex - 1]
		if (!prevColumn) {
			this.dbStore.updateCard(card.id, { retryCount: card.retryCount + 1 })
			this.dbStore.unclaimCard(card.id)
			emitEvent(this.onEvent, { type: "failed", cardId: card.id, feedback: verdict.feedback })
			return
		}
		const pos = this.dbStore
			.getCardsByProject(this.projectId)
			.filter((c) => c.columnId === prevColumn.id).length

		this.dbStore.moveCard(card.id, prevColumn.id, pos, true)
		this.dbStore.unclaimCard(card.id)

		await this.tryNotify({
			type: columnNotificationType(prevColumn.name) ?? "needs-human",
			projectId: this.projectId,
			projectTitle: "",
			cardId: card.id,
			cardTitle: card.title,
			column: prevColumn.name,
			feedback: verdict.feedback,
		})

		emitEvent(this.onEvent, {
			type: "failed",
			cardId: card.id,
			feedback: verdict.feedback,
		})
	}
}
