import { DbStore } from "./db.ts"
import { startServer } from "./api.ts"
import { Worker } from "./worker.ts"
import { RepoWorkspace } from "./repo.ts"
import { mkdirSync } from "node:fs"
import path from "node:path"

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
void repoWorkspace
console.log("  repo workspace ready")

const server = startServer({
	dbStore,
	port: PORT,
	notifyUrl: process.env.CLOCKWORK_NOTIFY_URL,
	notifyToken: process.env.CLOCKWORK_NOTIFY_TOKEN,
	gitToken: process.env.CLOCKWORK_GIT_TOKEN,
	maxRetries: process.env.CLOCKWORK_MAX_RETRIES ? Number(process.env.CLOCKWORK_MAX_RETRIES) : 3,
})
console.log(`  server listening on :${server.port}`)
console.log(`  worker project: ${WORKER_PROJECT_ID ?? "(none)"}`)

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
	})
	worker.start()
	console.log("  worker started")
}

// Graceful shutdown
process.on("SIGINT", () => {
	console.log("\nshutting down...")
	server.stop()
})
