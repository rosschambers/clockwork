import { parseVerdict, extractAssistantText, isParseFailureVerdict, type Verdict } from "./verdict.ts"
import { DbStore, type DbCard, type DbColumn } from "./db.ts"
import { notify, columnNotificationType, sendSms, smsForNeedsHuman, smsForMilestoneComplete, type NotifyEvent } from "./notify.ts"
import { assembleContext, type ThreadEntry } from "./context.ts"
import { classifyParkReason } from "./classify.ts"
import { targetsSatisfied } from "./gate.ts"
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
	// SMS-to-Ross via the exocortex async-workload-complete webhook. When set, the
	// worker texts on a card parking at needs-human (with the block reason) and on a
	// configured milestone completing. Separate from notifyUrl (the event webhook).
	smsUrl?: string
	smsToken?: string
	// When ALL cards in the project reach the terminal Done column, this fires the
	// "milestone complete" SMS. Optional label + a shell command to produce/copy a
	// play-testable build to a shared location (its stdout's last line is texted).
	milestoneLabel?: string
	buildCopyCommand?: string
	// pi watchdog tuning forwarded into every PiInvocation this worker makes.
	piInactivityMs?: number
	piMaxRuntimeMs?: number
	// Arbiter preemption handling: a LOW-port pi call cancelled by higher-priority
	// (Hugo/murmur8) traffic returns a 503 "preempted" — that is BY DESIGN and must
	// not count as a card failure. On preemption the worker backs off and re-invokes
	// the same stage, up to maxPreemptionRetries, without consuming a card retry.
	preemptionBackoffMs?: number
	maxPreemptionRetries?: number
}

// A pi result is an arbiter preemption when the process failed (non-zero exit) and
// the arbiter's preemption marker is in stderr. Preemption is expected on the LOW
// port and must be treated as a transient, never as a verdict.
export function isPreemption(result: PiResult): boolean {
	return result.exitCode !== 0 && /preempted by higher-priority request/i.test(result.stderr)
}

// Detect infrastructure failures that happened INSIDE pi's auto-retry mechanism.
// When pi handles preemptions/timeouts internally, it exits cleanly (code 0) but
// the stdout event stream contains `auto_retry_end` with `success: false` and/or
// `agent_end` events with `stopReason: "error"`. These are NOT card failures and
// must not consume retries.
const INFRA_ERROR_PATTERNS = [
	/request timed out/i,
	/preempted by higher-priority request/i,
	/503/,
	/connection refused/i,
	/ECONNREFUSED/,
	/ECONNRESET/,
]

export function isInfrastructureFailure(result: PiResult): boolean {
	// A watchdog-timeout (exit 124) can WRAP a preemption storm: clockwork's own
	// inactivity/max-runtime watchdog kills the session (exit 124) while the
	// preemption evidence sits in STDOUT (the pi event stream) and only the watchdog
	// message is in stderr — so isPreemption (stderr-only) misses it. Scan stdout for
	// unambiguous infra markers so a preemption-driven timeout is NOT charged as a
	// card retry. A 124 with no such markers is a genuine hang/loop (a real card
	// failure) and correctly falls through to `false`. (prism-drift M2-15: preemption
	// storms exhausted all 3 retries and parked correct, tested, visually-QA-green work.)
	if (result.exitCode === 124) {
		return INFRA_ERROR_PATTERNS.some((p) => p.test(result.stdout))
	}
	// Any other non-zero exit is caught by isPreemption (a clean arbiter preemption).
	if (result.exitCode !== 0) {
		return false
	}
	// Look for auto_retry_end with success: false — unambiguous pi-level retry exhaustion.
	const retryEndMatch = result.stdout.match(/"type"\s*:\s*"auto_retry_end"[^}]*"success"\s*:\s*false/)
	if (retryEndMatch) {
		return true
	}
	// Look for a final agent_end with stopReason: "error" and an infra error message.
	const agentEndPattern = /"type"\s*:\s*"agent_end"[^}]*"stopReason"\s*:\s*"error"[^}]*"errorMessage"\s*:\s*"([^"]*)"/g
	let match: RegExpExecArray | null = null
	let lastErrorMessage = ""
	while ((match = agentEndPattern.exec(result.stdout)) !== null) {
		lastErrorMessage = match[1] ?? ""
	}
	if (lastErrorMessage && INFRA_ERROR_PATTERNS.some((p) => p.test(lastErrorMessage))) {
		return true
	}
	return false
}

export type InvokePiFn = (invocation: PiInvocation) => Promise<PiResult>

// The subset of RepoWorkspace the worker needs. Injected (not imported directly)
// so tests can supply a fake and so a worker with no repo configured degrades to
// running pi in the shared projectRoot (the pre-wiring behavior).
export interface RepoWorkspaceLike {
	prepareCardWorkspace(
		projectId: string,
		cardId: string,
		githubRepo: string,
	): Promise<{ repoPath: string; branch: string }>
	// Fast-forward the pipeline repo from its GitHub upstream BEFORE a card's
	// workspace is prepared. Optional so existing fakes without it still satisfy
	// the interface; only attempted when the project has a github_upstream set.
	syncDownFromUpstream?(
		pipelineRepoPath: string,
		upstreamUrl: string,
		branch: string,
	): Promise<{ ok: boolean; action: "ff" | "noop" | "diverged" | "error"; ahead: number; behind: number }>
	commitCardWork(
		repoPath: string,
		cardId: string,
		columnId: string,
	): Promise<boolean>
	// Merge the card's branch into the default branch. Called when a card reaches
	// the terminal Done column, so later cards (which branch off the default) see
	// the finished work. Optional so a minimal fake need not implement it.
	mergeCardToMain?(
		repoPath: string,
		cardId: string,
		branch: string,
	): Promise<boolean>
	// Push the pipeline repo's default branch UP to its GitHub upstream after a
	// card's merge to the default branch has already landed locally. Optional so
	// existing fakes without it still satisfy the interface; only attempted when
	// the project has a github_upstream set. A non-fast-forward rejection is
	// non-blocking — the card is already done (design §B).
	pushUpToUpstream?(
		pipelineRepoPath: string,
		upstreamUrl: string,
		branch: string,
	): Promise<{ ok: boolean; rejected: boolean }>
	// The card branch's changed-file list versus a base ref, used by the
	// deterministic deliverable gate to check a passing card actually touched the
	// code it declared. Optional so a minimal fake need not implement it; when
	// absent the gate is skipped and a pass proceeds unchanged.
	computeChangedFiles?(
		repoPath: string,
		base: string,
		cardBranch: string,
	): Promise<string[]>
}

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
	// Watchdog tuning. inactivityMs: kill after this long with NO pi output (resets
	// on each chunk). maxRuntimeMs: absolute backstop on total session length.
	inactivityMs?: number
	maxRuntimeMs?: number
}

// Watchdog model: an INACTIVITY window, not a wall-clock cap. The local reasoning
// model streams output per turn while it works (proven: docs/plans/2026-08-20-pi-
// hang-investigation.md); a session is "hung" only when it goes silent for longer
// than this. Reset on every chunk of pi output. This kills a genuinely stalled
// session promptly while NEVER killing one that is still making progress, however
// long the whole card takes.
export const DEFAULT_PI_INACTIVITY_MS = 10 * 60 * 1000

// Backstop only: absolute ceiling on a single pi session so a pathological "trickle
// a byte every few minutes forever" session still terminates. The inactivity window
// is the real control; this just bounds the worst case.
export const DEFAULT_PI_MAX_RUNTIME_MS = 60 * 60 * 1000

// Cap on the in-memory capture of each of pi's stdout/stderr streams. A
// thinking-heavy `--mode json` turn emits a per-token event flood: a real
// prism-drift M2-16b attempt produced a 2.1 GB transcript and drove the worker
// to 16.7 GB RSS, which starved the watchdog's setInterval callback so it fired
// "inactivity" while tokens were still streaming (2026-08-28). We only ever need
// the TAIL — the verdict JSON and the infra-error markers (agent_end /
// auto_retry_end) all appear at the very end of the stream, and the verdict
// extractor already reads only the last few KB. So keep a bounded tail (drop the
// head) instead of the whole firehose. 8 MB is comfortably larger than any real
// verdict tail while making OOM impossible.
export const PI_STREAM_CAPTURE_CAP_BYTES = 8 * 1024 * 1024

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

// The subset of Bun.Subprocess that invokePi drives. Injected so tests supply a
// fake subprocess (scheduled stdout/stderr chunks + controllable exit/kill) and
// the streaming + watchdog logic is exercised with no real `pi` process.
export interface PiSubprocessLike {
	stdout: ReadableStream<Uint8Array>
	stderr: ReadableStream<Uint8Array>
	exited: Promise<number>
	readonly exitCode: number | null
	kill(): void
}

export type PiSpawn = (
	args: string[],
	options: {
		cwd: string
		stdin: "ignore"
		stdout: "pipe"
		stderr: "pipe"
		// process.env values are string | undefined; match that so the real
		// Bun.spawn call (which spreads process.env) type-checks unchanged.
		env: Record<string, string | undefined>
	},
) => PiSubprocessLike

// Run one pi session non-interactively against a frame model. The prompt is the
// fully-assembled context (column prompt + card + memory). Model + skills come
// from the column. Bun.spawn returns a Subprocess synchronously; we await
// `.exited` and read the piped streams. The spawn is injected (default Bun.spawn)
// so tests drive a fake subprocess with no real `pi`.
export async function invokePi(
	invocation: PiInvocation,
	spawn: PiSpawn = Bun.spawn as unknown as PiSpawn,
): Promise<PiResult> {
	const args = ["pi", "-p"]
	// --mode json streams one event object per line, per token (thinking/text
	// deltas). This gives the inactivity watchdog a sub-second heartbeat during a
	// long model turn (text mode buffers a whole turn, starving the watchdog and
	// getting a working session killed). The verdict is reconstructed from the
	// event stream via extractAssistantText.
	args.push("--mode", "json")
	// Bound per-turn reasoning. The model config only declares reasoning:true (no
	// level), so pi defaults to effectively-unbounded thinking and sessions spiral
	// (a single stage ground 75 min / 71k tokens). "medium" keeps each turn
	// decisive — plan the step, act — which is enough quality for well-scoped cards
	// with a written plan + checkable DoD, and keeps stages to minutes not tens.
	args.push("--thinking", "medium")
	args.push("--provider", invocation.provider ?? DEFAULT_PI_PROVIDER)
	if (invocation.model) {
		args.push("--model", invocation.model)
	}
	for (const skill of invocation.skills ?? []) {
		args.push("--skill", skill)
	}
	args.push(invocation.prompt)

	// Inject the preload script that disables undici's body/headers timeout.
	// pi's cli.js hardcodes a 5-minute default BEFORE settings load, and the
	// later reconfiguration in main.js is unreliable. The preload runs first
	// (via NODE_OPTIONS=--require) and sets the dispatcher to no timeout.
	const preloadPath = new URL("../scripts/pi-no-timeout-preload.cjs", import.meta.url).pathname
	const nodeOptions = [process.env.NODE_OPTIONS, `--require ${preloadPath}`].filter(Boolean).join(" ")

	const proc = spawn(args, {
		cwd: invocation.cwd,
		// stdin MUST be closed: pi may block waiting on stdin otherwise, leaving the
		// process alive/unread and our stream reads never reaching EOF (a hang that
		// stalled the whole worker — diagnosed live 2026-08-19).
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...(invocation.env ?? {}), NODE_OPTIONS: nodeOptions },
	})

	// Stream both pipes chunk-by-chunk into growing accumulators, stamping
	// lastActivityAt on every chunk. Reading incrementally (not resolved-at-EOF)
	// means a watchdog kill mid-session KEEPS whatever pi already emitted — the fix
	// for the empty-transcript artifact (docs/plans/2026-08-20-pi-hang-investigation.md).
	// Both readers run concurrently to avoid a pipe-buffer deadlock where one full
	// pipe blocks the process while we drain the other.
	//
	// WATCHDOG: an INACTIVITY window (reset on output) plus a total-runtime backstop.
	// A session is killed only after inactivityMs of silence, or after maxRuntimeMs
	// regardless of activity. On kill we return the accumulators, so the caller records
	// the partial transcript and the card resolves (retry -> needs-human) instead of
	// vanishing.
	const inactivityMs = invocation.inactivityMs ?? DEFAULT_PI_INACTIVITY_MS
	const maxRuntimeMs = invocation.maxRuntimeMs ?? DEFAULT_PI_MAX_RUNTIME_MS

	let outAcc = ""
	let errAcc = ""
	let lastActivityAt = Date.now()
	const startedAt = Date.now()
	let timedOut = false
	let killReason: "inactivity" | "runtime" | null = null

	const decoder = new TextDecoder()
	async function drain(
		stream: ReadableStream<Uint8Array>,
		onChunk: (text: string) => void,
	): Promise<void> {
		const reader = stream.getReader()
		try {
			for (;;) {
				const { done, value } = await reader.read()
				if (done) {
					break
				}
				if (value) {
					onChunk(decoder.decode(value, { stream: true }))
				}
			}
		} catch {
			// Reader closed/errored (e.g. on kill) — whatever we accumulated stands.
		} finally {
			try {
				reader.releaseLock()
			} catch {}
		}
	}

	// Append a chunk but keep only the trailing PI_STREAM_CAPTURE_CAP_BYTES, so a
	// multi-GB token firehose cannot grow the string (and the worker's heap)
	// unbounded. Dropping the HEAD is safe: the verdict and infra markers live at
	// the tail. Note this is a char cap, not a byte cap — close enough for a
	// safety bound and avoids per-chunk byte-length work.
	function boundedAppend(acc: string, chunk: string): string {
		const next = acc + chunk
		if (next.length <= PI_STREAM_CAPTURE_CAP_BYTES) {
			return next
		}
		return next.slice(next.length - PI_STREAM_CAPTURE_CAP_BYTES)
	}

	const readOut = drain(proc.stdout, (t) => {
		outAcc = boundedAppend(outAcc, t)
		lastActivityAt = Date.now()
	})
	const readErr = drain(proc.stderr, (t) => {
		errAcc = boundedAppend(errAcc, t)
		lastActivityAt = Date.now()
	})

	// Watchdog: poll for inactivity or runtime-backstop breach. (Task 4/5 refine the
	// kill-reason message; Task 3 establishes the poll + partial-capture behaviour.)
	let tick: ReturnType<typeof setInterval> | null = null
	const watchdog = new Promise<void>((resolve) => {
		tick = setInterval(() => {
			const now = Date.now()
			const idleFor = now - lastActivityAt
			const ranFor = now - startedAt
			if (idleFor >= inactivityMs) {
				killReason = "inactivity"
			} else if (ranFor >= maxRuntimeMs) {
				killReason = "runtime"
			}
			if (killReason !== null) {
				timedOut = true
				if (tick !== null) {
					clearInterval(tick)
				}
				try {
					proc.kill()
				} catch {}
				resolve()
			}
		}, Math.max(20, Math.min(inactivityMs, 1000)))
	})

	await Promise.race([Promise.all([readOut, readErr, proc.exited]), watchdog])
	// Stop the poller: on a clean exit the watchdog Promise never resolves, so its
	// interval would otherwise leak and keep the event loop alive.
	if (tick !== null) {
		clearInterval(tick)
	}
	// Ensure any in-flight reads settle after a kill so accumulators are complete.
	await Promise.allSettled([readOut, readErr])

	return {
		stdout: outAcc,
		stderr: timedOut
			? errAcc + `\n[clockwork: pi killed after ${killReason === "inactivity" ? `${inactivityMs}ms inactivity` : `${maxRuntimeMs}ms max-runtime`} watchdog]`
			: errAcc,
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

// The terminal column — a card here is finished. moveForward MAY advance a card
// INTO it, but the worker must never CLAIM a card that is already in it (else it
// re-runs the model on a done card forever, getting "No next column" -> a tight
// loop that also starves the other cards on a single worker). Distinct from
// isParkColumn because Done is still a real pipeline column for movement.
function isTerminalColumn(column: DbColumn): boolean {
	return column.name.toLowerCase().trim() === "done"
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
	public readonly smsUrl: string | undefined
	public readonly smsToken: string | undefined
	public readonly milestoneLabel: string | undefined
	public readonly buildCopyCommand: string | undefined
	public readonly piInactivityMs: number
	public readonly piMaxRuntimeMs: number
	public readonly preemptionBackoffMs: number
	public readonly maxPreemptionRetries: number

	private running = false
	private _loopPromise: Promise<void> = Promise.resolve()
	private _invokePi: InvokePiFn | null = null
	private _repoWorkspace: RepoWorkspaceLike | null = null

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
		this.smsUrl = config.smsUrl
		this.smsToken = config.smsToken
		this.milestoneLabel = config.milestoneLabel
		this.buildCopyCommand = config.buildCopyCommand
		this.piInactivityMs = config.piInactivityMs ?? DEFAULT_PI_INACTIVITY_MS
		this.piMaxRuntimeMs = config.piMaxRuntimeMs ?? DEFAULT_PI_MAX_RUNTIME_MS
		this.preemptionBackoffMs = config.preemptionBackoffMs ?? 30000
		this.maxPreemptionRetries = config.maxPreemptionRetries ?? 20
	}

	set invokePi(fn: InvokePiFn | null) {
		this._invokePi = fn
	}

	get invokePi(): InvokePiFn | null {
		return this._invokePi
	}

	set repoWorkspace(workspace: RepoWorkspaceLike | null) {
		this._repoWorkspace = workspace
	}

	get repoWorkspace(): RepoWorkspaceLike | null {
		return this._repoWorkspace
	}

	private async tryNotify(event: NotifyEvent): Promise<void> {
		if (!this.notifyUrl || !this.notifyToken) {
			return
		}
		await notify(event, this.notifyUrl, this.notifyToken)
	}

	private async trySms(message: string): Promise<void> {
		if (!this.smsUrl || !this.smsToken) {
			return
		}
		await sendSms(message, { url: this.smsUrl, token: this.smsToken })
	}

	// When every card in the project has reached the terminal Done column, fire the
	// milestone-complete SMS. If a build-copy command is configured, run it first
	// and include its last stdout line (the shared build path) in the text. Called
	// after a card lands in Done. Best-effort: never throws into card processing.
	private async maybeMilestoneComplete(): Promise<void> {
		if (!this.smsUrl || !this.smsToken) {
			return
		}
		const cards = this.dbStore.getCardsByProject(this.projectId)
		if (cards.length === 0) {
			return
		}
		const columns = this.dbStore.getColumnsByProject(this.projectId)
		const doneIds = new Set(
			columns.filter((c) => isTerminalColumn(c)).map((c) => c.id),
		)
		const allDone = cards.every((c) => doneIds.has(c.columnId))
		if (!allDone) {
			return
		}

		let buildPath: string | undefined
		if (this.buildCopyCommand) {
			try {
				const proc = Bun.spawn(["bash", "-lc", this.buildCopyCommand], {
					stdout: "pipe",
					stderr: "pipe",
				})
				const out = proc.stdout ? await new Response(proc.stdout).text() : ""
				await proc.exited
				const lines = out.trim().split("\n").filter((l) => l.trim() !== "")
				buildPath = lines.length > 0 ? lines[lines.length - 1] : undefined
			} catch (err) {
				console.error(`[clockwork] build-copy command failed: ${String(err)}`)
			}
		}

		const label = this.milestoneLabel ?? "all cards done"
		await this.trySms(smsForMilestoneComplete(label, buildPath))
	}

	start(): void {
		if (this.running) {
			return
		}
		// Restart recovery: a previous run of THIS worker may have been killed (deploy,
		// crash) while a card was claimed, leaving an orphaned claim that no live worker
		// will re-pick — deadlocking that card and anything depending on it. Free our own
		// stale claims before looping so in-flight cards are re-processed on restart.
		const recovered = this.dbStore.releaseClaimsByWorker(this.workerId)
		if (recovered > 0) {
			emitEvent(this.onEvent, { type: "idle", reason: `recovered ${recovered} orphaned claim(s) on startup` })
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
		// Never claim from park (needs-human/director) OR terminal (Done) columns.
		const unclaimableColumnIds = new Set(
			this.dbStore
				.getColumnsByProject(this.projectId)
				.filter((c) => isParkColumn(c) || isTerminalColumn(c))
				.map((c) => c.id),
		)
		const doneColumnIds = new Set(
			this.dbStore
				.getColumnsByProject(this.projectId)
				.filter((c) => isTerminalColumn(c))
				.map((c) => c.id),
		)
		const cardsById = new Map(
			this.dbStore.getCardsByProject(this.projectId).map((c) => [c.id, c]),
		)
		const eligible = this.dbStore.getCardsByProject(this.projectId).filter((card) => {
			if (card.claimState !== null) return false
			// Per-stage eligibility: a card is only ineligible when ITS CURRENT stage's
			// retry budget is exhausted, not when some other stage's transient failures
			// added up. This mirrors the per-stage PARK decision in kickback.
			if ((card.stageRetries[card.columnId] ?? 0) >= this.maxRetries) return false
			if (unclaimableColumnIds.has(card.columnId)) return false
			// Dependency gate: if this card depends on another, do not claim it until
			// that card has reached the terminal Done column. This prevents dependent
			// cards from being run early, failing their in-prompt dependency check, and
			// burning retries into a needless needs-human park. A dangling depends_on
			// (referenced card gone) is treated as satisfied so a card can't wedge forever.
			if (card.dependsOn) {
				const dep = cardsById.get(card.dependsOn)
				if (dep && !doneColumnIds.has(dep.columnId)) return false
			}
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

		// Per-card git workspace: check out a `card/<id>` branch so each card's work
		// is isolated and, on success, committed with the card id (design decision 6,
		// "branch-per-card"). If no workspace is configured or the project has no repo,
		// fall back to the shared projectRoot so a repo-less project still runs.
		let workDir = this.projectRoot
		const project = this.dbStore.getProjectById(this.projectId)
		const githubRepo = project?.githubRepo ?? null
		const githubUpstream = project?.githubUpstream ?? null
		const pipelineRepoPath = `${this.projectRoot}/${this.projectId}`

		// Sync-down BEFORE the workspace clone pulls fresh code from the pipeline
		// repo: fast-forward the pipeline repo from its GitHub upstream. On a real
		// divergence (both ahead and behind) or a fetch error we FAIL CLOSED — the
		// card must not run against ambiguous code; route it to Needs-Director and
		// return (design §A). Only attempted when the project names a github_upstream.
		if (this._repoWorkspace && githubRepo && githubUpstream && this._repoWorkspace.syncDownFromUpstream) {
			const sync = await this._repoWorkspace.syncDownFromUpstream(
				pipelineRepoPath,
				githubUpstream,
				"main",
			)
			if (sync.action === "diverged" || sync.action === "error") {
				await this.routeSyncDiverged(card, sync.ahead, sync.behind, sync.action)
				return
			}
		}

		if (this._repoWorkspace && githubRepo) {
			try {
				const prepared = await this._repoWorkspace.prepareCardWorkspace(
					this.projectId,
					card.id,
					githubRepo,
				)
				workDir = prepared.repoPath
			} catch (err) {
				emitEvent(this.onEvent, { type: "blocked", cardId: card.id, reason: `workspace prepare failed: ${String(err)}` })
				this.dbStore.unclaimCard(card.id)
				return
			}
		}

		emitEvent(this.onEvent, { type: "running", cardId: card.id })

		const startedAt = new Date()
		const piArgs = {
			prompt: assembled.systemPrompt,
			cwd: workDir,
			provider: this.piProvider,
			model: column.model ?? undefined,
			skills: column.skills,
			inactivityMs: this.piInactivityMs,
			maxRuntimeMs: this.piMaxRuntimeMs,
			env: {
				CLOCKWORK_PROJECT_ROOT: this.projectRoot,
				CLOCKWORK_CARD_ID: card.id,
				CLOCKWORK_WORKER_ID: this.workerId,
			},
		}
		// Arbiter-preemption retry: a LOW-port call cancelled by higher-priority
		// (Hugo/murmur8) traffic returns a 503 "preempted" — that is BY DESIGN and is
		// NOT a card failure. Re-invoke the same stage after a backoff, up to a cap,
		// WITHOUT saving an attempt or consuming a card retry. Only if preemptions
		// exhaust the cap do we release the card (unclaimed, unchanged) so it is simply
		// re-tried on a later loop rather than parked for someone else's priority.
		let result = await invokeFn(piArgs)
		let preemptions = 0
		while (isPreemption(result) && preemptions < this.maxPreemptionRetries) {
			preemptions += 1
			emitEvent(this.onEvent, { type: "blocked", cardId: card.id, reason: `arbiter preempted (transient) — retry ${preemptions}/${this.maxPreemptionRetries} after backoff` })
			await new Promise((resolve) => setTimeout(resolve, this.preemptionBackoffMs))
			result = await invokeFn(piArgs)
		}
		if (isPreemption(result)) {
			// Still preempted after the cap — leave the card exactly as it was (no
			// attempt, no retry consumed, no kickback); unclaim so the loop re-picks it.
			this.dbStore.unclaimCard(card.id)
			emitEvent(this.onEvent, { type: "blocked", cardId: card.id, reason: `arbiter preemption did not clear after ${this.maxPreemptionRetries} retries; leaving card unchanged for a later attempt` })
			return
		}

		// Infrastructure failure inside pi's own auto-retry: the process exited
		// cleanly (code 0) but the session was killed by timeouts or preemptions
		// that pi retried internally. This is NOT a card failure — leave the card
		// unchanged (no attempt, no retry consumed) just like a direct preemption.
		if (isInfrastructureFailure(result)) {
			this.dbStore.unclaimCard(card.id)
			emitEvent(this.onEvent, { type: "blocked", cardId: card.id, reason: "pi session failed due to infrastructure errors (timeouts/preemptions inside pi auto-retry); leaving card unchanged for a later attempt" })
			return
		}

		// pi runs in --mode json, so stdout is a stream of per-line event objects.
		// Reconstruct the model's final reply text before parsing the verdict.
		const replyText = extractAssistantText(result.stdout)
		let verdict = parseVerdict(replyText)

		// C4 — grammar-constrained verdict extraction fallback. If the verdict is
		// blocked ONLY because the output had no parseable verdict (the model did the
		// work but omitted the JSON trailer — common with reasoning models), make a
		// SECOND, tightly-constrained call that asks the model to read its own
		// transcript and emit ONLY the verdict JSON. A model-declared block is left
		// alone (nothing to rescue).
		if (isParseFailureVerdict(verdict)) {
			try {
				const extraction = await invokeFn({
					prompt: EXTRACTION_PROMPT + "\n\n<transcript>\n" + replyText.slice(-6000) + "\n</transcript>",
					cwd: workDir,
					provider: this.piProvider,
					model: column.model ?? undefined,
					inactivityMs: this.piInactivityMs,
					maxRuntimeMs: this.piMaxRuntimeMs,
					env: { CLOCKWORK_CARD_ID: card.id },
				})
				const rescued = parseVerdict(extractAssistantText(extraction.stdout))
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

		// Commit the card's work on its branch after any stage that may have changed
		// files, so later stages (review, QA) and later cards see COMMITTED state, not
		// leaked uncommitted edits — AND so a session that was killed mid-work (the
		// inactivity/max-runtime watchdog, exit 124, which yields no verdict → blocked)
		// preserves its partial progress for the NEXT attempt instead of throwing it
		// away. Without this, a card too big for one session can never finish: every
		// retry starts from a clean tree, redoes the same first-N-minutes of work, and
		// is killed again at the same wall — three 60-min runs make ZERO cumulative
		// progress (diagnosed on M2-12 boss, 2026-08-26). The subsequent kickback's
		// workspace reset would delete uncommitted files, so committing here is what
		// makes the work survive the reset. commitCardWork is best-effort: an empty
		// commit (stage changed nothing) or a git hiccup must not strand the card.
		if (this._repoWorkspace && githubRepo && workDir !== this.projectRoot) {
			try {
				await this._repoWorkspace.commitCardWork(workDir, card.id, card.columnId)
			} catch {
				// No changes to commit, or a transient git failure — the verdict still
				// drives the card; a missing commit is not itself a card failure.
			}
		}

		switch (verdict.verdict) {
			case "pass": {
				// Deterministic deliverable gate: a "pass" on a card that declared
				// code targets but whose branch diff touched none of them is dishonest
				// (docs-only / plan-only work). Convert it into a kickback so the card
				// retries instead of advancing on undone work.
				const gateFailure = await this.deliverableGateFails(card, workDir)
				if (gateFailure !== null) {
					await this.kickback(card, {
						verdict: "fail",
						feedback: gateFailure,
						artifacts: verdict.artifacts,
					})
					break
				}
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

	// Deterministic deliverable gate: if the card declares code targets but its
	// branch diff changed none of them (docs-only / plan-only), the "pass" is
	// dishonest. Returns a failure reason string when the gate FAILS, or null when
	// it passes or does not apply. Never throws — a diff error degrades to "gate
	// passes" (the gate is a guard, not a new failure mode).
	private async deliverableGateFails(card: DbCard, workDir: string): Promise<string | null> {
		if (card.targets.length === 0) {
			return null
		}
		if (!this._repoWorkspace?.computeChangedFiles || workDir === this.projectRoot) {
			return null
		}
		// Only gate once the card has reached the code-producing stage. Earlier
		// stages (Backlog, Impl-Planning) legitimately produce a plan/doc rather
		// than the declared code targets, so gating them would kick every card
		// backward in a loop. The gate applies from the Implementation column
		// onward (by board position).
		if (!this.isAtOrAfterImplementation(card)) {
			return null
		}
		try {
			const changed = await this._repoWorkspace.computeChangedFiles(
				workDir,
				"origin/main",
				`card/${card.id}`,
			)
			if (targetsSatisfied(changed, card.targets)) {
				return null
			}
			const changedList = changed.length > 0 ? changed.join(", ") : "nothing"
			return `deliverable gate: declared targets ${card.targets.join(", ")} were not changed (diff touched only: ${changedList})`
		} catch {
			return null
		}
	}

	// True when the card's current column is the Implementation stage or later in
	// board order (Code-Review, QA, Deploy, Done). The deliverable gate only makes
	// sense once code should exist; before Implementation a pass is plan/doc work.
	// If no column is named "implementation", the gate is conservative and does not
	// fire (returns false) rather than risk kicking cards back.
	private isAtOrAfterImplementation(card: DbCard): boolean {
		const columns = this.pipelineColumns()
		const implementation = columns.find((c) => c.name.toLowerCase().includes("implementation"))
		if (!implementation) {
			return false
		}
		const current = columns.find((c) => c.id === card.columnId)
		if (!current) {
			return false
		}
		return current.position >= implementation.position
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

	// A pipeline-vs-GitHub divergence (or a fail-closed fetch error) detected at
	// sync-down. The card must NOT run against ambiguous code: route it to the
	// Needs-Director column with a classified sync-diverged reason, record it on
	// the thread, notify + SMS. repo.ts stays pure git; all routing lives here
	// (design §A.5, §3).
	private async routeSyncDiverged(
		card: DbCard,
		ahead: number,
		behind: number,
		action: "diverged" | "error",
	): Promise<void> {
		const detail = action === "error"
			? "sync-diverged: upstream fetch failed (fail-closed)"
			: `sync-diverged: pipeline ahead ${ahead}, behind ${behind}`
		const directorColumn = this.dbStore
			.getColumnsByProject(this.projectId)
			.find((c) => c.name.toLowerCase().includes("director"))
		if (!directorColumn) {
			// No director column — do not run the card on diverged code; unclaim
			// so the single worker isn't wedged, and surface it loudly.
			this.dbStore.unclaimCard(card.id)
			emitEvent(this.onEvent, {
				type: "blocked",
				cardId: card.id,
				reason: `${detail} but NO needs-director column exists`,
			})
			return
		}
		const pos = this.dbStore
			.getCardsByProject(this.projectId)
			.filter((c) => c.columnId === directorColumn.id).length
		this.dbStore.moveCard(card.id, directorColumn.id, pos, false)
		this.dbStore.unclaimCard(card.id)
		this.dbStore.addCardThreadEntry({
			cardId: card.id,
			entryType: "sync-diverged",
			content: detail,
		})
		await this.tryNotify({
			type: "needs-director",
			projectId: this.projectId,
			projectTitle: "",
			cardId: card.id,
			cardTitle: card.title,
			column: directorColumn.name,
			feedback: detail,
		})
		emitEvent(this.onEvent, {
			type: "needsHuman",
			cardId: card.id,
			reason: `[sync-diverged] ${detail}`,
		})
		await this.trySms(smsForNeedsHuman(card.title, `[sync-diverged] ${detail}`))
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

		// The card ENTERS nextColumn. On FIRST entry give it a fresh retry budget
		// (delete any stale key). On RE-ENTRY after a kickback (key already exists
		// with a non-zero count), preserve the accumulated failures so the park
		// threshold can fire. Without this guard a card bouncing between two
		// adjacent stages resets to 0 on every re-entry and loops forever.
		const resetStageRetries = { ...card.stageRetries }
		if (!(nextColumn.id in resetStageRetries)) {
			// First visit — no key to delete, nothing to do (fresh budget by default).
		} else if (resetStageRetries[nextColumn.id] === 0) {
			// Key exists but count is zero (prior clean visit) — safe to reset.
			delete resetStageRetries[nextColumn.id]
		}
		// else: non-zero count from a prior kickback — leave it so retries accumulate.
		this.dbStore.updateCard(card.id, { stageRetries: resetStageRetries })
		this.dbStore.moveCard(card.id, nextColumn.id, nextPos, false)
		this.dbStore.unclaimCard(card.id)

		// When a card reaches the terminal Done column, merge its branch into the
		// default branch so later cards (which branch off default) build on the
		// finished work. Without this, an isolated card branch never lands and
		// dependency-chained cards block forever. Best-effort: a merge failure
		// (e.g. a conflict) is surfaced but must not strand the already-moved card.
		if (isTerminalColumn(nextColumn) && this._repoWorkspace?.mergeCardToMain) {
			const project = this.dbStore.getProjectById(this.projectId)
			if (project?.githubRepo) {
				const repoPath = `${this.projectRoot}/${this.projectId}`
				try {
					await this._repoWorkspace.mergeCardToMain(repoPath, card.id, `card/${card.id}`)
					// Mirror the just-merged default branch UP to GitHub. The local
					// merge already landed (local is the source of truth); a
					// non-fast-forward rejection is NON-BLOCKING — the card stays done,
					// we only flag the mirror lag and text Ross (design §B).
					if (project.githubUpstream && this._repoWorkspace.pushUpToUpstream) {
						const pushed = await this._repoWorkspace.pushUpToUpstream(repoPath, project.githubUpstream, "main")
						if (pushed.rejected) {
							this.dbStore.addCardThreadEntry({
								cardId: card.id,
								entryType: "sync-push-rejected",
								content: "sync-push-rejected: GitHub moved ahead; pipeline mirror needs a manual pull-up",
							})
							emitEvent(this.onEvent, { type: "blocked", cardId: card.id, reason: "sync-push-rejected (non-blocking): GitHub upstream needs a manual pull-up" })
							await this.trySms(smsForNeedsHuman(card.title, "[sync-push-rejected] GitHub upstream needs a manual pull-up (card is done)"))
						}
					}
				} catch (err) {
					emitEvent(this.onEvent, { type: "blocked", cardId: card.id, reason: `merge to main failed: ${String(err)}` })
				}
			}
		}

		// If this card entering Done means EVERY card is now done, fire the
		// milestone-complete SMS (and build-copy). Best-effort, never throws.
		if (isTerminalColumn(nextColumn)) {
			await this.maybeMilestoneComplete()
		}

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

		// This fail consumes a retry AT THE CARD'S CURRENT STAGE. Retries are
		// per-stage: the card burns budget only for the column it just failed in, and
		// parks only when THAT column reaches maxRetries in a row — a transient failure
		// at a different stage never counts against this one. `retryCount` is kept
		// incrementing purely for back-compat/telemetry; the PARK decision below drives
		// off the per-stage count.
		const currentStageCount = (card.stageRetries[card.columnId] ?? 0) + 1
		const newStageRetries = { ...card.stageRetries, [card.columnId]: currentStageCount }
		const newRetry = card.retryCount + 1
		if (currentStageCount >= this.maxRetries) {
			this.dbStore.updateCard(card.id, { retryCount: newRetry, stageRetries: newStageRetries })
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
					reason: `Stage retry exhausted (${currentStageCount} >= ${this.maxRetries}) but NO needs-human column exists`,
				})
				return
			}
			const pos = this.dbStore
				.getCardsByProject(this.projectId)
				.filter((c) => c.columnId === needsHumanColumn.id).length

			this.dbStore.moveCard(card.id, needsHumanColumn.id, pos, false)
			this.dbStore.unclaimCard(card.id)

			// Classify the last verdict's feedback into a fixed park reason and record
			// it on the card thread, so the director sees a structured reason (not just
			// free text) and downstream routing can key off it (design §3).
			const parkReason = classifyParkReason(verdict.feedback)
			this.dbStore.addCardThreadEntry({
				cardId: card.id,
				entryType: "park-reason",
				content: parkReason,
			})

			await this.tryNotify({
				type: "retry-exhausted",
				projectId: this.projectId,
				projectTitle: "",
				cardId: card.id,
				cardTitle: card.title,
				column: needsHumanColumn.name,
				feedback: `[${parkReason}] Stage retry count ${currentStageCount} >= max ${this.maxRetries}`,
			})

			emitEvent(this.onEvent, {
				type: "needsHuman",
				cardId: card.id,
				reason: `[${parkReason}] Stage retry count ${currentStageCount} >= max ${this.maxRetries}`,
			})

			// Text Ross: this card is genuinely stuck (exhausted retries), with the
			// classified park reason plus the last verdict's feedback as the block reason.
			await this.trySms(smsForNeedsHuman(card.title, `[${parkReason}] ${verdict.feedback}`))
			return
		}

		// Normal kickback: move back one column, incrementing the per-stage counter.
		if (currentIndex <= 0) {
			// Already at first column — the card fails in place, so the incremented
			// count for THIS stage must persist (repeated failures here accumulate
			// toward the park). Just record it and unclaim.
			this.dbStore.updateCard(card.id, { retryCount: newRetry, stageRetries: newStageRetries })
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
			this.dbStore.updateCard(card.id, { retryCount: newRetry, stageRetries: newStageRetries })
			this.dbStore.unclaimCard(card.id)
			emitEvent(this.onEvent, { type: "failed", cardId: card.id, feedback: verdict.feedback })
			return
		}
		const pos = this.dbStore
			.getCardsByProject(this.projectId)
			.filter((c) => c.columnId === prevColumn.id).length

		// The card re-ENTERS prevColumn. Per the invariant "a card that reaches a
		// stage gets a fresh maxRetries there", reset prevColumn's counter to 0 (drop
		// its key) as part of this move. This is what makes transient Impl->Planning->
		// Impl bounces non-cumulative: the destination stage always starts fresh, while
		// the count we just incremented for the FAILED stage is preserved.
		const resetStageRetries = { ...newStageRetries }
		delete resetStageRetries[prevColumn.id]
		// moveCard with incrementRetry=false — retryCount is set explicitly here so it
		// is not double-incremented (the SQL increment path would bump it a second
		// time on top of newRetry).
		this.dbStore.updateCard(card.id, { retryCount: newRetry, stageRetries: resetStageRetries })
		this.dbStore.moveCard(card.id, prevColumn.id, pos, false)
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
