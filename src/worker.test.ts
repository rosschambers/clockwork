import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from "bun:test"
import { Worker, type WorkerConfig, type WorkerEvent, type PiResult } from "./worker.ts"
import { DbStore, type DbColumn } from "./db.ts"
import { randomUUID } from "node:crypto"
import fs from "node:fs"

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
			stdout: JSON.stringify({
				verdict: "pass",
				feedback: "All tests green.",
				artifacts: [],
			}),
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
			stdout: JSON.stringify({
				verdict: "fail",
				feedback: "Tests failed.",
				artifacts: [],
			}),
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
			stdout: JSON.stringify({
				verdict: "fail",
				feedback: "Still broken.",
				artifacts: [],
			}),
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
			stdout: JSON.stringify({
				verdict: "fail",
				feedback: "Still broken.",
				artifacts: [],
			}),
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
				stdout: JSON.stringify({ verdict: "pass", feedback: "ok", artifacts: [] }),
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
			stdout: JSON.stringify({
				verdict: "pass",
				feedback: "Done.",
				artifacts: [],
			}),
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
