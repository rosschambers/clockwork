import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { DbStore } from "./db.ts"
import { startServer, type ServerHandle } from "./api.ts"
import { randomUUID } from "node:crypto"
import fs from "node:fs"

function createTempDb(): { store: DbStore; path: string } {
	const path = `/tmp/clockwork-ws-test-${randomUUID()}.sqlite`
	const store = new DbStore(path)
	store.initialize()
	return { store, path }
}

describe("WebSocket events", () => {
	let handle: ServerHandle
	let db: DbStore
	let dbPath: string
	let wsUrl: string
	let baseUrl: string

	beforeEach(() => {
		const result = createTempDb()
		db = result.store
		dbPath = result.path

		handle = startServer({
			dbStore: db,
			port: 0,
		})

		wsUrl = `ws://127.0.0.1:${handle.port}/ws`
		baseUrl = `http://127.0.0.1:${handle.port}`
	})

	afterEach(() => {
		handle.server.stop()
		db.close()
		fs.rmSync(dbPath)
	})

	it("connects and receives events for mutations", async () => {
		const ws = new WebSocket(wsUrl)
		const events: any[] = []

		await new Promise<void>((resolve) => {
			ws.onopen = () => resolve()
		})

		ws.onmessage = (event) => {
			events.push(JSON.parse(event.data))
		}

		const project = db.createProject({
			name: "Test",
			description: "",
			githubRepo: "x",
			branch: "main",
		})
		const col = db.createColumn({
			projectId: project.id,
			name: "Backlog",
			prompt: "p",
			skills: [],
			model: "m",
			position: 0,
		})

		// Mutate via API — should trigger event
		const res = await fetch(`${baseUrl}/api/projects/${project.id}/cards`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ column_id: col.id, title: "New Card" }),
		})

		expect(res.status).toBe(201)
		const card = (await res.json()) as any

		// Give the websocket a moment to receive
		await new Promise((r) => setTimeout(r, 50))

		const createdEvent = events.find((e) => e.type === "card.created")
		expect(createdEvent).toBeDefined()
		expect(createdEvent.cardId).toBe(card.id)
		expect(createdEvent.projectId).toBe(project.id)
		expect(createdEvent.columnId).toBe(col.id)
		expect(createdEvent.timestamp).toBeDefined()
	})

	it("broadcasts card.moved event via API mutation", async () => {
		const ws = new WebSocket(wsUrl)
		const events: any[] = []

		await new Promise<void>((resolve) => {
			ws.onopen = () => resolve()
		})

		ws.onmessage = (event) => {
			events.push(JSON.parse(event.data))
		}

		const project = db.createProject({
			name: "Test",
			description: "",
			githubRepo: "x",
			branch: "main",
		})
		const col1 = db.createColumn({
			projectId: project.id,
			name: "Backlog",
			prompt: "p",
			skills: [],
			model: "m",
			position: 0,
		})
		const col2 = db.createColumn({
			projectId: project.id,
			name: "Doing",
			prompt: "p",
			skills: [],
			model: "m",
			position: 1,
		})
		const card = db.createCard({
			projectId: project.id,
			columnId: col1.id,
			title: "Card",
			body: "",
			position: 0,
		})

		// Move via API
		await fetch(`${baseUrl}/api/cards/${card.id}/move`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ to_column_id: col2.id, actor: "worker-1", reason: "Ready" }),
		})

		await new Promise((r) => setTimeout(r, 50))

		const moveEvent = events.find((e) => e.type === "card.moved")
		expect(moveEvent).toBeDefined()
		expect(moveEvent.cardId).toBe(card.id)
		expect(moveEvent.projectId).toBe(project.id)
		expect(moveEvent.fromColumn).toBe(col1.id)
		expect(moveEvent.toColumn).toBe(col2.id)
		expect(moveEvent.actor).toBe("worker-1")
		expect(moveEvent.reason).toBe("Ready")
	})

	it("subscribes to project X and only sees project X events", async () => {
		const ws = new WebSocket(wsUrl)

		await new Promise<void>((resolve) => {
			ws.onopen = () => resolve()
		})

		// Create projects first via DB
		const projectA = db.createProject({
			name: "Project A",
			description: "",
			githubRepo: "a",
			branch: "main",
		})
		const projectB = db.createProject({
			name: "Project B",
			description: "",
			githubRepo: "b",
			branch: "main",
		})

		// Subscribe to project A only
		ws.send(JSON.stringify({ type: "subscribe", projectId: projectA.id }))

		const received: any[] = []
		ws.onmessage = (event) => {
			received.push(typeof event.data === "string"
				? JSON.parse(event.data)
				: JSON.parse(new TextDecoder().decode(event.data)))
		}

		const colA = db.createColumn({
			projectId: projectA.id,
			name: "Col",
			prompt: "p",
			skills: [],
			model: "m",
			position: 0,
		})
		const colB = db.createColumn({
			projectId: projectB.id,
			name: "Col",
			prompt: "p",
			skills: [],
			model: "m",
			position: 0,
		})

		// Create card in project A — should receive
		await fetch(`${baseUrl}/api/projects/${projectA.id}/cards`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ column_id: colA.id, title: "Card A" }),
		})

		// Create card in project B — should NOT receive
		await fetch(`${baseUrl}/api/projects/${projectB.id}/cards`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ column_id: colB.id, title: "Card B" }),
		})

		await new Promise((r) => setTimeout(r, 50))

		expect(received.length).toBe(1)
		expect(received[0].type).toBe("card.created")
		expect(received[0].projectId).toBe(projectA.id)
	})

	it("multiple clients all receive the same event", async () => {
		const ws1 = new WebSocket(wsUrl)
		const ws2 = new WebSocket(wsUrl)
		const ws3 = new WebSocket(wsUrl)

		const events1: any[] = []
		const events2: any[] = []
		const events3: any[] = []

		ws1.onmessage = (e) => events1.push(JSON.parse(e.data))
		ws2.onmessage = (e) => events2.push(JSON.parse(e.data))
		ws3.onmessage = (e) => events3.push(JSON.parse(e.data))

		await new Promise<void>((resolve) => {
			let ready = 0
			const markReady = () => {
				ready++
				if (ready === 3) resolve()
			}
			ws1.onopen = markReady
			ws2.onopen = markReady
			ws3.onopen = markReady
		})

		const project = db.createProject({
			name: "Test",
			description: "",
			githubRepo: "x",
			branch: "main",
		})
		const col = db.createColumn({
			projectId: project.id,
			name: "Col",
			prompt: "p",
			skills: [],
			model: "m",
			position: 0,
		})

		await fetch(`${baseUrl}/api/projects/${project.id}/cards`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ column_id: col.id, title: "Card" }),
		})

		await new Promise((r) => setTimeout(r, 50))

		expect(events1.filter((e) => e.type === "card.created").length).toBe(1)
		expect(events2.filter((e) => e.type === "card.created").length).toBe(1)
		expect(events3.filter((e) => e.type === "card.created").length).toBe(1)

		ws1.close()
		ws2.close()
		ws3.close()
	})

	it("disconnects are cleaned up and no longer receive events", async () => {
		const ws = new WebSocket(wsUrl)

		await new Promise<void>((resolve) => {
			ws.onopen = () => resolve()
		})

		const events: any[] = []
		ws.onmessage = (event) => {
			events.push(JSON.parse(event.data))
		}

		const project = db.createProject({
			name: "Test",
			description: "",
			githubRepo: "x",
			branch: "main",
		})
		const col = db.createColumn({
			projectId: project.id,
			name: "Col",
			prompt: "p",
			skills: [],
			model: "m",
			position: 0,
		})

		// First event while connected
		await fetch(`${baseUrl}/api/projects/${project.id}/cards`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ column_id: col.id, title: "Card 1" }),
		})

		await new Promise((r) => setTimeout(r, 50))
		expect(events.length).toBe(1)

		// Disconnect
		ws.close()
		await new Promise((r) => setTimeout(r, 50))

		// Second event after disconnect — should NOT receive
		await fetch(`${baseUrl}/api/projects/${project.id}/cards`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ column_id: col.id, title: "Card 2" }),
		})

		await new Promise((r) => setTimeout(r, 50))
		expect(events.length).toBe(1)
	})

	it("emits project.created event", async () => {
		const ws = new WebSocket(wsUrl)
		const events: any[] = []

		await new Promise<void>((resolve) => {
			ws.onopen = () => resolve()
		})

		ws.onmessage = (event) => {
			events.push(JSON.parse(event.data))
		}

		const res = await fetch(`${baseUrl}/api/projects`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "New Project" }),
		})

		expect(res.status).toBe(201)
		const project = (await res.json()) as any

		await new Promise((r) => setTimeout(r, 50))

		const evt = events.find((e) => e.type === "project.created")
		expect(evt).toBeDefined()
		expect(evt.projectId).toBe(project.id)
	})

	it("emits column.created event", async () => {
		const ws = new WebSocket(wsUrl)
		const events: any[] = []

		await new Promise<void>((resolve) => {
			ws.onopen = () => resolve()
		})

		ws.onmessage = (event) => {
			events.push(JSON.parse(event.data))
		}

		const project = db.createProject({
			name: "Test",
			description: "",
			githubRepo: "x",
			branch: "main",
		})

		const res = await fetch(`${baseUrl}/api/projects/${project.id}/columns`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "New Column",
				prompt: "p",
				skills: [],
				model: "m",
				position: 0,
			}),
		})

		expect(res.status).toBe(201)
		const column = (await res.json()) as any

		await new Promise((r) => setTimeout(r, 50))

		const evt = events.find((e) => e.type === "column.created")
		expect(evt).toBeDefined()
		expect(evt.columnId).toBe(column.id)
		expect(evt.projectId).toBe(project.id)
	})

	it("emits card.claimed and card.unclaimed events", async () => {
		const ws = new WebSocket(wsUrl)
		const events: any[] = []

		await new Promise<void>((resolve) => {
			ws.onopen = () => resolve()
		})

		ws.onmessage = (event) => {
			events.push(JSON.parse(event.data))
		}

		const project = db.createProject({
			name: "Test",
			description: "",
			githubRepo: "x",
			branch: "main",
		})
		const col = db.createColumn({
			projectId: project.id,
			name: "Backlog",
			prompt: "p",
			skills: [],
			model: "m",
			position: 0,
		})
		const card = db.createCard({
			projectId: project.id,
			columnId: col.id,
			title: "Card",
			body: "",
			position: 0,
		})

		// Claim via API
		const claimRes = await fetch(`${baseUrl}/api/projects/${project.id}/claim`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ worker_id: "worker-1" }),
		})

		expect(claimRes.status).toBe(200)

		// Unclaim via API
		const unclaimRes = await fetch(`${baseUrl}/api/cards/${card.id}/unclaim`, {
			method: "POST",
		})

		expect(unclaimRes.status).toBe(200)

		await new Promise((r) => setTimeout(r, 50))

		const claimedEvt = events.find((e) => e.type === "card.claimed")
		const unclaimedEvt = events.find((e) => e.type === "card.unclaimed")

		expect(claimedEvt).toBeDefined()
		expect(claimedEvt.cardId).toBe(card.id)
		expect(claimedEvt.workerId).toBe("worker-1")

		expect(unclaimedEvt).toBeDefined()
		expect(unclaimedEvt.cardId).toBe(card.id)
	})

	it("emits card.updated event", async () => {
		const ws = new WebSocket(wsUrl)
		const events: any[] = []

		await new Promise<void>((resolve) => {
			ws.onopen = () => resolve()
		})

		ws.onmessage = (event) => {
			events.push(JSON.parse(event.data))
		}

		const project = db.createProject({
			name: "Test",
			description: "",
			githubRepo: "x",
			branch: "main",
		})
		const col = db.createColumn({
			projectId: project.id,
			name: "Col",
			prompt: "p",
			skills: [],
			model: "m",
			position: 0,
		})
		const card = db.createCard({
			projectId: project.id,
			columnId: col.id,
			title: "Original",
			body: "",
			position: 0,
		})

		await fetch(`${baseUrl}/api/cards/${card.id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Updated" }),
		})

		await new Promise((r) => setTimeout(r, 50))

		const evt = events.find((e) => e.type === "card.updated")
		expect(evt).toBeDefined()
		expect(evt.cardId).toBe(card.id)
	})

	it("emits card.deleted event", async () => {
		const ws = new WebSocket(wsUrl)
		const events: any[] = []

		await new Promise<void>((resolve) => {
			ws.onopen = () => resolve()
		})

		ws.onmessage = (event) => {
			events.push(JSON.parse(event.data))
		}

		const project = db.createProject({
			name: "Test",
			description: "",
			githubRepo: "x",
			branch: "main",
		})
		const col = db.createColumn({
			projectId: project.id,
			name: "Col",
			prompt: "p",
			skills: [],
			model: "m",
			position: 0,
		})
		const card = db.createCard({
			projectId: project.id,
			columnId: col.id,
			title: "Card",
			body: "",
			position: 0,
		})

		await fetch(`${baseUrl}/api/cards/${card.id}`, { method: "DELETE" })

		await new Promise((r) => setTimeout(r, 50))

		const evt = events.find((e) => e.type === "card.deleted")
		expect(evt).toBeDefined()
		expect(evt.cardId).toBe(card.id)
	})

	it("emits project.updated and project.deleted events", async () => {
		const ws = new WebSocket(wsUrl)
		const events: any[] = []

		await new Promise<void>((resolve) => {
			ws.onopen = () => resolve()
		})

		ws.onmessage = (event) => {
			events.push(JSON.parse(event.data))
		}

		const project = db.createProject({
			name: "Original",
			description: "",
			githubRepo: "x",
			branch: "main",
		})

		await fetch(`${baseUrl}/api/projects/${project.id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Updated" }),
		})

		await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE" })

		await new Promise((r) => setTimeout(r, 50))

		const updatedEvt = events.find((e) => e.type === "project.updated")
		const deletedEvt = events.find((e) => e.type === "project.deleted")

		expect(updatedEvt).toBeDefined()
		expect(updatedEvt.projectId).toBe(project.id)

		expect(deletedEvt).toBeDefined()
		expect(deletedEvt.projectId).toBe(project.id)
	})

	it("emits column.updated and column.deleted events", async () => {
		const ws = new WebSocket(wsUrl)
		const events: any[] = []

		await new Promise<void>((resolve) => {
			ws.onopen = () => resolve()
		})

		ws.onmessage = (event) => {
			events.push(JSON.parse(event.data))
		}

		const project = db.createProject({
			name: "Test",
			description: "",
			githubRepo: "x",
			branch: "main",
		})
		const col = db.createColumn({
			projectId: project.id,
			name: "Original",
			prompt: "p",
			skills: [],
			model: "m",
			position: 0,
		})

		await fetch(`${baseUrl}/api/columns/${col.id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Updated" }),
		})

		await fetch(`${baseUrl}/api/columns/${col.id}`, { method: "DELETE" })

		await new Promise((r) => setTimeout(r, 50))

		const updatedEvt = events.find((e) => e.type === "column.updated")
		const deletedEvt = events.find((e) => e.type === "column.deleted")

		expect(updatedEvt).toBeDefined()
		expect(updatedEvt.columnId).toBe(col.id)

		expect(deletedEvt).toBeDefined()
		expect(deletedEvt.columnId).toBe(col.id)
	})

	it("emits attempt.recorded event", async () => {
		const ws = new WebSocket(wsUrl)
		const events: any[] = []

		await new Promise<void>((resolve) => {
			ws.onopen = () => resolve()
		})

		ws.onmessage = (event) => {
			events.push(JSON.parse(event.data))
		}

		const project = db.createProject({
			name: "Test",
			description: "",
			githubRepo: "x",
			branch: "main",
		})
		const col = db.createColumn({
			projectId: project.id,
			name: "Col",
			prompt: "p",
			skills: [],
			model: "m",
			position: 0,
		})
		const card = db.createCard({
			projectId: project.id,
			columnId: col.id,
			title: "Card",
			body: "",
			position: 0,
		})

		await fetch(`${baseUrl}/api/cards/${card.id}/attempts`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				transcript_path: "/tmp/attempt-1.md",
				verdict: { passed: true },
			}),
		})

		await new Promise((r) => setTimeout(r, 50))

		const evt = events.find((e) => e.type === "attempt.recorded")
		expect(evt).toBeDefined()
		expect(evt.cardId).toBe(card.id)
		expect(evt.projectId).toBe(project.id)
		expect(evt.transcriptPath).toBe("/tmp/attempt-1.md")
	})

	it("handles unknown ws message type gracefully", async () => {
		const ws = new WebSocket(wsUrl)

		await new Promise<void>((resolve) => {
			ws.onopen = () => resolve()
		})

		// Send garbage — should not crash server
		ws.send(JSON.stringify({ type: "unknown", foo: "bar" }))
		ws.send("not even json")

		await new Promise((r) => setTimeout(r, 50))

		// Connection should still be open
		expect(ws.readyState).toBe(WebSocket.OPEN)

		ws.close()
	})
})
