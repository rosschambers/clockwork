import { DbStore } from "./db.ts"
import { startServer } from "./api.ts"
import { Worker, DEFAULT_PI_INACTIVITY_MS, DEFAULT_PI_MAX_RUNTIME_MS } from "./worker.ts"
import { RepoWorkspace } from "./repo.ts"
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import path from "node:path"
import { homedir } from "node:os"

// Env configuration
const DB_PATH = process.env.CLOCKWORK_DB_PATH ?? ":memory:"
const PROJECT_ROOT = process.env.CLOCKWORK_REPOS ?? "./repos"
const TRANSCRIPTS_DIR = process.env.CLOCKWORK_TRANSCRIPTS ?? "./transcripts"
const PORT = process.env.CLOCKWORK_PORT ? Number(process.env.CLOCKWORK_PORT) : 3000
const WORKER_PROJECT_ID = process.env.CLOCKWORK_WORKER_PROJECT_ID
const TOKEN = process.env.CLOCKWORK_TOKEN

// Ensure data directories exist (a bind/volume mount may shadow image mkdirs).
if (DB_PATH !== ":memory:") {
	mkdirSync(path.dirname(DB_PATH), { recursive: true })
}
mkdirSync(PROJECT_ROOT, { recursive: true })
mkdirSync(TRANSCRIPTS_DIR, { recursive: true })

// Ensure pi's HTTP idle timeout is disabled so long model turns (large context
// prefill) do not get killed by undici's bodyTimeout/headersTimeout. The setting
// MUST be max-int32, NOT 0 — undici treats 0 as "0 ms" (instant timeout), not
// "disabled". pi reads this from $HOME/.pi/agent/settings.json.
const piSettingsDir = path.join(homedir(), ".pi", "agent")
const piSettingsPath = path.join(piSettingsDir, "settings.json")
mkdirSync(piSettingsDir, { recursive: true })
if (!existsSync(piSettingsPath)) {
	writeFileSync(piSettingsPath, JSON.stringify({ httpIdleTimeoutMs: 2147483647 }) + "\n")
} else {
	try {
		const existing = JSON.parse(require("node:fs").readFileSync(piSettingsPath, "utf8"))
		if (existing.httpIdleTimeoutMs === undefined || existing.httpIdleTimeoutMs === 0) {
			existing.httpIdleTimeoutMs = 2147483647
			writeFileSync(piSettingsPath, JSON.stringify(existing) + "\n")
		}
	} catch {
		// Best-effort: if the file is corrupt, overwrite it.
		writeFileSync(piSettingsPath, JSON.stringify({ httpIdleTimeoutMs: 2147483647 }) + "\n")
	}
}

console.log("clockwork starting...")
console.log(`  DB: ${DB_PATH}`)
console.log(`  Repos: ${PROJECT_ROOT}`)
console.log(`  Transcripts: ${TRANSCRIPTS_DIR}`)

const dbStore = new DbStore(DB_PATH)
dbStore.initialize()
console.log("  database initialized")

const repoWorkspace = new RepoWorkspace(
	{
		projectRoot: PROJECT_ROOT,
		gitToken: process.env.CLOCKWORK_GIT_TOKEN ?? "",
		defaultBranch: "main",
	},
	dbStore,
)
console.log("  repo workspace ready")

const server = startServer({
	dbStore,
	port: PORT,
	notifyUrl: process.env.CLOCKWORK_NOTIFY_URL,
	notifyToken: process.env.CLOCKWORK_NOTIFY_TOKEN,
	gitToken: process.env.CLOCKWORK_GIT_TOKEN,
	maxRetries: process.env.CLOCKWORK_MAX_RETRIES ? Number(process.env.CLOCKWORK_MAX_RETRIES) : 3,
	// Give the /sync/reconcile director endpoint its real-merge capability.
	repoWorkspace,
})
console.log(`  server listening on :${server.port}`)
console.log(`  worker project: ${WORKER_PROJECT_ID ?? "(none)"}`)

let lastIdleLog = 0
if (WORKER_PROJECT_ID) {
	const worker = new Worker({
		dbStore,
		token: TOKEN ?? "",
		workerId: "main",
		projectId: WORKER_PROJECT_ID,
		projectRoot: PROJECT_ROOT,
		transcriptsDir: TRANSCRIPTS_DIR,
		maxRetries: Number(process.env.CLOCKWORK_MAX_RETRIES ?? 3),
		pollIntervalMs: Number(process.env.CLOCKWORK_POLL_INTERVAL_MS ?? 5000),
		notifyUrl: process.env.CLOCKWORK_NOTIFY_URL,
		notifyToken: process.env.CLOCKWORK_NOTIFY_TOKEN,
		smsUrl: process.env.CLOCKWORK_SMS_URL,
		smsToken: process.env.CLOCKWORK_SMS_TOKEN,
		milestoneLabel: process.env.CLOCKWORK_MILESTONE_LABEL,
		buildCopyCommand: process.env.CLOCKWORK_BUILD_COPY_COMMAND,
		piInactivityMs: Number(process.env.CLOCKWORK_PI_INACTIVITY_MS ?? DEFAULT_PI_INACTIVITY_MS),
		piMaxRuntimeMs: Number(process.env.CLOCKWORK_PI_MAX_RUNTIME_MS ?? DEFAULT_PI_MAX_RUNTIME_MS),
		preemptionBackoffMs: process.env.CLOCKWORK_PREEMPTION_BACKOFF_MS ? Number(process.env.CLOCKWORK_PREEMPTION_BACKOFF_MS) : undefined,
		maxPreemptionRetries: process.env.CLOCKWORK_MAX_PREEMPTION_RETRIES ? Number(process.env.CLOCKWORK_MAX_PREEMPTION_RETRIES) : undefined,
		// Observability: log every worker event so the durable service's journal
		// shows the board moving (idle is noisy — log it at most once per minute).
		onEvent: (e) => {
			if (e.type === "idle") {
				const now = Date.now()
				if (now - lastIdleLog < 60000) {
					return
				}
				lastIdleLog = now
			}
			console.log(`[worker ${new Date().toISOString()}] ${JSON.stringify(e)}`)
		},
	})
	worker.repoWorkspace = repoWorkspace
	worker.start()
	console.log("  worker started")
}

// Graceful shutdown
process.on("SIGINT", () => {
	console.log("\nshutting down...")
	server.stop()
})
