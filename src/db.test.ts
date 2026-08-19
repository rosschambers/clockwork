import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { DbStore } from "./db.ts"
import { randomUUID } from "node:crypto"
import fs from "node:fs"

function createTempDb(): { store: DbStore; path: string } {
	const path = `/tmp/clockwork-test-${randomUUID()}.sqlite`
	const store = new DbStore(path)
	store.initialize()
	return { store, path }
}

describe("DbStore — initialization", () => {
	it("creates database and tables on initialize", () => {
		const { store, path } = createTempDb()
		expect(fs.existsSync(path)).toBe(true)
		const tables = store.db.query("SELECT name FROM sqlite_master WHERE type='table'").all()
		expect(tables.map((t: any) => t.name)).toContain("projects")
		expect(tables.map((t: any) => t.name)).toContain("columns")
		expect(tables.map((t: any) => t.name)).toContain("cards")
		expect(tables.map((t: any) => t.name)).toContain("attempts")
		expect(tables.map((t: any) => t.name)).toContain("card_threads")
		store.close()
	})

	it("enables WAL mode", () => {
		const { store, path } = createTempDb()
		const mode = store.db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null
		expect(mode?.journal_mode).toBe("wal")
		store.close()
	})
})

describe("DbStore — projects", () => {
	let store: DbStore
	let path: string

	beforeEach(() => {
		const result = createTempDb()
		store = result.store
		path = result.path
	})

	afterEach(() => {
		store.close()
	})

	it("creates a project", () => {
		const project = store.createProject({
			name: "Test Project",
			description: "A test",
			githubRepo: "owner/repo",
			branch: "main",
		})

		expect(project.id).toBeDefined()
		expect(project.name).toBe("Test Project")
		expect(project.description).toBe("A test")
		expect(project.githubRepo).toBe("owner/repo")
		expect(project.branch).toBe("main")
	})

	it("getProjectById returns the project", () => {
		const created = store.createProject({
			name: "Test Project",
			description: "A test",
			githubRepo: "owner/repo",
			branch: "main",
		})

		const project = store.getProjectById(created.id)
		expect(project).not.toBeNull()
		expect(project!.name).toBe("Test Project")
	})

	it("getProjectById returns null for unknown id", () => {
		const project = store.getProjectById("nonexistent")
		expect(project).toBeNull()
	})

	it("getAllProjects returns all projects", () => {
		store.createProject({ name: "A", description: "", githubRepo: "a", branch: "main" })
		store.createProject({ name: "B", description: "", githubRepo: "b", branch: "main" })

		const projects = store.getAllProjects()
		expect(projects.length).toBe(2)
		expect(projects.map((p) => p.name)).toEqual(["A", "B"])
	})

	it("getAllProjects returns empty when no projects", () => {
		const projects = store.getAllProjects()
		expect(projects.length).toBe(0)
	})

	it("updates a project", () => {
		const created = store.createProject({
			name: "Test Project",
			description: "A test",
			githubRepo: "owner/repo",
			branch: "main",
		})

		const updated = store.updateProject(created.id, {
			name: "Updated Project",
			branch: "develop",
		})

		expect(updated.name).toBe("Updated Project")
		expect(updated.branch).toBe("develop")
		expect(updated.description).toBe("A test")
	})

	it("deletes a project", () => {
		const created = store.createProject({
			name: "Test Project",
			description: "",
			githubRepo: "x",
			branch: "main",
		})

		store.deleteProject(created.id)
		const project = store.getProjectById(created.id)
		expect(project).toBeNull()
	})
})

describe("DbStore — columns", () => {
	let store: DbStore
	let path: string
	let projectId: string

	beforeEach(() => {
		const result = createTempDb()
		store = result.store
		path = result.path
		const project = store.createProject({
			name: "Test Project",
			description: "",
			githubRepo: "x",
			branch: "main",
		})
		projectId = project.id
	})

	afterEach(() => {
		store.close()
	})

	it("creates a column", () => {
		const column = store.createColumn({
			projectId,
			name: "Backlog",
			prompt: "Pick a card and work on it",
			skills: ["skill-a"],
			model: "qwen3-35b",
			position: 0,
		})

		expect(column.id).toBeDefined()
		expect(column.projectId).toBe(projectId)
		expect(column.name).toBe("Backlog")
		expect(column.prompt).toBe("Pick a card and work on it")
		expect(column.skills).toEqual(["skill-a"])
		expect(column.model).toBe("qwen3-35b")
		expect(column.position).toBe(0)
	})

	it("getColumnById returns the column", () => {
		const created = store.createColumn({
			projectId,
			name: "Backlog",
			prompt: "",
			skills: [],
			model: "default",
			position: 0,
		})

		const column = store.getColumnById(created.id)
		expect(column).not.toBeNull()
		expect(column!.name).toBe("Backlog")
	})

	it("getColumnById returns null for unknown id", () => {
		const column = store.getColumnById("nonexistent")
		expect(column).toBeNull()
	})

	it("getColumnsByProject returns columns in position order", () => {
		store.createColumn({ projectId, name: "C", prompt: "", skills: [], model: "m", position: 2 })
		store.createColumn({ projectId, name: "A", prompt: "", skills: [], model: "m", position: 0 })
		store.createColumn({ projectId, name: "B", prompt: "", skills: [], model: "m", position: 1 })

		const columns = store.getColumnsByProject(projectId)
		expect(columns.length).toBe(3)
		expect(columns.map((c) => c.name)).toEqual(["A", "B", "C"])
	})

	it("updates a column", () => {
		const created = store.createColumn({
			projectId,
			name: "Backlog",
			prompt: "old prompt",
			skills: [],
			model: "old",
			position: 0,
		})

		const updated = store.updateColumn(created.id, {
			name: "Ready",
			prompt: "new prompt",
			skills: ["new-skill"],
		})

		expect(updated.name).toBe("Ready")
		expect(updated.prompt).toBe("new prompt")
		expect(updated.skills).toEqual(["new-skill"])
		expect(updated.model).toBe("old")
	})

	it("deletes a column", () => {
		const created = store.createColumn({
			projectId,
			name: "Backlog",
			prompt: "",
			skills: [],
			model: "m",
			position: 0,
		})

		store.deleteColumn(created.id)
		const column = store.getColumnById(created.id)
		expect(column).toBeNull()
	})

	it("cascades delete column to its cards", () => {
		const column = store.createColumn({
			projectId,
			name: "Backlog",
			prompt: "",
			skills: [],
			model: "m",
			position: 0,
		})
		const card = store.createCard({
			projectId,
			columnId: column.id,
			title: "Card",
			body: "",
			position: 0,
		})

		store.deleteColumn(column.id)
		const found = store.getCardById(card.id)
		expect(found).toBeNull()
	})
})

describe("DbStore — cards", () => {
	let store: DbStore
	let path: string
	let projectId: string
	let columnId: string

	beforeEach(() => {
		const result = createTempDb()
		store = result.store
		path = result.path
		const project = store.createProject({
			name: "Test Project",
			description: "",
			githubRepo: "x",
			branch: "main",
		})
		projectId = project.id
		const column = store.createColumn({
			projectId,
			name: "Backlog",
			prompt: "",
			skills: [],
			model: "m",
			position: 0,
		})
		columnId = column.id
	})

	afterEach(() => {
		store.close()
	})

	it("creates a card", () => {
		const card = store.createCard({
			projectId,
			columnId,
			title: "Build feature",
			body: "Implement the thing",
			position: 0,
		})

		expect(card.id).toBeDefined()
		expect(card.projectId).toBe(projectId)
		expect(card.columnId).toBe(columnId)
		expect(card.title).toBe("Build feature")
		expect(card.body).toBe("Implement the thing")
		expect(card.position).toBe(0)
		expect(card.retryCount).toBe(0)
		expect(card.claimState).toBeNull()
		expect(card.claimedBy).toBeNull()
	})

	it("getCardById returns the card", () => {
		const created = store.createCard({
			projectId,
			columnId,
			title: "Card",
			body: "",
			position: 0,
		})

		const card = store.getCardById(created.id)
		expect(card).not.toBeNull()
		expect(card!.title).toBe("Card")
	})

	it("getCardById returns null for unknown id", () => {
		const card = store.getCardById("nonexistent")
		expect(card).toBeNull()
	})

	it("getCardsByProject returns all cards in that project", () => {
		const col2 = store.createColumn({
			projectId,
			name: "Doing",
			prompt: "",
			skills: [],
			model: "m",
			position: 1,
		})
		store.createCard({ projectId, columnId: columnId, title: "A", body: "", position: 0 })
		store.createCard({ projectId, columnId: col2.id, title: "B", body: "", position: 0 })
		store.createCard({ projectId, columnId: columnId, title: "C", body: "", position: 1 })

		const cards = store.getCardsByProject(projectId)
		expect(cards.length).toBe(3)
	})

	it("getCardsByColumn returns cards in position order", () => {
		store.createCard({ projectId, columnId, title: "C", body: "", position: 2 })
		store.createCard({ projectId, columnId, title: "A", body: "", position: 0 })
		store.createCard({ projectId, columnId, title: "B", body: "", position: 1 })

		const cards = store.getCardsByColumn(columnId)
		expect(cards.length).toBe(3)
		expect(cards.map((c) => c.title)).toEqual(["A", "B", "C"])
	})

	it("updates a card", () => {
		const created = store.createCard({
			projectId,
			columnId,
			title: "Old title",
			body: "Old body",
			position: 0,
		})

		const updated = store.updateCard(created.id, {
			title: "New title",
			body: "New body",
		})

		expect(updated.title).toBe("New title")
		expect(updated.body).toBe("New body")
	})

	it("deletes a card", () => {
		const created = store.createCard({
			projectId,
			columnId,
			title: "Card",
			body: "",
			position: 0,
		})

		store.deleteCard(created.id)
		const card = store.getCardById(created.id)
		expect(card).toBeNull()
	})

	it("claims a card", () => {
		const card = store.createCard({
			projectId,
			columnId,
			title: "Card",
			body: "",
			position: 0,
		})

		const claimed = store.claimCard(card.id, "worker-1")
		expect(claimed.claimState).toBe("claimed")
		expect(claimed.claimedBy).toBe("worker-1")
		expect(claimed.claimedAt).not.toBeNull()
	})

	it("unclaims a card", () => {
		const card = store.createCard({
			projectId,
			columnId,
			title: "Card",
			body: "",
			position: 0,
		})
		store.claimCard(card.id, "worker-1")

		const unclaimed = store.unclaimCard(card.id)
		expect(unclaimed.claimState).toBeNull()
		expect(unclaimed.claimedBy).toBeNull()
		expect(unclaimed.claimedAt).toBeNull()
	})

	it("moves a card to another column", () => {
		const col2 = store.createColumn({
			projectId,
			name: "Doing",
			prompt: "",
			skills: [],
			model: "m",
			position: 1,
		})
		const card = store.createCard({
			projectId,
			columnId,
			title: "Card",
			body: "",
			position: 0,
		})

		const moved = store.moveCard(card.id, col2.id, 5)
		expect(moved.columnId).toBe(col2.id)
		expect(moved.position).toBe(5)
	})

	it("increments retry count when moving card", () => {
		const col2 = store.createColumn({
			projectId,
			name: "Backlog",
			prompt: "",
			skills: [],
			model: "m",
			position: 1,
		})
		const card = store.createCard({
			projectId,
			columnId,
			title: "Card",
			body: "",
			position: 0,
		})

		const moved = store.moveCard(card.id, col2.id, 0, true)
		expect(moved.retryCount).toBe(1)
	})

	it("cascades delete card to its attempts", () => {
		const card = store.createCard({
			projectId,
			columnId,
			title: "Card",
			body: "",
			position: 0,
		})
		store.createAttempt({
			cardId: card.id,
			transcriptPath: "/tmp/transcript.md",
			verdict: null,
			startedAt: new Date(),
			completedAt: null,
		})

		store.deleteCard(card.id)
		const attempts = store.getAttemptsByCard(card.id)
		expect(attempts.length).toBe(0)
	})

	it("cascades delete card to its threads", () => {
		const card = store.createCard({
			projectId,
			columnId,
			title: "Card",
			body: "",
			position: 0,
		})
		store.addCardThreadEntry({
			cardId: card.id,
			entryType: "note",
			content: "test",
		})

		store.deleteCard(card.id)
		const threads = store.getCardThreads(card.id)
		expect(threads.length).toBe(0)
	})

	it("locks a card (sets claim state to locked)", () => {
		const card = store.createCard({
			projectId,
			columnId,
			title: "Card",
			body: "",
			position: 0,
		})

		store.claimCard(card.id, "worker-1")
		const locked = store.lockCard(card.id)
		expect(locked.claimState).toBe("locked")
		expect(locked.claimedBy).toBe("worker-1")
	})
})

describe("DbStore — attempts", () => {
	let store: DbStore
	let path: string
	let cardId: string

	beforeEach(() => {
		const result = createTempDb()
		store = result.store
		path = result.path
		const project = store.createProject({
			name: "Test Project",
			description: "",
			githubRepo: "x",
			branch: "main",
		})
		const column = store.createColumn({
			projectId: project.id,
			name: "Backlog",
			prompt: "",
			skills: [],
			model: "m",
			position: 0,
		})
		const card = store.createCard({
			projectId: project.id,
			columnId: column.id,
			title: "Card",
			body: "",
			position: 0,
		})
		cardId = card.id
	})

	afterEach(() => {
		store.close()
	})

	it("creates an attempt", () => {
		const started = new Date()
		const attempt = store.createAttempt({
			cardId,
			transcriptPath: "/tmp/attempt-1.md",
			verdict: null,
			startedAt: started,
			completedAt: null,
		})

		expect(attempt.id).toBeDefined()
		expect(attempt.cardId).toBe(cardId)
		expect(attempt.transcriptPath).toBe("/tmp/attempt-1.md")
		expect(attempt.verdict).toBeNull()
		expect(attempt.startedAt.getTime()).toBe(started.getTime())
		expect(attempt.completedAt).toBeNull()
	})

	it("updates an attempt verdict and completion", () => {
		const started = new Date("2026-01-01T00:00:00Z")
		const attempt = store.createAttempt({
			cardId,
			transcriptPath: "/tmp/attempt-1.md",
			verdict: null,
			startedAt: started,
			completedAt: null,
		})

		const completed = new Date("2026-01-01T01:00:00Z")
		const verdict = { passed: true, feedback: "good" }
		const updated = store.updateAttempt(attempt.id, {
			verdict,
			completedAt: completed,
		})

		expect(updated.verdict).toEqual(verdict)
		expect(updated.completedAt?.getTime()).toBe(completed.getTime())
	})

	it("getAttemptsByCard returns attempts in reverse chronological order", () => {
		store.createAttempt({
			cardId,
			transcriptPath: "/tmp/1.md",
			verdict: null,
			startedAt: new Date("2026-01-01T00:00:00Z"),
			completedAt: null,
		})
		store.createAttempt({
			cardId,
			transcriptPath: "/tmp/2.md",
			verdict: null,
			startedAt: new Date("2026-01-02T00:00:00Z"),
			completedAt: null,
		})

		const attempts = store.getAttemptsByCard(cardId)
		expect(attempts.length).toBe(2)
		expect(attempts[0]!.transcriptPath).toBe("/tmp/2.md")
		expect(attempts[1]!.transcriptPath).toBe("/tmp/1.md")
	})

	it("getAttemptsByCard returns empty for card with no attempts", () => {
		const attempts = store.getAttemptsByCard(cardId)
		expect(attempts.length).toBe(0)
	})
})

describe("DbStore — card threads", () => {
	let store: DbStore
	let path: string
	let cardId: string

	beforeEach(() => {
		const result = createTempDb()
		store = result.store
		path = result.path
		const project = store.createProject({
			name: "Test Project",
			description: "",
			githubRepo: "x",
			branch: "main",
		})
		const column = store.createColumn({
			projectId: project.id,
			name: "Backlog",
			prompt: "",
			skills: [],
			model: "m",
			position: 0,
		})
		const card = store.createCard({
			projectId: project.id,
			columnId: column.id,
			title: "Card",
			body: "",
			position: 0,
		})
		cardId = card.id
	})

	afterEach(() => {
		store.close()
	})

	it("adds a thread entry", () => {
		const entry = store.addCardThreadEntry({
			cardId,
			entryType: "note",
			content: "Human added context here",
		})

		expect(entry.id).toBeDefined()
		expect(entry.cardId).toBe(cardId)
		expect(entry.entryType).toBe("note")
		expect(entry.content).toBe("Human added context here")
	})

	it("supports all entry types", () => {
		const feedback = store.addCardThreadEntry({
			cardId,
			entryType: "feedback",
			content: "Needs more error handling",
		})
		const verdict = store.addCardThreadEntry({
			cardId,
			entryType: "verdict",
			content: "Passed review",
		})
		const note = store.addCardThreadEntry({
			cardId,
			entryType: "note",
			content: "Reminder",
		})

		expect(feedback.entryType).toBe("feedback")
		expect(verdict.entryType).toBe("verdict")
		expect(note.entryType).toBe("note")
	})

	it("getCardThreads returns entries in chronological order", () => {
		store.addCardThreadEntry({ cardId, entryType: "note", content: "First" })
		Bun.sleepSync(10)
		store.addCardThreadEntry({ cardId, entryType: "feedback", content: "Second" })

		const entries = store.getCardThreads(cardId)
		expect(entries.length).toBe(2)
		expect(entries[0]!.content).toBe("First")
		expect(entries[1]!.content).toBe("Second")
	})

	it("getCardThreads returns empty for card with no entries", () => {
		const entries = store.getCardThreads(cardId)
		expect(entries.length).toBe(0)
	})

	it("gets a column with extras preserved", () => {
		const column = store.createColumn({
			projectId: store.createProject({
				name: "T",
				description: "",
				githubRepo: "x",
				branch: "main",
			}).id,
			name: "Col",
			prompt: "",
			skills: [],
			model: "m",
			position: 0,
			extras: { customKey: "customValue" },
		})

		const found = store.getColumnById(column.id)
		expect(found!.extras).toEqual({ customKey: "customValue" })
	})
})

describe("DbStore — cross-entity queries", () => {
	let store: DbStore
	let path: string

	beforeEach(() => {
		const result = createTempDb()
		store = result.store
		path = result.path
	})

	afterEach(() => {
		store.close()
	})

	it("finds free cards in a column", () => {
		const project = store.createProject({
			name: "T",
			description: "",
			githubRepo: "x",
			branch: "main",
		})
		const column = store.createColumn({
			projectId: project.id,
			name: "Backlog",
			prompt: "",
			skills: [],
			model: "m",
			position: 0,
		})
		store.createCard({ projectId: project.id, columnId: column.id, title: "Free1", body: "", position: 0 })
		store.createCard({ projectId: project.id, columnId: column.id, title: "Free2", body: "", position: 1 })
		const claimedCard = store.createCard({ projectId: project.id, columnId: column.id, title: "Taken", body: "", position: 2 })
		store.claimCard(claimedCard.id, "worker-1")

		const free = store.getFreeCardsByColumn(column.id)
		expect(free.length).toBe(2)
		expect(free.map((c) => c.title)).toEqual(["Free1", "Free2"])
	})

	it("finds cards needing human attention (retry count >= 3)", () => {
		const project = store.createProject({
			name: "T",
			description: "",
			githubRepo: "x",
			branch: "main",
		})
		const column = store.createColumn({
			projectId: project.id,
			name: "Needs Human",
			prompt: "",
			skills: [],
			model: "m",
			position: 0,
		})
		const card1 = store.createCard({ projectId: project.id, columnId: column.id, title: "OK", body: "", position: 0 })
		const card2 = store.createCard({ projectId: project.id, columnId: column.id, title: "Stuck", body: "", position: 1 })

		store.updateCard(card1.id, { retryCount: 2 })
		store.updateCard(card2.id, { retryCount: 3 })

		const needsHuman = store.getCardsNeedingHuman(project.id)
		expect(needsHuman.length).toBe(1)
		expect(needsHuman[0]!.title).toBe("Stuck")
		expect(needsHuman[0]!.retryCount).toBe(3)
	})

	it("gets project with columns", () => {
		const project = store.createProject({
			name: "T",
			description: "",
			githubRepo: "x",
			branch: "main",
		})
		store.createColumn({ projectId: project.id, name: "A", prompt: "", skills: [], model: "m", position: 0 })
		store.createColumn({ projectId: project.id, name: "B", prompt: "", skills: [], model: "m", position: 1 })

		const result = store.getProjectWithColumns(project.id)
		expect(result!.project.name).toBe("T")
		expect(result!.columns.length).toBe(2)
		expect(result!.columns.map((c) => c.name)).toEqual(["A", "B"])
	})
})

describe("DbStore — project cascade delete", () => {
	let store: DbStore
	let path: string

	beforeEach(() => {
		const result = createTempDb()
		store = result.store
		path = result.path
	})

	afterEach(() => {
		store.close()
	})

	it("deleting a project removes its columns and cards", () => {
		const project = store.createProject({
			name: "T",
			description: "",
			githubRepo: "x",
			branch: "main",
		})
		const column = store.createColumn({
			projectId: project.id,
			name: "Backlog",
			prompt: "",
			skills: [],
			model: "m",
			position: 0,
		})
		const card = store.createCard({
			projectId: project.id,
			columnId: column.id,
			title: "Card",
			body: "",
			position: 0,
		})

		store.deleteProject(project.id)

		expect(store.getProjectById(project.id)).toBeNull()
		expect(store.getColumnById(column.id)).toBeNull()
		expect(store.getCardById(card.id)).toBeNull()
	})
})
