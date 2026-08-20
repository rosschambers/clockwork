import { parseVerdict, isParseFailureVerdict, type Verdict } from "./verdict.ts"
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
	// Watchdog: kill pi after this many ms so a hung session can't strand a card.
	timeoutMs?: number
}

// Generous default watchdog — the local model is slow but free, so allow a long
// session, but never infinite (a hang must resolve the card, not vanish it).
const DEFAULT_PI_TIMEOUT_MS = 15 * 60 * 1000

// clockwork is background work by definition, so it targets the frame-arbiter
// LOW port (a Hugo request preempts it). This is the provider the container's
// pi config must define -> http://frame:8185/v1 (dense 27B).
export const DEFAULT_PI_PROVIDER = "frame-dense-low"

// C4 extraction fallback prompt: when the work session omitted the verdict JSON,
// a second call reads the transcript and emits ONLY the verdict object.
const EXTRACTION_PROMPT = `You are a verdict extractor. Read the agent transcript below and decide the outcome of the stage. Output EXACTLY ONE JSON object and NOTHING else:
{"verdict": "pass" | "fail" | "blocked", "feedback": "<one sentence>", "artifacts": []}
- "pass": the transcript shows the stage's work was completed successfully.
- "fail": the work was attempted but did not meet the bar.
- "blocked": the agent could not proceed.
Do not add any prose before or after the JSON.`

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
		// stdin MUST be closed: pi may block waiting on stdin otherwise, leaving the
		// process alive/unread and our stream reads never reaching EOF (a hang that
		// stalled the whole worker — diagnosed live 2026-08-19).
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...(invocation.env ?? {}) },
	})

	// Drain both pipes concurrently AND wait for exit together. Reading a pipe to
	// text only resolves at EOF (process exit); doing them concurrently avoids a
	// pipe-buffer deadlock where one full pipe blocks the process while we await
	// the other.
	//
	// WATCHDOG: the local model is slow-but-free, so the timeout is generous — but
	// it MUST exist. Some prompts have hung pi indefinitely after the model already
	// finished (content-specific, under investigation); without a watchdog that
	// strands the card forever. On timeout we kill pi and return what we have, so
	// the caller records a blocked attempt and the card resolves (retry ->
	// needs-human) instead of vanishing.
	const timeoutMs = invocation.timeoutMs ?? DEFAULT_PI_TIMEOUT_MS
	let timedOut = false
	const collected = { out: "", err: "" }
	const readOut = Bun.readableStreamToText(proc.stdout).then((t) => (collected.out = t))
	const readErr = Bun.readableStreamToText(proc.stderr).then((t) => (collected.err = t))
	const watchdog = new Promise<void>((resolve) => {
		setTimeout(() => {
			timedOut = true
			try {
				proc.kill()
			} catch {}
			resolve()
		}, timeoutMs)
	})
	await Promise.race([Promise.all([readOut, readErr, proc.exited]), watchdog])

	return {
		stdout: collected.out,
		stderr: timedOut ? collected.err + `\n[clockwork: pi killed after ${timeoutMs}ms watchdog]` : collected.err,
		exitCode: timedOut ? 124 : proc.exitCode ?? 0,
	}
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
			try {
				await this.processCard(card)
			} catch (err) {
				// Crash safety: a card must NEVER be left claimed by a thrown
				// processCard. Unclaim it, surface the error, keep the loop alive.
				this.dbStore.unclaimCard(card.id)
				emitEvent(this.onEvent, { type: "blocked", cardId: card.id, reason: `processCard threw: ${String(err)}` })
			}
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

		let verdict = parseVerdict(result.stdout)

		// C4 — grammar-constrained verdict extraction fallback. If the verdict is
		// blocked ONLY because the output had no parseable verdict (the model did the
		// work but omitted the JSON trailer — common with reasoning models), make a
		// SECOND, tightly-constrained call that asks the model to read its own
		// transcript and emit ONLY the verdict JSON. A model-declared block is left
		// alone (nothing to rescue).
		if (isParseFailureVerdict(verdict)) {
			try {
				const extraction = await invokeFn({
					prompt: EXTRACTION_PROMPT + "\n\n<transcript>\n" + result.stdout.slice(-6000) + "\n</transcript>",
					cwd: this.projectRoot,
					provider: this.piProvider,
					model: column.model ?? undefined,
					env: { CLOCKWORK_CARD_ID: card.id },
				})
				const rescued = parseVerdict(extraction.stdout)
				if (!isParseFailureVerdict(rescued)) {
					verdict = rescued
				}
			} catch {
				// Extraction is best-effort; on failure keep the blocked verdict
				// (which now resolves the card via kickback, not a stall).
			}
		}

		// Persist the full transcript + verdict as an attempt (the check-in
		// debugging surface). NONE of this may throw out of processCard: a
		// transcript-write failure must degrade to a null path but still record the
		// attempt, and any persistence hiccup must not leave the card claimed.
		let transcriptPath: string | null = null
		try {
			transcriptPath = this.saveTranscript(card, result)
		} catch (err) {
			emitEvent(this.onEvent, { type: "blocked", cardId: card.id, reason: `transcript write failed (continuing): ${String(err)}` })
		}
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
				// A blocked verdict (often: the model produced work but no parseable
				// JSON verdict trailer) must RESOLVE the card, not strand it. Treat it
				// as a retry via the same kickback path so repeated no-verdict runs
				// eventually park at needs-human instead of looping/vanishing.
				emitEvent(this.onEvent, { type: "blocked", cardId: card.id, reason: verdict.feedback })
				await this.kickback(card, verdict)
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
			// Already at last column or column not found — stay put, but ALWAYS
			// unclaim so the card is never left held by a finished run.
			this.dbStore.unclaimCard(card.id)
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
