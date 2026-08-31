import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from "bun:test"
import { Worker, type WorkerConfig, type WorkerEvent, type PiResult, isInfrastructureFailure } from "./worker.ts"
import { DbStore, type DbColumn } from "./db.ts"
import { parseVerdict, extractAssistantText } from "./verdict.ts"
import { randomUUID } from "node:crypto"
import fs from "node:fs"

// pi runs in --mode json: stdout is a stream of per-line event objects ending in an
// `agent_end` whose last assistant message carries the verdict trailer as a text part.
// Wrap a verdict object as the minimal such stream so worker tests feed realistic input.
function piJsonStream(verdict: { verdict: string; feedback?: string; artifacts?: string[] }): string {
	const trailer = JSON.stringify({
		verdict: verdict.verdict,
		feedback: verdict.feedback ?? "",
		artifacts: verdict.artifacts ?? [],
	})
	return (
		'{"type":"turn_start"}\n' +
		'{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":' +
		JSON.stringify(trailer) +
		"}]}]}"
	)
}

function createTempDb(): { store: DbStore; path: string } {
	const path = `/tmp/clockwork-worker-test-${randomUUID()}.sqlite`
	const store = new DbStore(path)
	store.initialize()
	return { store, path }
}

function seedTestData(
	store: DbStore,
	opts?: { extraColumns?: DbColumn[] }
): { projectId: string; columnId: string; cardId: string } {
	const project = store.createProject({
		name: "Test Project",
		description: "A test",
		githubRepo: null,
		branch: null,
	})

	const column = store.createColumn({
		projectId: project.id,
		name: "Implementation",
		prompt: "Implement the task.",
		skills: [],
		model: null,
		position: 0,
	})

	if (opts?.extraColumns) {
		for (const col of opts.extraColumns) {
			store.createColumn({
				projectId: project.id,
				name: col.name,
				prompt: col.prompt ?? "",
				skills: col.skills ?? [],
				model: col.model ?? null,
				position: col.position,
			})
		}
	}

	const card = store.createCard({
		projectId: project.id,
		columnId: column.id,
		title: "Test Card",
		body: "Do the thing.",
		position: 0,
	})

	return { projectId: project.id, columnId: column.id, cardId: card.id }
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function startWorker(worker: Worker): Promise<void> {
	return new Promise((resolve) => {
		worker.start()
		setTimeout(resolve, 300)
	})
}

describe("Worker — pass moves forward", () => {
	let store: DbStore
	let path: string
	let projectId: string
	let columnId: string
	let cardId: string

	beforeEach(() => {
		const result = createTempDb()
		store = result.store
		path = result.path
		const seeded = seedTestData(store)
		projectId = seeded.projectId
		columnId = seeded.columnId
		cardId = seeded.cardId
	})

	afterEach(() => {
		store.close()
		fs.unlinkSync(path)
	})

	it("fake pi pass -> moves card forward", async () => {
		store.createColumn({
			projectId,
			name: "Done",
			prompt: "Final stage.",
			skills: [],
			model: null,
			position: 1,
		})

		const events: WorkerEvent[] = []
		const worker = new Worker({
			dbStore: store,
			projectId,
			token: "test",
			workerId: "test-worker",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
			onEvent: (e) => events.push(e),
		})

		const fakeResult: PiResult = {
			stdout: piJsonStream({ verdict: "pass", feedback: "All tests green." }),
			stderr: "",
			exitCode: 0,
		}

		worker.invokePi = mock(
			(_invocation) =>
				Promise.resolve(fakeResult)
		)

		await startWorker(worker)

		const card = store.getCardById(cardId)
		expect(card).not.toBeNull()
		expect(card!.columnId).not.toBe(columnId)
		expect(events.some((e) => e.type === "passed")).toBe(true)

		worker.stop()
		await worker.stopped()
	})

	it("parses the verdict from a pi --mode json event stream and moves forward", async () => {
		store.createColumn({
			projectId,
			name: "Done",
			prompt: "Final stage.",
			skills: [],
			model: null,
			position: 1,
		})

		const events: WorkerEvent[] = []
		const worker = new Worker({
			dbStore: store,
			projectId,
			token: "test",
			workerId: "test-worker",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
			onEvent: (e) => events.push(e),
		})

		// stdout is a JSON event stream (what --mode json produces), NOT the raw
		// verdict trailer. The worker must reconstruct the assistant text via
		// extractAssistantText before parseVerdict, else it sees event JSON and blocks.
		const trailer = '{"verdict":"pass","feedback":"green","artifacts":[]}'
		const jsonStream: PiResult = {
			stdout:
				'{"type":"turn_start"}\n' +
				'{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"done"},{"type":"text","text":' +
				JSON.stringify(trailer) +
				"}]}]}",
			stderr: "",
			exitCode: 0,
		}

		worker.invokePi = mock((_invocation) => Promise.resolve(jsonStream))

		await startWorker(worker)

		const card = store.getCardById(cardId)
		expect(card!.columnId).not.toBe(columnId)
		expect(events.some((e) => e.type === "passed")).toBe(true)

		worker.stop()
		await worker.stopped()
	})
})

describe("Worker — fail kicks back", () => {
	let store: DbStore
	let path: string
	let projectId: string
	let columnId: string
	let cardId: string

	beforeEach(() => {
		const result = createTempDb()
		store = result.store
		path = result.path
		const seeded = seedTestData(store)
		projectId = seeded.projectId
		columnId = seeded.columnId
		cardId = seeded.cardId
	})

	afterEach(() => {
		store.close()
		fs.unlinkSync(path)
	})

	it("fake pi fail -> kicks back to previous column", async () => {
		const events: WorkerEvent[] = []
		const worker = new Worker({
			dbStore: store,
			projectId,
			token: "test",
			workerId: "test-worker",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
			onEvent: (e) => events.push(e),
		})

		const fakeResult: PiResult = {
			stdout: piJsonStream({ verdict: "fail", feedback: "Tests failed." }),
			stderr: "",
			exitCode: 1,
		}

		worker.invokePi = mock(
			(_invocation) =>
				Promise.resolve(fakeResult)
		)

		const card = await worker["claimCard"]()
		expect(card).not.toBeNull()
		await worker.processCard(card!)

		const after = store.getCardById(cardId)
		expect(after).not.toBeNull()
		expect(after!.retryCount).toBe(1)
		expect(events.some((e) => e.type === "failed")).toBe(true)

		worker.stop()
		await worker.stopped()
	})
})

describe("Worker — retry counter increments", () => {
	let store: DbStore
	let path: string
	let projectId: string
	let columnId: string
	let cardId: string

	beforeEach(() => {
		const result = createTempDb()
		store = result.store
		path = result.path
		const seeded = seedTestData(store)
		projectId = seeded.projectId
		columnId = seeded.columnId
		cardId = seeded.cardId
	})

	afterEach(() => {
		store.close()
		fs.unlinkSync(path)
	})

	it("retry counter increments on each fail", async () => {
		const events: WorkerEvent[] = []
		const worker = new Worker({
			dbStore: store,
			projectId,
			token: "test",
			workerId: "test-worker",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
			onEvent: (e) => events.push(e),
		})

		const fakeResult: PiResult = {
			stdout: piJsonStream({ verdict: "fail", feedback: "Still broken." }),
			stderr: "",
			exitCode: 1,
		}

		worker.invokePi = mock(
			(_invocation) =>
				Promise.resolve(fakeResult)
		)

		// First pass: claim -> process -> fail
		const card1 = await worker["claimCard"]()
		expect(card1).not.toBeNull()
		await worker.processCard(card1!)

		const afterFirst = store.getCardById(cardId)
		expect(afterFirst!.retryCount).toBe(1)

		// Second pass: re-claim -> process -> fail
		const card2 = await worker["claimCard"]()
		expect(card2).not.toBeNull()
		await worker.processCard(card2!)

		const afterSecond = store.getCardById(cardId)
		expect(afterSecond!.retryCount).toBe(2)

		worker.stop()
		await worker.stopped()
	})
})

describe("Worker — max retries -> needsHuman", () => {
	let store: DbStore
	let path: string
	let projectId: string
	let columnId: string
	let cardId: string

	beforeEach(() => {
		const result = createTempDb()
		store = result.store
		path = result.path
		const seeded = seedTestData(store)
		projectId = seeded.projectId
		columnId = seeded.columnId
		cardId = seeded.cardId
	})

	afterEach(() => {
		store.close()
		fs.unlinkSync(path)
	})

	it("max retries reached -> moves to needs-human", async () => {
		const events: WorkerEvent[] = []
		const worker = new Worker({
			dbStore: store,
			projectId,
			token: "test",
			workerId: "test-worker",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
			onEvent: (e) => events.push(e),
		})

		const failResult: PiResult = {
			stdout: piJsonStream({ verdict: "fail", feedback: "Still broken." }),
			stderr: "",
			exitCode: 1,
		}

		worker.invokePi = mock(
			(_invocation) =>
				Promise.resolve(failResult)
		)

		// A needs-human park column must exist for exhaustion routing.
		const needsHumanColumn = store.createColumn({
			projectId,
			name: "Needs Human",
			prompt: "Human review needed.",
			skills: [],
			model: null,
			position: 99,
		})

		// Each fail consumes one retry. With maxRetries=3 the card parks at
		// needs-human the moment its retry count REACHES 3 — on the 3rd fail,
		// in that same pass (no separate re-claim). The worker will not re-claim
		// a card once retryCount >= maxRetries.
		for (let i = 0; i < 3; i++) {
			const card = await worker["claimCard"]()
			if (card === null) {
				break
			}
			await worker.processCard(card)
		}

		const parked = store.getCardById(cardId)
		expect(parked!.retryCount).toBe(3)
		expect(parked!.columnId).toBe(needsHumanColumn.id)
		expect(events.some((e) => e.type === "needsHuman")).toBe(true)

		// Once parked/exhausted, it is no longer claimable.
		expect(await worker["claimCard"]()).toBeNull()

		worker.stop()
		await worker.stopped()
	})
})

describe("Worker — park classification", () => {
	it("records a park-reason thread entry with the classified reason", async () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)
		const projectId = seeded.projectId
		const cardId = seeded.cardId

		const needsHumanColumn = store.createColumn({
			projectId,
			name: "Needs Human",
			prompt: "Human review needed.",
			skills: [],
			model: null,
			position: 99,
		})

		const events: WorkerEvent[] = []
		const worker = new Worker({
			dbStore: store,
			projectId,
			token: "test",
			workerId: "test-worker",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 1,
			onEvent: (e) => events.push(e),
		})

		const failResult: PiResult = {
			stdout: piJsonStream({ verdict: "fail", feedback: "deliverable gate: declared targets not changed" }),
			stderr: "",
			exitCode: 1,
		}

		worker.invokePi = mock((_invocation) => Promise.resolve(failResult))

		// maxRetries: 1 -> the first fail exhausts retries and parks the card at
		// needs-human in the same pass, classifying the last verdict feedback.
		const card = await worker["claimCard"]()
		expect(card).not.toBeNull()
		await worker.processCard(card!)

		const parked = store.getCardById(cardId)
		expect(parked!.columnId).toBe(needsHumanColumn.id)

		const parkReasonEntries = store
			.getCardThreads(cardId)
			.filter((t) => t.entryType === "park-reason")
		expect(parkReasonEntries.length).toBe(1)
		expect(parkReasonEntries[0]!.content).toBe("deliverable-missing")

		const needsHumanEvent = events.find((e) => e.type === "needsHuman")
		expect(needsHumanEvent).toBeDefined()
		expect((needsHumanEvent as { reason: string }).reason).toContain("deliverable-missing")

		worker.stop()
		await worker.stopped()
		store.close()
		fs.unlinkSync(path)
	})
})

describe("Worker — per-stage retry counters (reset on stage entry)", () => {
	let store: DbStore
	let path: string
	let projectId: string
	let colA: DbColumn
	let colB: DbColumn
	let needsHuman: DbColumn
	let cardId: string

	beforeEach(() => {
		const result = createTempDb()
		store = result.store
		path = result.path
		const project = store.createProject({ name: "P", description: "", githubRepo: null, branch: null })
		projectId = project.id
		// A(0) -> B(1) -> Done(2), plus a needs-human park column off the flow.
		colA = store.createColumn({ projectId, name: "Stage A", prompt: "A.", skills: [], model: null, position: 0 })
		colB = store.createColumn({ projectId, name: "Stage B", prompt: "B.", skills: [], model: null, position: 1 })
		store.createColumn({ projectId, name: "Done", prompt: "Final.", skills: [], model: null, position: 2 })
		needsHuman = store.createColumn({ projectId, name: "Needs Human", prompt: "Human.", skills: [], model: null, position: 99 })
		const card = store.createCard({ projectId, columnId: colA.id, title: "Card", body: "Do it.", position: 0 })
		cardId = card.id
	})

	afterEach(() => {
		store.close()
		fs.unlinkSync(path)
	})

	function makeWorker(verdictFor: () => { verdict: string; feedback: string }): Worker {
		const worker = new Worker({
			dbStore: store,
			projectId,
			token: "test",
			workerId: "test-worker",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
			onEvent: () => {},
		})
		worker.invokePi = mock((_invocation) => {
			const v = verdictFor()
			return Promise.resolve({ stdout: piJsonStream(v), stderr: "", exitCode: v.verdict === "pass" ? 0 : 1 })
		})
		return worker
	}

	it("failing stage B once does NOT park even after a prior failure at stage A (each stage has its own budget)", async () => {
		// The card passes A, advances to B, fails A previously — model: it first fails
		// at A (burning A's budget by 1), gets kicked back to A, then passes A twice to
		// climb to B, then fails at B once. B must NOT park on its FIRST failure even
		// though the card already has a failure recorded at a DIFFERENT stage.
		let phase = "failA"
		const worker = makeWorker(() => {
			if (phase === "failA") {
				return { verdict: "fail", feedback: "A transient" }
			}
			if (phase === "passToB") {
				return { verdict: "pass", feedback: "A ok" }
			}
			return { verdict: "fail", feedback: "B transient" }
		})

		// 1) Fail at A once -> A's per-stage count becomes 1, card stays at A (first col).
		let card = await worker["claimCard"]()
		expect(card!.columnId).toBe(colA.id)
		await worker.processCard(card!)
		expect(store.getCardById(cardId)!.stageRetries[colA.id]).toBe(1)
		expect(store.getCardById(cardId)!.columnId).toBe(colA.id)

		// 2) Pass A -> advance into B. Entering B resets B's counter (already 0/absent).
		phase = "passToB"
		card = await worker["claimCard"]()
		await worker.processCard(card!)
		expect(store.getCardById(cardId)!.columnId).toBe(colB.id)

		// 3) Fail at B once. maxRetries is 3, and B has its OWN fresh budget, so ONE
		// B failure must NOT park the card — it kicks back to A, it does not go to
		// needs-human. (Under the old shared global counter, the card would already
		// be at retryCount 2 here and one more fail would push toward the park.)
		phase = "failB"
		card = await worker["claimCard"]()
		expect(card!.columnId).toBe(colB.id)
		await worker.processCard(card!)

		const after = store.getCardById(cardId)
		expect(after!.columnId).not.toBe(needsHuman.id)

		worker.stop()
		await worker.stopped()
	})

	it("failing the SAME stage maxRetries times in a row parks the card at needs-human", async () => {
		const worker = makeWorker(() => ({ verdict: "fail", feedback: "always broken" }))

		// Stage A is the first pipeline column, so each fail keeps the card at A while
		// incrementing A's per-stage counter. On the 3rd consecutive A failure the
		// per-stage count reaches maxRetries (3) and the card parks.
		for (let i = 0; i < 3; i++) {
			const card = await worker["claimCard"]()
			if (card === null) {
				break
			}
			await worker.processCard(card)
		}

		const parked = store.getCardById(cardId)
		expect(parked!.columnId).toBe(needsHuman.id)
		expect(await worker["claimCard"]()).toBeNull()

		worker.stop()
		await worker.stopped()
	})

	it("re-entering a stage preserves its accumulated failure count (no reset loop)", async () => {
		// Pre-seed a non-zero count for stage B (as if the card failed at B on an
		// earlier visit). When the card passes A and re-enters B, B's counter must
		// be PRESERVED — resetting it would create an infinite loop where the card
		// bounces A↔B forever without ever reaching maxRetries. A director can
		// explicitly reset via the reset-retry endpoint when a fresh start is needed.
		store.updateCard(cardId, { stageRetries: { [colB.id]: 2 } })

		const worker = makeWorker(() => ({ verdict: "pass", feedback: "A ok" }))

		const card = await worker["claimCard"]()
		expect(card!.columnId).toBe(colA.id)
		await worker.processCard(card!)

		const advanced = store.getCardById(cardId)
		expect(advanced!.columnId).toBe(colB.id)
		// Count preserved — one more failure at B will park the card (maxRetries = 3).
		expect(advanced!.stageRetries[colB.id]).toBe(2)

		worker.stop()
		await worker.stopped()
	})

	it("entering a stage for the first time starts with a clean retry budget", async () => {
		// No prior stageRetries for B — first-ever visit gets a fresh budget (0).
		store.updateCard(cardId, { stageRetries: {} })

		const worker = makeWorker(() => ({ verdict: "pass", feedback: "A ok" }))

		const card = await worker["claimCard"]()
		expect(card!.columnId).toBe(colA.id)
		await worker.processCard(card!)

		const advanced = store.getCardById(cardId)
		expect(advanced!.columnId).toBe(colB.id)
		expect(advanced!.stageRetries[colB.id] ?? 0).toBe(0)

		worker.stop()
		await worker.stopped()
	})
})

describe("Worker — never claims a card in the terminal Done column", () => {
	it("a card in Done is not claimed (no re-run loop on finished cards)", async () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)
		const done = store.createColumn({
			projectId: seeded.projectId, name: "Done", prompt: "done",
			skills: [], model: null, position: 99,
		})
		// Move the only card into Done.
		store.moveCard(seeded.cardId, done.id, 0, false)

		const worker = new Worker({
			dbStore: store, projectId: seeded.projectId, token: "", workerId: "w",
			projectRoot: "/tmp", transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50, maxRetries: 3,
		})
		expect(await worker["claimCard"]()).toBeNull()

		store.close()
		fs.unlinkSync(path)
	})
})

describe("Worker — arbiter preemption is a retryable transient, not a failure", () => {
	it("re-invokes on a 503 preemption and does NOT consume a retry", async () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)
		store.createColumn({
			projectId: seeded.projectId, name: "Done", prompt: "done",
			skills: [], model: null, position: 1,
		})

		let calls = 0
		const worker = new Worker({
			dbStore: store, projectId: seeded.projectId, token: "", workerId: "w",
			projectRoot: "/tmp", transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50, maxRetries: 3,
			preemptionBackoffMs: 1,
		})
		// First call: an arbiter preemption (exit 1, the exact 503 stderr). Second: a pass.
		worker.invokePi = mock(() => {
			calls += 1
			if (calls === 1) {
				return Promise.resolve({ stdout: "", stderr: "503 preempted by higher-priority request", exitCode: 1 })
			}
			return Promise.resolve({ stdout: piJsonStream({ verdict: "pass", feedback: "ok" }), stderr: "", exitCode: 0 })
		})

		await startWorker(worker)
		worker.stop()
		await worker.stopped()

		// It retried past the preemption (>= 2 invocations) and the card advanced.
		expect(calls).toBeGreaterThanOrEqual(2)
		const card = store.getCardById(seeded.cardId)!
		// A preemption must NOT have consumed a retry (still 0) — it moved forward on the pass.
		expect(card.retryCount).toBe(0)
		expect(card.columnId).not.toBe(seeded.columnId)

		store.close()
		fs.unlinkSync(path)
	})
})

describe("Worker — dependency ordering (depends_on)", () => {
	it("does not claim a card whose depends_on card is not yet in Done", async () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)
		const done = store.createColumn({
			projectId: seeded.projectId, name: "Done", prompt: "done",
			skills: [], model: null, position: 99,
		})
		// A dependent card that depends on the seeded card (which is NOT in Done).
		const dependent = store.createCard({
			projectId: seeded.projectId,
			columnId: seeded.columnId,
			title: "Dependent",
			body: "needs the first card",
			position: 1,
			dependsOn: seeded.cardId,
		})

		const worker = new Worker({
			dbStore: store, projectId: seeded.projectId, token: "", workerId: "w",
			projectRoot: "/tmp", transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50, maxRetries: 3,
		})

		// The seeded card (no dep) is claimable; the dependent is NOT.
		const claimed = await worker["claimCard"]()
		expect(claimed).not.toBeNull()
		expect(claimed!.id).toBe(seeded.cardId)
		// Simulate the only free card being taken; the dependent must still be unclaimable.
		store.claimCardIfFree(seeded.cardId, "someone")
		expect(await worker["claimCard"]()).toBeNull()

		// Once the dependency reaches Done, the dependent becomes claimable.
		store.moveCard(seeded.cardId, done.id, 0, false)
		store.unclaimCard(seeded.cardId)
		const now = await worker["claimCard"]()
		expect(now).not.toBeNull()
		expect(now!.id).toBe(dependent.id)

		store.close()
		fs.unlinkSync(path)
	})
})

describe("Worker — no cards -> idle", () => {
	let store: DbStore
	let path: string
	let projectId: string

	beforeEach(() => {
		const result = createTempDb()
		store = result.store
		path = result.path
		projectId = randomUUID()
		store.createProject({
			name: "Empty Project",
			description: "No cards here",
			githubRepo: null,
			branch: null,
		})
	})

	afterEach(() => {
		store.close()
		fs.unlinkSync(path)
	})

	it("no cards -> emits idle event", async () => {
		const events: WorkerEvent[] = []
		const worker = new Worker({
			dbStore: store,
			projectId,
			token: "test",
			workerId: "test-worker",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
			onEvent: (e) => events.push(e),
		})

		const fakeResult: PiResult = {
			stdout: "",
			stderr: "",
			exitCode: 0,
		}

		worker.invokePi = mock(
			(_invocation) =>
				Promise.resolve(fakeResult)
		)

		await startWorker(worker)

		expect(events.some((e) => e.type === "idle")).toBe(true)

		worker.stop()
		await worker.stopped()
	})
})

describe("Worker — stop during flight", () => {
	let store: DbStore
	let path: string
	let projectId: string
	let columnId: string
	let cardId: string

	beforeEach(() => {
		const result = createTempDb()
		store = result.store
		path = result.path
		const seeded = seedTestData(store)
		projectId = seeded.projectId
		columnId = seeded.columnId
		cardId = seeded.cardId
	})

	afterEach(() => {
		store.close()
		fs.unlinkSync(path)
	})

	it("stop while pi is running -> stops cleanly", async () => {
		const events: WorkerEvent[] = []
		const worker = new Worker({
			dbStore: store,
			projectId,
			token: "test",
			workerId: "test-worker",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
			onEvent: (e) => events.push(e),
		})

		let resolvePi = () => {}
		const piPromise = new Promise<PiResult>((resolve) => {
			resolvePi = () =>
				resolve({ stdout: "Done.", stderr: "", exitCode: 0 })
		})

		worker.invokePi = mock(() => piPromise)

		await startWorker(worker)

		// Stop while the fake pi is still pending
		worker.stop()

		// Should not hang — resolve the pi call
		resolvePi()

		// Verify the card is still claimed (we stopped mid-flight)
		const card = store.getCardById(cardId)
		expect(card!.claimState).toBe("claimed")

		await worker.stopped()
	})
})

describe("Worker — stop while idle", () => {
	let store: DbStore
	let path: string
	let projectId: string

	beforeEach(() => {
		const result = createTempDb()
		store = result.store
		path = result.path
		projectId = randomUUID()
		store.createProject({
			name: "Empty Project",
			description: "No cards",
			githubRepo: null,
			branch: null,
		})
	})

	afterEach(() => {
		store.close()
		fs.unlinkSync(path)
	})

	it("stop while idle -> stops cleanly", async () => {
		const events: WorkerEvent[] = []
		const worker = new Worker({
			dbStore: store,
			projectId,
			token: "test",
			workerId: "test-worker",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
			onEvent: (e) => events.push(e),
		})

		worker.start()

		await delay(100)

		worker.stop()
		await worker.stopped()

		// Should not throw
		expect(true).toBe(true)
	})
})

describe("Worker — malformed verdict -> blocked", () => {
	let store: DbStore
	let path: string
	let projectId: string
	let columnId: string
	let cardId: string

	beforeEach(() => {
		const result = createTempDb()
		store = result.store
		path = result.path
		const seeded = seedTestData(store)
		projectId = seeded.projectId
		columnId = seeded.columnId
		cardId = seeded.cardId
	})

	afterEach(() => {
		store.close()
		fs.unlinkSync(path)
	})

	it("malformed verdict -> records an attempt, unclaims, and counts as a retry (no stall)", async () => {
		// A blocked verdict (e.g. the model wrote code but no JSON verdict trailer)
		// must NOT strand the card: it records an attempt, unclaims the card, and
		// increments retry so repeated no-verdict runs eventually park at needs-human
		// rather than looping/vanishing silently.
		const events: WorkerEvent[] = []
		const worker = new Worker({
			dbStore: store,
			projectId,
			token: "test",
			workerId: "test-worker",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
			onEvent: (e) => events.push(e),
		})

		const fakeResult: PiResult = {
			stdout: "Just some prose, no JSON at all.",
			stderr: "",
			exitCode: 0,
		}

		worker.invokePi = mock((_invocation) => Promise.resolve(fakeResult))

		const card0 = await worker["claimCard"]()
		expect(card0).not.toBeNull()
		await worker.processCard(card0!)

		const card = store.getCardById(cardId)
		expect(card).not.toBeNull()
		// An attempt was recorded (the debugging surface must never be empty).
		expect(store.getAttemptsByCard(cardId).length).toBe(1)
		// The card is not left claimed by a finished run.
		expect(card!.claimState).toBeNull()
		// Blocked counts as a retry so it progresses toward needs-human.
		expect(card!.retryCount).toBe(1)
		expect(events.some((e) => e.type === "blocked")).toBe(true)

		worker.stop()
		await worker.stopped()
	})

	it("no verdict trailer -> the extraction fallback rescues the real verdict (C4)", async () => {
		// The model wrote work but omitted the {"verdict":...} JSON. The first pi
		// call returns prose only -> parse-failure blocked. The worker then makes a
		// SECOND (extraction) call that returns a clean verdict, and the card advances
		// as that verdict says instead of stalling.
		store.createColumn({
			projectId, name: "Done", prompt: "final", skills: [], model: null, position: 1,
		})
		const events: WorkerEvent[] = []
		const worker = new Worker({
			dbStore: store,
			projectId,
			token: "test",
			workerId: "test-worker",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
			onEvent: (e) => events.push(e),
		})

		let call = 0
		worker.invokePi = mock((_invocation) => {
			call++
			if (call === 1) {
				// First (work) call: prose, no verdict trailer.
				return Promise.resolve({ stdout: "I created scripts/beam.gd with the logic.", stderr: "", exitCode: 0 })
			}
			// Second (extraction) call: a clean verdict.
			return Promise.resolve({ stdout: piJsonStream({ verdict: "pass", feedback: "work completed" }), stderr: "", exitCode: 0 })
		})

		const card0 = await worker["claimCard"]()
		await worker.processCard(card0!)

		expect(call).toBe(2) // the fallback fired
		const card = store.getCardById(cardId)!
		expect(card.columnId).not.toBe(columnId) // advanced to Done via the rescued pass
		expect(card.claimState).toBeNull()

		worker.stop()
		await worker.stopped()
	})

	it("a transcript-write failure does NOT lose the attempt or strand the card", async () => {
		// saveTranscript must not be able to kill processCard. Point transcriptsDir
		// at an un-writable path; the attempt is still recorded (transcriptPath null)
		// and the card is resolved, not left claimed.
		const events: WorkerEvent[] = []
		const worker = new Worker({
			dbStore: store,
			projectId,
			token: "test",
			workerId: "test-worker",
			projectRoot: "/tmp",
			// A path that cannot be created (a file exists where a dir is needed).
			transcriptsDir: "/dev/null/cannot-mkdir-here",
			pollIntervalMs: 50,
			maxRetries: 3,
			onEvent: (e) => events.push(e),
		})

		worker.invokePi = mock((_invocation) =>
			Promise.resolve({
				stdout: piJsonStream({ verdict: "pass", feedback: "ok" }),
				stderr: "",
				exitCode: 0,
			}),
		)

		const card0 = await worker["claimCard"]()
		await worker.processCard(card0!)

		// Attempt recorded despite the transcript write failing.
		expect(store.getAttemptsByCard(cardId).length).toBe(1)
		// Card resolved (not left claimed by a crash).
		expect(store.getCardById(cardId)!.claimState).toBeNull()

		worker.stop()
		await worker.stopped()
	})
})

describe("Worker — poll interval", () => {
	let store: DbStore
	let path: string
	let projectId: string
	let columnId: string
	let cardId: string

	beforeEach(() => {
		const result = createTempDb()
		store = result.store
		path = result.path
		const seeded = seedTestData(store)
		projectId = seeded.projectId
		columnId = seeded.columnId
		cardId = seeded.cardId
	})

	afterEach(() => {
		store.close()
		fs.unlinkSync(path)
	})

	it("respects poll interval between claims", async () => {
		const events: WorkerEvent[] = []
		const pollIntervalMs = 200
		const worker = new Worker({
			dbStore: store,
			projectId,
			token: "test",
			workerId: "test-worker",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs,
			maxRetries: 3,
			onEvent: (e) => events.push(e),
		})

		let claimCount = 0
		const originalClaimCard = worker["claimCard"].bind(worker)

		worker["claimCard"] = mock(async () => {
			claimCount++
			if (claimCount > 1) {
				return null
			}
			return originalClaimCard()
		})

		const fakeResult: PiResult = {
			stdout: piJsonStream({ verdict: "pass", feedback: "Done." }),
			stderr: "",
			exitCode: 0,
		}

		worker.invokePi = mock(
			(_invocation) =>
				Promise.resolve(fakeResult)
		)

		const startTime = Date.now()
		worker.start()

		// Wait for at least 2 poll cycles
		await delay(pollIntervalMs * 2 + 100)

		worker.stop()
		await worker.stopped()

		const elapsed = Date.now() - startTime
		expect(elapsed).toBeGreaterThanOrEqual(pollIntervalMs)
	})
})

describe("Worker — per-card git workspace (branch + commit)", () => {
	it("prepares a card branch, runs pi inside it, and commits after a passing stage", async () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)
		// The workspace path is only taken when the project has a repo configured.
		store.updateProject(seeded.projectId, { githubRepo: "file:///tmp/fake-remote" })
		store.createColumn({
			projectId: seeded.projectId,
			name: "Done",
			prompt: "Final stage.",
			skills: [],
			model: null,
			position: 1,
		})

		const prepareCalls: Array<{ cardId: string }> = []
		const commitCalls: Array<{ repoPath: string; cardId: string }> = []
		const REPO_PATH = "/tmp/clockwork-fake-repo"

		const fakeWorkspace = {
			prepareCardWorkspace: (
				_projectId: string,
				cardId: string,
				_githubRepo: string,
			): Promise<{ repoPath: string; branch: string }> => {
				prepareCalls.push({ cardId })
				return Promise.resolve({ repoPath: REPO_PATH, branch: `card/${cardId}` })
			},
			commitCardWork: (
				repoPath: string,
				cardId: string,
				_columnId: string,
			): Promise<boolean> => {
				commitCalls.push({ repoPath, cardId })
				return Promise.resolve(true)
			},
		}

		const worker = new Worker({
			dbStore: store,
			projectId: seeded.projectId,
			token: "test",
			workerId: "test-worker",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
		})
		worker.repoWorkspace = fakeWorkspace

		const observed: { piCwd: string | null } = { piCwd: null }
		worker.invokePi = mock((invocation) => {
			observed.piCwd = invocation.cwd
			return Promise.resolve({
				stdout: piJsonStream({ verdict: "pass", feedback: "ok" }),
				stderr: "",
				exitCode: 0,
			})
		})

		await startWorker(worker)
		worker.stop()
		await worker.stopped()

		// Prepared a workspace for the card.
		expect(prepareCalls.length).toBeGreaterThanOrEqual(1)
		expect(prepareCalls[0]!.cardId).toBe(seeded.cardId)
		// Ran pi INSIDE the prepared repo path, not the shared project root.
		expect(observed.piCwd).toBe(REPO_PATH)
		// Committed the card's work after the passing stage.
		expect(commitCalls.length).toBeGreaterThanOrEqual(1)
		expect(commitCalls[0]!.repoPath).toBe(REPO_PATH)
		expect(commitCalls[0]!.cardId).toBe(seeded.cardId)

		store.close()
		fs.unlinkSync(path)
	})

	it("commits WIP even on a blocked verdict so a timed-out session's work survives to the next attempt", async () => {
		// A session killed by the max-runtime/inactivity watchdog (exit 124) yields
		// no verdict → parsed as blocked. Its partial work MUST be committed to the
		// card branch, or the next attempt's prepareCardWorkspace stashes-and-drops
		// the uncommitted files and restarts from zero — a card too big for one
		// session then never finishes (M2-12 boss: three 60-min runs, zero progress).
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)
		store.updateProject(seeded.projectId, { githubRepo: "file:///tmp/fake-remote" })

		const commitCalls: Array<{ cardId: string }> = []
		const fakeWorkspace = {
			prepareCardWorkspace: (
				_projectId: string,
				cardId: string,
			): Promise<{ repoPath: string; branch: string }> =>
				Promise.resolve({ repoPath: "/tmp/clockwork-fake-repo", branch: `card/${cardId}` }),
			commitCardWork: (_repoPath: string, cardId: string): Promise<boolean> => {
				commitCalls.push({ cardId })
				return Promise.resolve(true)
			},
		}

		const worker = new Worker({
			dbStore: store,
			projectId: seeded.projectId,
			token: "test",
			workerId: "test-worker",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
		})
		worker.repoWorkspace = fakeWorkspace
		// A timed-out session: exit 124, empty output → blocked verdict.
		worker.invokePi = mock(() =>
			Promise.resolve({
				stdout: "",
				stderr: "[clockwork: pi killed after 3600000ms max-runtime watchdog]",
				exitCode: 124,
			}),
		)

		const claimed = await worker["claimCard"]()
		await worker.processCard(claimed!)

		// The WIP was committed despite the blocked verdict.
		expect(commitCalls.length).toBeGreaterThanOrEqual(1)
		expect(commitCalls[0]!.cardId).toBe(seeded.cardId)

		store.close()
		fs.unlinkSync(path)
	})

	it("merges the card branch to main when the card reaches the terminal Done column", async () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)
		store.updateProject(seeded.projectId, { githubRepo: "file:///tmp/fake-remote" })
		// The seeded Implementation column is position 0; make Done its immediate next.
		store.createColumn({
			projectId: seeded.projectId,
			name: "Done",
			prompt: "done",
			skills: [],
			model: null,
			position: 1,
		})

		const mergeCalls: Array<{ cardId: string; branch: string }> = []
		const fakeWorkspace = {
			prepareCardWorkspace: (
				_projectId: string,
				cardId: string,
			): Promise<{ repoPath: string; branch: string }> =>
				Promise.resolve({ repoPath: "/tmp/clockwork-fake-repo", branch: `card/${cardId}` }),
			commitCardWork: (): Promise<boolean> => Promise.resolve(true),
			mergeCardToMain: (
				_repoPath: string,
				cardId: string,
				branch: string,
			): Promise<boolean> => {
				mergeCalls.push({ cardId, branch })
				return Promise.resolve(true)
			},
		}

		const worker = new Worker({
			dbStore: store,
			projectId: seeded.projectId,
			token: "test",
			workerId: "test-worker",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
		})
		worker.repoWorkspace = fakeWorkspace
		worker.invokePi = mock(() =>
			Promise.resolve({
				stdout: piJsonStream({ verdict: "pass", feedback: "ok" }),
				stderr: "",
				exitCode: 0,
			}),
		)

		await startWorker(worker)
		worker.stop()
		await worker.stopped()

		// The card passed Implementation -> Done, so its branch was merged to main.
		expect(mergeCalls.length).toBeGreaterThanOrEqual(1)
		expect(mergeCalls[0]!.cardId).toBe(seeded.cardId)
		expect(mergeCalls[0]!.branch).toBe(`card/${seeded.cardId}`)

		store.close()
		fs.unlinkSync(path)
	})

	it("up-rejection records a thread entry but does not block the done card", async () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)
		store.updateProject(seeded.projectId, {
			githubRepo: "file:///tmp/fake-pipeline",
			githubUpstream: "file:///tmp/fake-upstream",
		})
		const done = store.createColumn({
			projectId: seeded.projectId,
			name: "Done",
			prompt: "done",
			skills: [],
			model: null,
			position: 1,
		})

		const pushCalls: Array<{ pipelineRepoPath: string; branch: string }> = []
		const fakeWorkspace = {
			syncDownFromUpstream: (): Promise<{ ok: boolean; action: "ff" | "noop" | "diverged" | "error"; ahead: number; behind: number }> =>
				Promise.resolve({ ok: true, action: "noop", ahead: 0, behind: 0 }),
			prepareCardWorkspace: (
				_projectId: string,
				cardId: string,
			): Promise<{ repoPath: string; branch: string }> =>
				Promise.resolve({ repoPath: "/tmp/clockwork-fake-repo", branch: `card/${cardId}` }),
			commitCardWork: (): Promise<boolean> => Promise.resolve(true),
			mergeCardToMain: (): Promise<boolean> => Promise.resolve(true),
			pushUpToUpstream: (
				pipelineRepoPath: string,
				_upstreamUrl: string,
				branch: string,
			): Promise<{ ok: boolean; rejected: boolean }> => {
				pushCalls.push({ pipelineRepoPath, branch })
				return Promise.resolve({ ok: false, rejected: true })
			},
		}

		const worker = new Worker({
			dbStore: store,
			projectId: seeded.projectId,
			token: "test",
			workerId: "test-worker",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
		})
		worker.repoWorkspace = fakeWorkspace
		worker.invokePi = mock(() =>
			Promise.resolve({
				stdout: piJsonStream({ verdict: "pass", feedback: "ok" }),
				stderr: "",
				exitCode: 0,
			}),
		)

		await startWorker(worker)
		worker.stop()
		await worker.stopped()

		expect(pushCalls.length).toBeGreaterThanOrEqual(1)
		expect(pushCalls[0]!.pipelineRepoPath).toBe(`/tmp/${seeded.projectId}`)

		const card = store.getCardById(seeded.cardId)!
		expect(card.columnId).toBe(done.id) // still done, not blocked
		const threads = store.getCardThreads(seeded.cardId)
		expect(threads.some((t) => t.entryType === "sync-push-rejected")).toBe(true)

		store.close()
		fs.unlinkSync(path)
	})

	it("texts milestone-complete when the last card reaches Done", async () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)
		store.createColumn({
			projectId: seeded.projectId,
			name: "Done",
			prompt: "done",
			skills: [],
			model: null,
			position: 1,
		})

		const smsSent: string[] = []
		const originalFetch = globalThis.fetch
		// @ts-expect-error test mock does not implement fetch.preconnect
		globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
			const body = JSON.parse(init.body as string)
			if (typeof body.message === "string") smsSent.push(body.message)
			return { ok: true, status: 200, statusText: "OK" } as Response
		})

		const worker = new Worker({
			dbStore: store,
			projectId: seeded.projectId,
			token: "test",
			workerId: "test-worker",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
			smsUrl: "https://n8n.example/webhook/async-workload-complete",
			smsToken: "tok",
			milestoneLabel: "M1 render",
		})
		worker.invokePi = mock(() =>
			Promise.resolve({
				stdout: piJsonStream({ verdict: "pass", feedback: "ok" }),
				stderr: "",
				exitCode: 0,
			}),
		)

		await startWorker(worker)
		worker.stop()
		await worker.stopped()
		globalThis.fetch = originalFetch

		// The single card reached Done => all cards done => milestone SMS fired.
		expect(smsSent.some((m) => m.includes("M1 render") && m.toLowerCase().includes("complete"))).toBe(true)

		store.close()
		fs.unlinkSync(path)
	})
})

describe("Worker — sync-down divergence routes to Needs-Director", () => {
	it("diverged sync -> card parked in director column, pi never invoked", async () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)
		store.updateProject(seeded.projectId, {
			githubRepo: "file:///tmp/fake-pipeline",
			githubUpstream: "file:///tmp/fake-upstream",
		})
		const director = store.createColumn({
			projectId: seeded.projectId,
			name: "Needs-Director",
			prompt: "",
			skills: [],
			model: null,
			position: 900,
		})

		const syncCalls: Array<{ pipelineRepoPath: string }> = []
		const fakeWorkspace = {
			syncDownFromUpstream: (
				pipelineRepoPath: string,
				_upstreamUrl: string,
				_branch: string,
			): Promise<{ ok: boolean; action: "ff" | "noop" | "diverged" | "error"; ahead: number; behind: number }> => {
				syncCalls.push({ pipelineRepoPath })
				return Promise.resolve({ ok: false, action: "diverged", ahead: 2, behind: 3 })
			},
			prepareCardWorkspace: (
				_projectId: string,
				cardId: string,
			): Promise<{ repoPath: string; branch: string }> =>
				Promise.resolve({ repoPath: "/tmp/should-not-be-used", branch: `card/${cardId}` }),
			commitCardWork: (): Promise<boolean> => Promise.resolve(true),
		}

		const events: WorkerEvent[] = []
		const worker = new Worker({
			dbStore: store,
			projectId: seeded.projectId,
			token: "test",
			workerId: "test-worker",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
			onEvent: (e) => events.push(e),
		})
		worker.repoWorkspace = fakeWorkspace

		let piCalled = false
		worker.invokePi = mock(() => {
			piCalled = true
			return Promise.resolve({ stdout: "{}", stderr: "", exitCode: 0 })
		})

		await startWorker(worker)
		worker.stop()
		await worker.stopped()

		expect(syncCalls.length).toBeGreaterThanOrEqual(1)
		expect(syncCalls[0]!.pipelineRepoPath).toBe(`/tmp/${seeded.projectId}`)
		expect(piCalled).toBe(false)

		const card = store.getCardById(seeded.cardId)!
		expect(card.columnId).toBe(director.id)
		const threads = store.getCardThreads(seeded.cardId)
		expect(threads.some((t) => t.entryType === "sync-diverged")).toBe(true)

		store.close()
		fs.unlinkSync(path)
	})
})

describe("Worker — deliverable gate", () => {
	it("fails a pass whose declared targets were not changed (docs-only diff)", async () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)
		store.updateProject(seeded.projectId, { githubRepo: "file:///tmp/fake-remote" })
		store.createColumn({
			projectId: seeded.projectId,
			name: "Done",
			prompt: "done",
			skills: [],
			model: null,
			position: 1,
		})
		// Re-declare the seeded card's targets to a code file the diff will NOT touch.
		store.updateCard(seeded.cardId, { targets: ["scripts/main.gd"] })

		const fakeWorkspace = {
			prepareCardWorkspace: (
				_projectId: string,
				cardId: string,
			): Promise<{ repoPath: string; branch: string }> =>
				Promise.resolve({ repoPath: "/tmp/clockwork-fake-repo", branch: `card/${cardId}` }),
			commitCardWork: (): Promise<boolean> => Promise.resolve(true),
			computeChangedFiles: (): Promise<string[]> => Promise.resolve(["docs/plan.md"]),
		}

		const worker = new Worker({
			dbStore: store,
			projectId: seeded.projectId,
			token: "test",
			workerId: "w",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
		})
		worker.repoWorkspace = fakeWorkspace
		worker.invokePi = mock(() =>
			Promise.resolve({
				stdout: piJsonStream({ verdict: "pass", feedback: "done" }),
				stderr: "",
				exitCode: 0,
			}),
		)

		await startWorker(worker)
		worker.stop()
		await worker.stopped()

		const card = store.getCardById(seeded.cardId)!
		// The pass was gated into a kickback: retry incremented, still not in Done.
		expect(card.retryCount).toBeGreaterThanOrEqual(1)

		store.close()
		fs.unlinkSync(path)
	})

	it("parks a card after maxRetries kickbacks from the deliverable gate (no infinite loop)", async () => {
		const { store, path } = createTempDb()
		// Build a full pipeline: Impl-Planning → Implementation → Code-Review → Done + Needs-Human
		const project = store.createProject({ name: "P", description: "", githubRepo: "file:///tmp/fake-remote", branch: null })
		const planning = store.createColumn({ projectId: project.id, name: "Impl-Planning", prompt: "plan", skills: [], model: null, position: 0 })
		const impl = store.createColumn({ projectId: project.id, name: "Implementation", prompt: "build", skills: [], model: null, position: 1 })
		store.createColumn({ projectId: project.id, name: "Code-Review", prompt: "review", skills: [], model: null, position: 2 })
		store.createColumn({ projectId: project.id, name: "Done", prompt: "done", skills: [], model: null, position: 3 })
		store.createColumn({ projectId: project.id, name: "Needs-Human", prompt: "park", skills: [], model: null, position: 4 })
		// Card starts in Impl-Planning with targets that will never match the diff.
		const card = store.createCard({ projectId: project.id, columnId: planning.id, title: "T", body: "b", position: 0 })
		store.updateCard(card.id, { targets: ["scripts/main.gd"] })

		const fakeWorkspace = {
			prepareCardWorkspace: (_projectId: string, cardId: string): Promise<{ repoPath: string; branch: string }> =>
				Promise.resolve({ repoPath: "/tmp/clockwork-fake-repo", branch: `card/${cardId}` }),
			commitCardWork: (): Promise<boolean> => Promise.resolve(true),
			// Diff never includes the declared target — gate always fails.
			computeChangedFiles: (): Promise<string[]> => Promise.resolve(["docs/plan.md"]),
		}

		const worker = new Worker({
			dbStore: store,
			projectId: project.id,
			token: "test",
			workerId: "w",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
		})
		worker.repoWorkspace = fakeWorkspace
		worker.invokePi = mock(() =>
			Promise.resolve({
				stdout: piJsonStream({ verdict: "pass", feedback: "done" }),
				stderr: "",
				exitCode: 0,
			}),
		)

		// Run enough iterations to hit maxRetries (3). Each cycle is:
		// claim at planning → pass → moveForward to impl → pass → gate fail → kickback to planning.
		// After 3 gate fails the card must park at Needs-Human.
		for (let i = 0; i < 10; i++) {
			const claimed = await worker["claimCard"]()
			if (!claimed) break
			await worker.processCard(claimed)
		}

		const after = store.getCardById(card.id)!
		// The card must have parked at Needs-Human, NOT still be looping.
		const needsHuman = store.getColumnsByProject(project.id).find((c) => c.name === "Needs-Human")!
		expect(after.columnId).toBe(needsHuman.id)

		store.close()
		fs.unlinkSync(path)
	})

	it("does NOT gate a pass in a pre-Implementation stage (planning writes a doc, not code)", async () => {
		const { store, path } = createTempDb()
		// A project whose FIRST column is a planning stage BEFORE Implementation.
		const project = store.createProject({ name: "P", description: "", githubRepo: "file:///tmp/fake-remote", branch: null })
		const planning = store.createColumn({ projectId: project.id, name: "Impl-Planning", prompt: "plan", skills: [], model: null, position: 0 })
		const impl = store.createColumn({ projectId: project.id, name: "Implementation", prompt: "build", skills: [], model: null, position: 1 })
		store.createColumn({ projectId: project.id, name: "Done", prompt: "done", skills: [], model: null, position: 2 })
		// Card sits in the planning column and declares code targets it will only
		// deliver LATER, at Implementation. A plan-only pass here must advance, not gate.
		const card = store.createCard({ projectId: project.id, columnId: planning.id, title: "T", body: "b", position: 0 })
		store.updateCard(card.id, { targets: ["scripts/main.gd"] })

		const fakeWorkspace = {
			prepareCardWorkspace: (
				_projectId: string,
				cardId: string,
			): Promise<{ repoPath: string; branch: string }> =>
				Promise.resolve({ repoPath: "/tmp/clockwork-fake-repo", branch: `card/${cardId}` }),
			commitCardWork: (): Promise<boolean> => Promise.resolve(true),
			// Diff touches only a plan doc — code targets unchanged (as expected at planning).
			computeChangedFiles: (): Promise<string[]> => Promise.resolve(["docs/plans/plan.md"]),
		}

		const worker = new Worker({
			dbStore: store,
			projectId: project.id,
			token: "test",
			workerId: "w",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
		})
		worker.repoWorkspace = fakeWorkspace
		worker.invokePi = mock(() =>
			Promise.resolve({
				stdout: piJsonStream({ verdict: "pass", feedback: "plan written" }),
				stderr: "",
				exitCode: 0,
			}),
		)

		const claimed = await worker["claimCard"]()
		expect(claimed).not.toBeNull()
		await worker.processCard(claimed!)

		const after = store.getCardById(card.id)!
		// The planning pass must ADVANCE to Implementation, NOT be gated back.
		expect(after.columnId).toBe(impl.id)
		expect(after.retryCount).toBe(0)

		store.close()
		fs.unlinkSync(path)
	})
})

import { invokePi, type PiSpawn, type PiSubprocessLike, PI_STREAM_CAPTURE_CAP_BYTES } from "./worker.ts"

// Build a fake subprocess whose stdout/stderr emit the given chunk schedule.
// Each entry: { at: msFromStart, stream: "out" | "err", text }. `exitAfterMs`
// resolves `.exited`. `kill()` flips a flag and closes the streams early.
function makeFakeSpawn(opts: {
	chunks: Array<{ at: number; stream: "out" | "err"; text: string }>
	exitAfterMs: number
	exitCode?: number
}): { spawn: PiSpawn; killed: () => boolean } {
	let wasKilled = false
	const spawn: PiSpawn = () => {
		const encoder = new TextEncoder()
		let outController: ReadableStreamDefaultController<Uint8Array> | null = null
		let errController: ReadableStreamDefaultController<Uint8Array> | null = null
		const timers: ReturnType<typeof setTimeout>[] = []
		const stdout = new ReadableStream<Uint8Array>({ start(c) { outController = c } })
		const stderr = new ReadableStream<Uint8Array>({ start(c) { errController = c } })
		for (const chunk of opts.chunks) {
			timers.push(setTimeout(() => {
				if (wasKilled) return
				const ctrl = chunk.stream === "out" ? outController : errController
				try { ctrl?.enqueue(encoder.encode(chunk.text)) } catch {}
			}, chunk.at))
		}
		let resolveExited: (code: number) => void = () => {}
		const exited = new Promise<number>((resolve) => { resolveExited = resolve })
		timers.push(setTimeout(() => {
			try { outController?.close() } catch {}
			try { errController?.close() } catch {}
			resolveExited(opts.exitCode ?? 0)
		}, opts.exitAfterMs))
		const proc: PiSubprocessLike = {
			stdout, stderr, exited,
			exitCode: null,
			kill() {
				wasKilled = true
				for (const t of timers) clearTimeout(t)
				try { outController?.close() } catch {}
				try { errController?.close() } catch {}
				resolveExited(opts.exitCode ?? 143)
			},
		}
		return proc
	}
	return { spawn, killed: () => wasKilled }
}

describe("invokePi — spawn seam", () => {
	it("returns the fake subprocess's stdout on a clean exit", async () => {
		const { spawn } = makeFakeSpawn({
			chunks: [{ at: 5, stream: "out", text: '{"verdict":"pass","feedback":"ok","artifacts":[]}' }],
			exitAfterMs: 20,
			exitCode: 0,
		})
		const result = await invokePi({ prompt: "p", cwd: "/tmp" }, spawn)
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('"verdict":"pass"')
		expect(result.stderr).toBe("")
	})

	it("invokes pi in --mode json", async () => {
		const { spawn: inner } = makeFakeSpawn({
			chunks: [{ at: 5, stream: "out", text: '{"type":"agent_end","messages":[]}' }],
			exitAfterMs: 20,
			exitCode: 0,
		})
		let captured: string[] = []
		const spy: PiSpawn = (args, opts) => {
			captured = args
			return inner(args, opts)
		}
		await invokePi({ prompt: "p", cwd: "/tmp" }, spy)
		const i = captured.indexOf("--mode")
		expect(i).toBeGreaterThanOrEqual(0)
		expect(captured[i + 1]).toBe("json")
	})

	it("invokes pi with --thinking medium (bounds per-turn reasoning so sessions do not spiral)", async () => {
		const { spawn: inner } = makeFakeSpawn({
			chunks: [{ at: 5, stream: "out", text: '{"type":"agent_end","messages":[]}' }],
			exitAfterMs: 20,
			exitCode: 0,
		})
		let captured: string[] = []
		const spy: PiSpawn = (args, opts) => {
			captured = args
			return inner(args, opts)
		}
		await invokePi({ prompt: "p", cwd: "/tmp" }, spy)
		const i = captured.indexOf("--thinking")
		expect(i).toBeGreaterThanOrEqual(0)
		expect(captured[i + 1]).toBe("medium")
	})
})

import { DEFAULT_PI_INACTIVITY_MS, DEFAULT_PI_MAX_RUNTIME_MS } from "./worker.ts"

describe("invokePi — timing config", () => {
	it("exposes an inactivity window shorter than the runtime backstop", () => {
		expect(DEFAULT_PI_INACTIVITY_MS).toBe(10 * 60 * 1000)
		expect(DEFAULT_PI_MAX_RUNTIME_MS).toBe(60 * 60 * 1000)
		expect(DEFAULT_PI_INACTIVITY_MS).toBeLessThan(DEFAULT_PI_MAX_RUNTIME_MS)
	})
})

describe("invokePi — streaming capture", () => {
	it("returns partial stdout captured before a kill (not empty)", async () => {
		// Emit two chunks early, then go silent forever (no exit). A short
		// inactivity window forces a kill; the two chunks must still be returned.
		const { spawn, killed } = makeFakeSpawn({
			chunks: [
				{ at: 10, stream: "out", text: "turn-1 output\n" },
				{ at: 30, stream: "out", text: "turn-2 output\n" },
			],
			exitAfterMs: 10_000_000, // effectively never exits on its own
		})
		const result = await invokePi(
			{ prompt: "p", cwd: "/tmp", inactivityMs: 120, maxRuntimeMs: 5_000 },
			spawn,
		)
		expect(killed()).toBe(true)
		expect(result.exitCode).toBe(124)
		expect(result.stdout).toContain("turn-1 output")
		expect(result.stdout).toContain("turn-2 output")
		expect(result.stderr).toContain("watchdog")
	})

	it("returns full stdout+stderr on a clean exit", async () => {
		const { spawn } = makeFakeSpawn({
			chunks: [
				{ at: 5, stream: "out", text: "hello " },
				{ at: 10, stream: "err", text: "warn " },
				{ at: 15, stream: "out", text: "world" },
			],
			exitAfterMs: 30,
			exitCode: 0,
		})
		const result = await invokePi(
			{ prompt: "p", cwd: "/tmp", inactivityMs: 10_000, maxRuntimeMs: 30_000 },
			spawn,
		)
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe("hello world")
		expect(result.stderr).toBe("warn ")
	})

	it("bounds the in-memory stdout buffer so a token firehose can't OOM the worker", async () => {
		// A thinking-heavy --mode json turn emits a per-token event flood. Before
		// the fix, invokePi accumulated the ENTIRE stream in one JS string
		// (outAcc += t) — a real 16b attempt hit 2.1 GB of transcript and drove
		// clockwork to 16.7 GB RSS, starving its own watchdog callback so it fired
		// "inactivity" while tokens were still flowing (prism-drift M2-16b,
		// 2026-08-28). The captured stdout must stay BOUNDED, keeping the TAIL
		// (where the verdict JSON lives) rather than the whole firehose.
		const emittedBytes = 3 * PI_STREAM_CAPTURE_CAP_BYTES // far above the cap
		const big = "x".repeat(1_000_000) // 1 MB chunks
		const chunks = []
		for (let i = 0; i < Math.ceil(emittedBytes / 1_000_000); i++) {
			chunks.push({ at: 5 + i, stream: "out" as const, text: big })
		}
		// The verdict-bearing tail arrives last and MUST survive truncation.
		chunks.push({ at: 5 + chunks.length, stream: "out" as const, text: 'FINAL_VERDICT_MARKER {"verdict":"pass"}' })
		const { spawn } = makeFakeSpawn({ chunks, exitAfterMs: chunks.length + 60, exitCode: 0 })
		const result = await invokePi(
			{ prompt: "p", cwd: "/tmp", inactivityMs: 10_000, maxRuntimeMs: 30_000 },
			spawn,
		)
		expect(result.exitCode).toBe(0)
		// Bounded to the cap (plus at most one final chunk), nowhere near the emitted volume.
		expect(result.stdout.length).toBeLessThanOrEqual(PI_STREAM_CAPTURE_CAP_BYTES + 1_000_000)
		// The tail (verdict) is retained — truncation drops the HEAD, not the end.
		expect(result.stdout).toContain("FINAL_VERDICT_MARKER")
	})
})

describe("invokePi — inactivity watchdog", () => {
	it("(a) does NOT kill a session that keeps emitting inside the window", async () => {
		// Chunks every 40ms for ~10 windows, inactivity window 120ms => never idle
		// long enough to trip. Simulates a slow-but-progressing multi-turn session
		// that would have died under the old 15-min wall clock.
		const chunks = Array.from({ length: 10 }, (_, i) => ({
			at: 40 * (i + 1),
			stream: "out" as const,
			text: `turn ${i}\n`,
		}))
		const { spawn, killed } = makeFakeSpawn({
			chunks,
			exitAfterMs: 40 * 11, // clean exit shortly after the last chunk
			exitCode: 0,
		})
		const result = await invokePi(
			{ prompt: "p", cwd: "/tmp", inactivityMs: 120, maxRuntimeMs: 60_000 },
			spawn,
		)
		expect(killed()).toBe(false)
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain("turn 9")
	})

	it("(b) DOES kill a session that goes silent past the window", async () => {
		const { spawn, killed } = makeFakeSpawn({
			chunks: [{ at: 10, stream: "out", text: "started\n" }],
			exitAfterMs: 10_000_000, // never exits; goes silent after the one chunk
		})
		const result = await invokePi(
			{ prompt: "p", cwd: "/tmp", inactivityMs: 100, maxRuntimeMs: 60_000 },
			spawn,
		)
		expect(killed()).toBe(true)
		expect(result.exitCode).toBe(124)
		expect(result.stdout).toContain("started")
		expect(result.stderr.toLowerCase()).toContain("inactivity")
	})

	it("does not kill a --mode json session emitting per-token events past the window, and the verdict extracts", async () => {
		// Simulate the real failure mode: a long single turn that, in text mode, would
		// emit nothing for the whole window and get killed. In --mode json each token is
		// an event line, so a chunk every 40ms (< the 120ms window) keeps it alive; the
		// stream ends with an agent_end carrying the verdict trailer.
		const trailer = '{"verdict":"pass","feedback":"green","artifacts":[]}'
		const deltas = Array.from({ length: 10 }, (_, i) => ({
			at: 40 * (i + 1),
			stream: "out" as const,
			text: '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"tok' + i + '"}}\n',
		}))
		const terminal = {
			at: 40 * 11,
			stream: "out" as const,
			text: '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":' + JSON.stringify(trailer) + "}]}]}\n",
		}
		const { spawn, killed } = makeFakeSpawn({
			chunks: [...deltas, terminal],
			exitAfterMs: 40 * 12,
			exitCode: 0,
		})
		const result = await invokePi(
			{ prompt: "p", cwd: "/tmp", inactivityMs: 120, maxRuntimeMs: 60_000 },
			spawn,
		)
		expect(killed()).toBe(false)
		expect(result.exitCode).toBe(0)
		expect(parseVerdict(extractAssistantText(result.stdout)).verdict).toBe("pass")
	})
})

describe("invokePi — runtime backstop", () => {
	it("kills a trickle-forever session once maxRuntimeMs is exceeded", async () => {
		// A chunk every 30ms (never idle for the 100ms inactivity window), but the
		// runtime backstop is 150ms => it must be killed for runtime, not inactivity.
		const chunks = Array.from({ length: 20 }, (_, i) => ({
			at: 30 * (i + 1),
			stream: "out" as const,
			text: `.${i}`,
		}))
		const { spawn, killed } = makeFakeSpawn({
			chunks,
			exitAfterMs: 10_000_000, // never exits on its own
		})
		const result = await invokePi(
			{ prompt: "p", cwd: "/tmp", inactivityMs: 100, maxRuntimeMs: 150 },
			spawn,
		)
		expect(killed()).toBe(true)
		expect(result.exitCode).toBe(124)
		expect(result.stderr.toLowerCase()).toContain("max-runtime")
	})
})

describe("Worker — forwards pi timing config into the invocation", () => {
	it("passes piInactivityMs / piMaxRuntimeMs into invokePi", async () => {
		const { store, path } = createTempDb()
		const seeded = seedTestData(store)
		store.createColumn({
			projectId: seeded.projectId, name: "Done", prompt: "final",
			skills: [], model: null, position: 1,
		})
		const seen: Array<{ inactivityMs?: number; maxRuntimeMs?: number }> = []
		const worker = new Worker({
			dbStore: store,
			projectId: seeded.projectId,
			token: "test",
			workerId: "w",
			projectRoot: "/tmp",
			transcriptsDir: "/tmp/clockwork-transcripts",
			pollIntervalMs: 50,
			maxRetries: 3,
			piInactivityMs: 12345,
			piMaxRuntimeMs: 67890,
		})
		worker.invokePi = mock((invocation) => {
			seen.push({ inactivityMs: invocation.inactivityMs, maxRuntimeMs: invocation.maxRuntimeMs })
			return Promise.resolve({
				stdout: piJsonStream({ verdict: "pass", feedback: "ok" }),
				stderr: "", exitCode: 0,
			})
		})

		const card0 = await worker["claimCard"]()
		await worker.processCard(card0!)

		expect(seen.length).toBeGreaterThanOrEqual(1)
		expect(seen[0]!.inactivityMs).toBe(12345)
		expect(seen[0]!.maxRuntimeMs).toBe(67890)

		store.close()
		fs.unlinkSync(path)
	})
})

describe("isInfrastructureFailure", () => {
	it("detects auto_retry_end with success: false", () => {
		const result: PiResult = {
			stdout: '{"type":"agent_end","messages":[]}\n{"type":"auto_retry_end","success":false,"attempt":3,"finalError":"Request timed out."}',
			stderr: "",
			exitCode: 0,
		}
		expect(isInfrastructureFailure(result)).toBe(true)
	})

	it("detects final agent_end with stopReason error and timeout message", () => {
		const result: PiResult = {
			stdout: '{"type":"agent_end","messages":[{"role":"assistant","content":[],"stopReason":"error","errorMessage":"Request timed out."}],"willRetry":false}',
			stderr: "",
			exitCode: 0,
		}
		expect(isInfrastructureFailure(result)).toBe(true)
	})

	it("detects final agent_end with stopReason error and preemption message", () => {
		const result: PiResult = {
			stdout: '{"type":"agent_end","messages":[{"role":"assistant","content":[],"stopReason":"error","errorMessage":"503 preempted by higher-priority request"}],"willRetry":false}',
			stderr: "",
			exitCode: 0,
		}
		expect(isInfrastructureFailure(result)).toBe(true)
	})

	it("returns false for a normal successful pi session", () => {
		const result: PiResult = {
			stdout: piJsonStream({ verdict: "pass", feedback: "done" }),
			stderr: "",
			exitCode: 0,
		}
		expect(isInfrastructureFailure(result)).toBe(false)
	})

	it("returns false for non-zero exit code (handled by isPreemption)", () => {
		const result: PiResult = {
			stdout: "",
			stderr: "preempted by higher-priority request",
			exitCode: 1,
		}
		expect(isInfrastructureFailure(result)).toBe(false)
	})

	it("returns false for a model-declared blocked verdict", () => {
		const result: PiResult = {
			stdout: piJsonStream({ verdict: "blocked", feedback: "card is ambiguous" }),
			stderr: "",
			exitCode: 0,
		}
		expect(isInfrastructureFailure(result)).toBe(false)
	})

	// A session preempted many times then killed by clockwork's own watchdog exits
	// 124, with the preemption evidence in STDOUT (the pi event stream) and only the
	// watchdog message in stderr. isPreemption (stderr-only) misses it; before the
	// fix, isInfrastructureFailure bailed on any non-zero exit, so a preemption storm
	// wrongly consumed a card retry and parked correct work (prism-drift M2-15).
	it("detects a watchdog-timeout (124) that wraps arbiter preemptions in stdout", () => {
		const result: PiResult = {
			stdout:
				'{"type":"agent_end","messages":[{"role":"assistant","content":[],"stopReason":"error","errorMessage":"503 preempted by higher-priority request"}],"willRetry":true}',
			stderr: "\n[clockwork: pi killed after 3600000ms max-runtime watchdog]",
			exitCode: 124,
		}
		expect(isInfrastructureFailure(result)).toBe(true)
	})

	it("detects a watchdog-timeout (124) with a bare 503 preemption line in stdout", () => {
		const result: PiResult = {
			stdout: '{"type":"tool_error","text":"upstream returned 503 preempted by higher-priority request"}',
			stderr: "\n[clockwork: pi killed after 600000ms inactivity watchdog]",
			exitCode: 124,
		}
		expect(isInfrastructureFailure(result)).toBe(true)
	})

	// A genuine hang/loop with NO infra evidence is a REAL card failure and MUST still
	// consume a retry — the fix must not turn every timeout into a free pass.
	it("returns false for a watchdog-timeout (124) with no infrastructure markers", () => {
		const result: PiResult = {
			stdout: '{"type":"tool_call","name":"bash","arguments":{"command":"cd /"}}',
			stderr: "\n[clockwork: pi killed after 600000ms inactivity watchdog]",
			exitCode: 124,
		}
		expect(isInfrastructureFailure(result)).toBe(false)
	})
})
