/*
 * End-to-end smoke: run ONE real card through the worker against frame's dense
 * model via the arbiter LOW port. Proves context assembly -> real pi session ->
 * verdict parse -> card move -> transcript saved, with a live local model.
 *
 * Run: bun run scripts/e2e-smoke.ts
 */
import { DbStore } from "../src/db.ts"
import { Worker } from "../src/worker.ts"
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = mkdtempSync(path.join(tmpdir(), "clockwork-e2e-"))
const transcripts = path.join(root, "transcripts")
writeFileSync(path.join(root, "PROJECT.md"), "# Smoke Project\n\nA tiny test project. Standard: keep answers short.\n")

const db = new DbStore(path.join(root, "clockwork.sqlite"))
db.initialize()

const project = db.createProject({ name: "Smoke", description: "e2e", githubRepo: null, branch: null })

// Two pipeline columns + a park column.
const work = db.createColumn({
	projectId: project.id,
	name: "Answer",
	prompt: "Answer the card's question in ONE sentence. If you can answer, verdict pass; if the question is nonsense, verdict blocked.",
	skills: [],
	model: "local-dense-27b.gguf",
	position: 0,
})
db.createColumn({ projectId: project.id, name: "Done", prompt: "Final.", skills: [], model: null, position: 1 })
db.createColumn({ projectId: project.id, name: "Needs Human", prompt: "Park.", skills: [], model: null, position: 99 })

const card = db.createCard({
	projectId: project.id,
	columnId: work.id,
	title: "Capital of France",
	body: "What is the capital of France?",
	position: 0,
})

const worker = new Worker({
	dbStore: db,
	projectId: project.id,
	token: "",
	workerId: "smoke",
	projectRoot: root,
	transcriptsDir: transcripts,
	// piProvider defaults to frame-dense-low (the arbiter LOW port).
	onEvent: (e) => console.log("  event:", JSON.stringify(e)),
})

console.log("Claiming + processing one card against the REAL frame model (LOW port)...")
const claimed = await worker["claimCard"]()
if (!claimed) {
	console.error("FAIL: no card claimed")
	process.exit(1)
}
await worker.processCard(claimed)

const after = db.getCardById(card.id)!
const attempts = db.getAttemptsByCard(card.id)
const col = db.getColumnById(after.columnId)!

console.log("\n=== RESULT ===")
console.log("card moved to column:", col.name)
console.log("attempts recorded:", attempts.length)
if (attempts[0]) {
	console.log("verdict:", JSON.stringify(attempts[0].verdict))
	console.log("transcript:", attempts[0].transcriptPath)
	const dir = path.join(transcripts, project.id, card.id)
	const files = readdirSync(dir)
	const body = readFileSync(path.join(dir, files[0]!), "utf8")
	console.log("--- transcript head ---")
	console.log(body.slice(0, 600))
}

const ok = col.name === "Done" && attempts.length === 1
console.log("\n" + (ok ? "SMOKE PASS: card flowed Answer -> Done with a real verdict + transcript" : "SMOKE INCOMPLETE: check output above"))
db.close()
process.exit(ok ? 0 : 2)
