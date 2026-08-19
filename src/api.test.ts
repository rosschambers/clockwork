import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { DbStore } from "./db.ts"
import { startServer, type ServerHandle } from "./api.ts"
import { randomUUID } from "node:crypto"
import fs from "node:fs"

function createTempDb(): { store: DbStore; path: string } {
	const path = `/tmp/clockwork-api-test-${randomUUID()}.sqlite`
	const store = new DbStore(path)
	store.initialize()
	return { store, path }
}

describe("REST API", () => {
	let handle: ServerHandle
	let db: DbStore
	let dbPath: string
	let baseUrl: string

	beforeEach(() => {
		const result = createTempDb()
		db = result.store
		dbPath = result.path

		handle = startServer({
			dbStore: db,
			port: 0,
		})

		baseUrl = `http://127.0.0.1:${handle.port}`
	})

	afterEach(() => {
		handle.server.stop()
		db.close()
		fs.rmSync(dbPath)
	})

	describe("GET /api/projects", () => {
		it("returns empty list when no projects", async () => {
			const res = await fetch(`${baseUrl}/api/projects`)
			expect(res.status).toBe(200)
			const data: any = await res.json()
			expect(data).toEqual([])
		})

		it("returns all projects", async () => {
			db.createProject({ name: "Alpha", description: "A", githubRepo: "x", branch: "main" })
			db.createProject({ name: "Beta", description: "B", githubRepo: "y", branch: "main" })

			const res = await fetch(`${baseUrl}/api/projects`)
			expect(res.status).toBe(200)
			const data: any = await res.json()
			expect(data.length).toBe(2)
			expect(data.map((p: any) => p.name)).toEqual(["Alpha", "Beta"])
		})
	})

	describe("POST /api/projects", () => {
		it("creates a project", async () => {
			const body = {
				name: "New Project",
				description: "Test description",
				github_repo: "owner/repo",
				branch: "develop",
			}

			const res = await fetch(`${baseUrl}/api/projects`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			})

			expect(res.status).toBe(201)
			const data: any = await res.json()
			expect(data.name).toBe("New Project")
			expect(data.description).toBe("Test description")
			expect(data.githubRepo).toBe("owner/repo")
			expect(data.branch).toBe("develop")
			expect(data.id).toBeDefined()
		})

		it("creates a project with minimal fields", async () => {
			const body = { name: "Minimal" }

			const res = await fetch(`${baseUrl}/api/projects`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			})

			expect(res.status).toBe(201)
			const data: any = await res.json()
			expect(data.name).toBe("Minimal")
			expect(data.description).toBe("")
			expect(data.githubRepo).toBeNull()
			expect(data.branch).toBeNull()
		})

		it("returns 400 when name is missing", async () => {
			const res = await fetch(`${baseUrl}/api/projects`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ description: "no name" }),
			})

			expect(res.status).toBe(400)
		})
	})

	describe("GET /api/projects/:id", () => {
		it("returns project with columns", async () => {
			const project = db.createProject({
				name: "Test",
				description: "",
				githubRepo: "x",
				branch: "main",
			})
			db.createColumn({ projectId: project.id, name: "Col A", prompt: "prompt", skills: [], model: "m", position: 0 })
			db.createColumn({ projectId: project.id, name: "Col B", prompt: "prompt", skills: [], model: "m", position: 1 })

			const res = await fetch(`${baseUrl}/api/projects/${project.id}`)
			expect(res.status).toBe(200)
			const data: any = await res.json()
			expect(data.project.name).toBe("Test")
			expect(data.columns.length).toBe(2)
			expect(data.columns.map((c: any) => c.name)).toEqual(["Col A", "Col B"])
		})

		it("returns 404 for unknown project", async () => {
			const res = await fetch(`${baseUrl}/api/projects/nonexistent`)
			expect(res.status).toBe(404)
		})
	})

	describe("PUT /api/projects/:id", () => {
		it("updates a project", async () => {
			const project = db.createProject({
				name: "Original",
				description: "",
				githubRepo: "old/repo",
				branch: "main",
			})

			const res = await fetch(`${baseUrl}/api/projects/${project.id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Updated", branch: "develop" }),
			})

			expect(res.status).toBe(200)
			const data: any = await res.json()
			expect(data.name).toBe("Updated")
			expect(data.branch).toBe("develop")
			expect(data.githubRepo).toBe("old/repo")
		})

		it("returns 404 for unknown project", async () => {
			const res = await fetch(`${baseUrl}/api/projects/nonexistent`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "foo" }),
			})

			expect(res.status).toBe(404)
		})
	})

	describe("DELETE /api/projects/:id", () => {
		it("deletes a project and cascades", async () => {
			const project = db.createProject({
				name: "To Delete",
				description: "",
				githubRepo: "x",
				branch: "main",
			})
			const col = db.createColumn({ projectId: project.id, name: "Col", prompt: "", skills: [], model: "m", position: 0 })
			const card = db.createCard({ projectId: project.id, columnId: col.id, title: "Card", body: "", position: 0 })

			const res = await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE" })
			expect(res.status).toBe(200)

			expect(db.getProjectById(project.id)).toBeNull()
			expect(db.getColumnById(col.id)).toBeNull()
			expect(db.getCardById(card.id)).toBeNull()
		})

		it("returns 404 for unknown project", async () => {
			const res = await fetch(`${baseUrl}/api/projects/nonexistent`, { method: "DELETE" })
			expect(res.status).toBe(404)
		})
	})

	describe("Columns", () => {
		let projectId: string

		beforeEach(() => {
			const project = db.createProject({ name: "Test", description: "", githubRepo: "x", branch: "main" })
			projectId = project.id
		})

		describe("GET /api/projects/:project_id/columns", () => {
			it("returns columns in position order", async () => {
				db.createColumn({ projectId, name: "C", prompt: "", skills: [], model: "m", position: 2 })
				db.createColumn({ projectId, name: "A", prompt: "", skills: [], model: "m", position: 0 })
				db.createColumn({ projectId, name: "B", prompt: "", skills: [], model: "m", position: 1 })

				const res = await fetch(`${baseUrl}/api/projects/${projectId}/columns`)
				expect(res.status).toBe(200)
				const data: any = await res.json()
				expect(data.length).toBe(3)
				expect(data.map((c: any) => c.name)).toEqual(["A", "B", "C"])
			})

			it("returns empty when no columns", async () => {
				const res = await fetch(`${baseUrl}/api/projects/${projectId}/columns`)
				expect(res.status).toBe(200)
				const data: any = await res.json()
				expect(data).toEqual([])
			})
		})

		describe("POST /api/projects/:project_id/columns", () => {
			it("creates a column", async () => {
				const body = {
					name: "Backlog",
					prompt: "Pick a card",
					skills: ["skill-a"],
					model: "qwen3-35b",
					position: 0,
				}

				const res = await fetch(`${baseUrl}/api/projects/${projectId}/columns`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				})

				expect(res.status).toBe(201)
				const data: any = await res.json()
				expect(data.name).toBe("Backlog")
				expect(data.prompt).toBe("Pick a card")
				expect(data.skills).toEqual(["skill-a"])
				expect(data.model).toBe("qwen3-35b")
				expect(data.position).toBe(0)
				expect(data.extras).toEqual({})
			})

			it("accepts extras", async () => {
				const body = {
					name: "Col",
					prompt: "p",
					skills: [],
					model: "m",
					position: 0,
					extras: { customKey: "customValue" },
				}

				const res = await fetch(`${baseUrl}/api/projects/${projectId}/columns`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				})

				expect(res.status).toBe(201)
				const data: any = await res.json()
				expect(data.extras).toEqual({ customKey: "customValue" })
			})

			it("returns 400 when prompt is missing", async () => {
				const res = await fetch(`${baseUrl}/api/projects/${projectId}/columns`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "No Prompt" }),
				})

				expect(res.status).toBe(400)
			})

			it("returns 400 when position is missing", async () => {
				const res = await fetch(`${baseUrl}/api/projects/${projectId}/columns`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "No Pos", prompt: "p" }),
				})

				expect(res.status).toBe(400)
			})
		})

		describe("PUT /api/columns/:id", () => {
			let columnId: string

			beforeEach(() => {
				const col = db.createColumn({ projectId, name: "Original", prompt: "old", skills: [], model: "old", position: 0 })
				columnId = col.id
			})

			it("updates a column", async () => {
				const res = await fetch(`${baseUrl}/api/columns/${columnId}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Updated", prompt: "new", skills: ["new-skill"] }),
				})

				expect(res.status).toBe(200)
				const data: any = await res.json()
				expect(data.name).toBe("Updated")
				expect(data.prompt).toBe("new")
				expect(data.skills).toEqual(["new-skill"])
				expect(data.model).toBe("old")
			})

			it("returns 404 for unknown column", async () => {
				const res = await fetch(`${baseUrl}/api/columns/nonexistent`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "foo" }),
				})

				expect(res.status).toBe(404)
			})
		})

		describe("DELETE /api/columns/:id", () => {
			it("deletes a column", async () => {
				const col = db.createColumn({ projectId, name: "To Delete", prompt: "", skills: [], model: "m", position: 0 })

				const res = await fetch(`${baseUrl}/api/columns/${col.id}`, { method: "DELETE" })
				expect(res.status).toBe(200)
				expect(db.getColumnById(col.id)).toBeNull()
			})

			it("returns 404 for unknown column", async () => {
				const res = await fetch(`${baseUrl}/api/columns/nonexistent`, { method: "DELETE" })
				expect(res.status).toBe(404)
			})
		})
	})

	describe("Cards", () => {
		let projectId: string
		let columnId: string

		beforeEach(() => {
			const project = db.createProject({ name: "Test", description: "", githubRepo: "x", branch: "main" })
			projectId = project.id
			const col = db.createColumn({ projectId, name: "Backlog", prompt: "", skills: [], model: "m", position: 0 })
			columnId = col.id
		})

		describe("GET /api/projects/:project_id/cards", () => {
			it("returns all cards", async () => {
				db.createCard({ projectId, columnId, title: "Card A", body: "", position: 0 })
				db.createCard({ projectId, columnId, title: "Card B", body: "", position: 1 })

				const res = await fetch(`${baseUrl}/api/projects/${projectId}/cards`)
				expect(res.status).toBe(200)
				const data: any = await res.json()
				expect(data.length).toBe(2)
			})

			it("filters by column_id query param", async () => {
				const col2 = db.createColumn({ projectId, name: "Doing", prompt: "", skills: [], model: "m", position: 1 })
				db.createCard({ projectId, columnId, title: "Backlog Card", body: "", position: 0 })
				db.createCard({ projectId, columnId: col2.id, title: "Doing Card", body: "", position: 0 })

				const res = await fetch(`${baseUrl}/api/projects/${projectId}/cards?column_id=${columnId}`)
				expect(res.status).toBe(200)
				const data: any = await res.json()
				expect(data.length).toBe(1)
				expect(data[0].title).toBe("Backlog Card")
			})
		})

		describe("POST /api/projects/:project_id/cards", () => {
			it("creates a card", async () => {
				const body = {
					column_id: columnId,
					title: "New Card",
					body: "Card body text",
				}

				const res = await fetch(`${baseUrl}/api/projects/${projectId}/cards`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				})

				expect(res.status).toBe(201)
				const data: any = await res.json()
				expect(data.title).toBe("New Card")
				expect(data.body).toBe("Card body text")
				expect(data.columnId).toBe(columnId)
				expect(data.retryCount).toBe(0)
				expect(data.claimState).toBeNull()
			})

			it("assigns position at end of column", async () => {
				db.createCard({ projectId, columnId, title: "Existing", body: "", position: 0 })

				const res = await fetch(`${baseUrl}/api/projects/${projectId}/cards`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ column_id: columnId, title: "New" }),
				})

				expect(res.status).toBe(201)
				const data: any = await res.json()
				expect(data.position).toBe(1)
			})

			it("returns 400 when column_id is missing", async () => {
				const res = await fetch(`${baseUrl}/api/projects/${projectId}/cards`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "No Column" }),
				})

				expect(res.status).toBe(400)
			})

			it("returns 400 when title is missing", async () => {
				const res = await fetch(`${baseUrl}/api/projects/${projectId}/cards`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ column_id: columnId }),
				})

				expect(res.status).toBe(400)
			})
		})

		describe("GET /api/cards/:id", () => {
			it("returns card with threads and attempts", async () => {
				const card = db.createCard({ projectId, columnId, title: "Test Card", body: "", position: 0 })
				db.addCardThreadEntry({ cardId: card.id, entryType: "note", content: "Thread content" })
				const attempt = db.createAttempt({ cardId: card.id, transcriptPath: "/tmp/transcript.md", verdict: null, startedAt: new Date(), completedAt: null })

				const res = await fetch(`${baseUrl}/api/cards/${card.id}`)
				expect(res.status).toBe(200)
				const data: any = await res.json()
				expect(data.card.title).toBe("Test Card")
				expect(data.threads.length).toBe(1)
				expect(data.threads[0]!.content).toBe("Thread content")
				expect(data.attempts.length).toBe(1)
				expect(data.attempts[0]!.transcriptPath).toBe("/tmp/transcript.md")
			})

			it("returns 404 for unknown card", async () => {
				const res = await fetch(`${baseUrl}/api/cards/nonexistent`)
				expect(res.status).toBe(404)
			})
		})

		describe("PUT /api/cards/:id", () => {
			let cardId: string

			beforeEach(() => {
				const card = db.createCard({ projectId, columnId, title: "Original", body: "", position: 0 })
				cardId = card.id
			})

			it("updates a card", async () => {
				const res = await fetch(`${baseUrl}/api/cards/${cardId}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "Updated", body: "New body" }),
				})

				expect(res.status).toBe(200)
				const data: any = await res.json()
				expect(data.title).toBe("Updated")
				expect(data.body).toBe("New body")
			})

			it("returns 404 for unknown card", async () => {
				const res = await fetch(`${baseUrl}/api/cards/nonexistent`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: "foo" }),
				})

				expect(res.status).toBe(404)
			})
		})

		describe("DELETE /api/cards/:id", () => {
			it("deletes a card", async () => {
				const card = db.createCard({ projectId, columnId, title: "To Delete", body: "", position: 0 })

				const res = await fetch(`${baseUrl}/api/cards/${card.id}`, { method: "DELETE" })
				expect(res.status).toBe(200)
				expect(db.getCardById(card.id)).toBeNull()
			})

			it("returns 404 for unknown card", async () => {
				const res = await fetch(`${baseUrl}/api/cards/nonexistent`, { method: "DELETE" })
				expect(res.status).toBe(404)
			})
		})
	})

	describe("Card movement", () => {
		let projectId: string
		let sourceColId: string
		let destColId: string

		beforeEach(() => {
			const project = db.createProject({ name: "Test", description: "", githubRepo: "x", branch: "main" })
			projectId = project.id
			const col1 = db.createColumn({ projectId, name: "Backlog", prompt: "", skills: [], model: "m", position: 0 })
			sourceColId = col1.id
			const col2 = db.createColumn({ projectId, name: "Doing", prompt: "", skills: [], model: "m", position: 1 })
			destColId = col2.id
		})

		describe("POST /api/cards/:id/move", () => {
			it("moves card to another column", async () => {
				const card = db.createCard({ projectId, columnId: sourceColId, title: "Moving", body: "", position: 0 })

				const res = await fetch(`${baseUrl}/api/cards/${card.id}/move`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ to_column_id: destColId }),
				})

				expect(res.status).toBe(200)
				const data: any = await res.json()
				expect(data.columnId).toBe(destColId)
				expect(data.position).toBe(0)
			})

			it("records actor and reason", async () => {
				const card = db.createCard({ projectId, columnId: sourceColId, title: "Moving", body: "", position: 0 })

				const res = await fetch(`${baseUrl}/api/cards/${card.id}/move`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ to_column_id: destColId, actor: "worker-1", reason: "Pass" }),
				})

				expect(res.status).toBe(200)
				// actor + reason should be recorded in the card's thread
				const threads = db.getCardThreads(card.id)
				expect(threads.length).toBe(1)
				expect(threads[0]!.entryType).toBe("move")
			})

			it("increments retry_count and unclaims on kickback", async () => {
				const card = db.createCard({ projectId, columnId: destColId, title: "Failing", body: "", position: 0 })
				db.claimCard(card.id, "worker-1")

				const res = await fetch(`${baseUrl}/api/cards/${card.id}/move`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ to_column_id: sourceColId, kickback: true }),
				})

				expect(res.status).toBe(200)
				const data: any = await res.json()
				expect(data.retryCount).toBe(1)
				expect(data.claimState).toBeNull()
				expect(data.columnId).toBe(sourceColId)
			})

			it("returns 400 when to_column_id is missing", async () => {
				const card = db.createCard({ projectId, columnId: sourceColId, title: "Card", body: "", position: 0 })

				const res = await fetch(`${baseUrl}/api/cards/${card.id}/move`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({}),
				})

				expect(res.status).toBe(400)
			})

			it("returns 404 for unknown card", async () => {
				const res = await fetch(`${baseUrl}/api/cards/nonexistent/move`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ to_column_id: destColId }),
				})

				expect(res.status).toBe(404)
			})
		})
	})

	describe("Attempts", () => {
		let cardId: string

		beforeEach(() => {
			const project = db.createProject({ name: "Test", description: "", githubRepo: "x", branch: "main" })
			const col = db.createColumn({ projectId: project.id, name: "Backlog", prompt: "", skills: [], model: "m", position: 0 })
			const card = db.createCard({ projectId: project.id, columnId: col.id, title: "Card", body: "", position: 0 })
			cardId = card.id
		})

		describe("POST /api/cards/:id/attempts", () => {
			it("creates an attempt", async () => {
				const body = {
					transcript_path: "/tmp/attempt-1.md",
					verdict: { passed: true, feedback: "good work" },
				}

				const res = await fetch(`${baseUrl}/api/cards/${cardId}/attempts`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				})

				expect(res.status).toBe(201)
				const data: any = await res.json()
				expect(data.transcriptPath).toBe("/tmp/attempt-1.md")
				expect(data.verdict).toEqual({ passed: true, feedback: "good work" })
				expect(data.startedAt).toBeDefined()
				expect(data.completedAt).toBeNull()
			})

			it("returns 404 for unknown card", async () => {
				const res = await fetch(`${baseUrl}/api/cards/nonexistent/attempts`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ transcript_path: "/tmp/x.md" }),
				})

				expect(res.status).toBe(404)
			})
		})

		describe("GET /api/cards/:id/attempts", () => {
			it("lists attempts in reverse chronological order", async () => {
				db.createAttempt({ cardId, transcriptPath: "/tmp/1.md", verdict: null, startedAt: new Date("2026-01-01"), completedAt: null })
				db.createAttempt({ cardId, transcriptPath: "/tmp/2.md", verdict: null, startedAt: new Date("2026-01-02"), completedAt: null })

				const res = await fetch(`${baseUrl}/api/cards/${cardId}/attempts`)
				expect(res.status).toBe(200)
				const data: any = await res.json()
				expect(data.length).toBe(2)
				expect(data[0].transcriptPath).toBe("/tmp/2.md")
				expect(data[1].transcriptPath).toBe("/tmp/1.md")
			})

			it("returns empty when no attempts", async () => {
				const res = await fetch(`${baseUrl}/api/cards/${cardId}/attempts`)
				expect(res.status).toBe(200)
				const data: any = await res.json()
				expect(data).toEqual([])
			})
		})
	})

	describe("Claim / Unclaim", () => {
		let projectId: string
		let columnId: string

		beforeEach(() => {
			const project = db.createProject({ name: "Test", description: "", githubRepo: "x", branch: "main" })
			projectId = project.id
			const col = db.createColumn({ projectId, name: "Backlog", prompt: "", skills: [], model: "m", position: 0 })
			columnId = col.id
		})

		describe("POST /api/projects/:project_id/claim", () => {
			it("claims the next free card", async () => {
				const card1 = db.createCard({ projectId, columnId, title: "First", body: "", position: 0 })
				const card2 = db.createCard({ projectId, columnId, title: "Second", body: "", position: 1 })

				const res = await fetch(`${baseUrl}/api/projects/${projectId}/claim`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ worker_id: "worker-1" }),
				})

				expect(res.status).toBe(200)
				const data: any = await res.json()
				expect(data.id).toBe(card1.id)
				expect(data.claimState).toBe("claimed")
				expect(data.claimedBy).toBe("worker-1")
			})

			it("skips claimed cards", async () => {
				const card1 = db.createCard({ projectId, columnId, title: "Taken", body: "", position: 0 })
				const card2 = db.createCard({ projectId, columnId, title: "Free", body: "", position: 1 })
				db.claimCard(card1.id, "other-worker")

				const res = await fetch(`${baseUrl}/api/projects/${projectId}/claim`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ worker_id: "worker-1" }),
				})

				expect(res.status).toBe(200)
				const data: any = await res.json()
				expect(data.id).toBe(card2.id)
			})

			it("skips cards with retry_count >= 3", async () => {
				const card1 = db.createCard({ projectId, columnId, title: "Stuck", body: "", position: 0 })
				const card2 = db.createCard({ projectId, columnId, title: "Free", body: "", position: 1 })
				db.updateCard(card1.id, { retryCount: 3 })

				const res = await fetch(`${baseUrl}/api/projects/${projectId}/claim`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ worker_id: "worker-1" }),
				})

				expect(res.status).toBe(200)
				const data: any = await res.json()
				expect(data.id).toBe(card2.id)
			})

			it("skips locked cards", async () => {
				const card1 = db.createCard({ projectId, columnId, title: "Locked", body: "", position: 0 })
				const card2 = db.createCard({ projectId, columnId, title: "Free", body: "", position: 1 })
				db.updateCard(card1.id, { claimState: "locked" })

				const res = await fetch(`${baseUrl}/api/projects/${projectId}/claim`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ worker_id: "worker-1" }),
				})

				expect(res.status).toBe(200)
				const data: any = await res.json()
				expect(data.id).toBe(card2.id)
			})

			it("returns 404 when no claimable cards", async () => {
				const res = await fetch(`${baseUrl}/api/projects/${projectId}/claim`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ worker_id: "worker-1" }),
				})

				expect(res.status).toBe(404)
			})

			it("returns 400 when worker_id is missing", async () => {
				const res = await fetch(`${baseUrl}/api/projects/${projectId}/claim`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({}),
				})

				expect(res.status).toBe(400)
			})
		})

		describe("POST /api/cards/:id/unclaim", () => {
			it("releases a claimed card", async () => {
				const card = db.createCard({ projectId, columnId, title: "Card", body: "", position: 0 })
				db.claimCard(card.id, "worker-1")

				const res = await fetch(`${baseUrl}/api/cards/${card.id}/unclaim`, { method: "POST" })
				expect(res.status).toBe(200)

				const updated = db.getCardById(card.id)
				expect(updated!.claimState).toBeNull()
				expect(updated!.claimedBy).toBeNull()
			})

			it("returns 404 for unknown card", async () => {
				const res = await fetch(`${baseUrl}/api/cards/nonexistent/unclaim`, { method: "POST" })
				expect(res.status).toBe(404)
			})
		})
	})

	describe("Auth", () => {
		afterEach(() => {
			process.env.CLOCKWORK_TOKEN = undefined
		})

		it("requires auth when CLOCKWORK_TOKEN is set", async () => {
			// Need to restart server with auth enabled
			handle.server.stop()
			process.env.CLOCKWORK_TOKEN = "secret-token"

			handle = startServer({
				dbStore: db,
				port: 0,
			})

			const authBaseUrl = `http://127.0.0.1:${handle.port}`

			const res = await fetch(`${authBaseUrl}/api/projects`)
			expect(res.status).toBe(401)

			const res2 = await fetch(`${authBaseUrl}/api/projects`, {
				headers: { "Authorization": "Bearer secret-token" },
			})
			expect(res2.status).toBe(200)
		})

		it("returns 401 for wrong token", async () => {
			handle.server.stop()
			process.env.CLOCKWORK_TOKEN = "secret-token"

			handle = startServer({
				dbStore: db,
				port: 0,
			})

			const authBaseUrl = `http://127.0.0.1:${handle.port}`

			const res = await fetch(`${authBaseUrl}/api/projects`, {
				headers: { "Authorization": "Bearer wrong-token" },
			})
			expect(res.status).toBe(401)
		})

		it("no auth required when CLOCKWORK_TOKEN is not set", async () => {
			// Server started without token in beforeEach
			const res = await fetch(`${baseUrl}/api/projects`)
			expect(res.status).toBe(200)
		})
	})
})
