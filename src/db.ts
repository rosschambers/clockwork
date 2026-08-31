import { Database } from "bun:sqlite"
import { parseTargets } from "./targets.ts"

export interface DbProject {
	id: string
	name: string
	description: string
	githubRepo: string | null
	branch: string | null
	githubUpstream: string | null
	createdAt: Date
	updatedAt: Date
}

export interface DbColumn {
	id: string
	projectId: string
	name: string
	prompt: string
	skills: string[]
	model: string | null
	position: number
	extras: Record<string, unknown> | null
	createdAt: Date
	updatedAt: Date
}

export interface DbCard {
	id: string
	projectId: string
	columnId: string
	title: string
	body: string
	position: number
	retryCount: number
	claimState: "free" | "claimed" | "locked" | null
	claimedBy: string | null
	claimedAt: Date | null
	// Optional dependency: the id of another card that must reach the terminal Done
	// column before this card may be claimed. Null = no dependency.
	dependsOn: string | null
	// File paths this card declares as its deliverable. Empty array = no declared
	// targets (a planning/doc card). Drives the deterministic deliverable gate.
	targets: string[]
	// Per-card scenario name set by a director action. Null = no scenario.
	scenario: string | null
	// Per-stage retry counters keyed by column id: { columnId: count }. Each stage
	// gets its own budget that RESETS when the card (re-)enters that stage, so a
	// card only parks when a SINGLE stage fails maxRetries in a row (design: retries
	// are per-stage, not a shared per-card global). Empty map = no failures yet.
	stageRetries: Record<string, number>
	createdAt: Date
	updatedAt: Date
}

export interface DbAttempt {
	id: string
	cardId: string
	transcriptPath: string | null
	verdict: Record<string, unknown> | null
	startedAt: Date
	completedAt: Date | null
}

export interface DbCardThreadEntry {
	id: string
	cardId: string
	entryType: string
	content: string
	createdAt: Date
}

export interface CreateProjectInput {
	name: string
	description: string
	githubRepo: string | null
	branch: string | null
	githubUpstream?: string | null
}

export interface UpdateProjectInput {
	name?: string
	description?: string
	githubRepo?: string | null
	branch?: string | null
	githubUpstream?: string | null
}

export interface CreateColumnInput {
	projectId: string
	name: string
	prompt: string
	skills: string[]
	model: string | null
	position: number
	extras?: Record<string, unknown> | null
}

export interface UpdateColumnInput {
	name?: string
	prompt?: string
	skills?: string[]
	model?: string | null
	position?: number
	extras?: Record<string, unknown> | null
}

export interface CreateCardInput {
	projectId: string
	columnId: string
	title: string
	body: string
	position: number
	dependsOn?: string | null
	targets?: string[]
}

export interface UpdateCardInput {
	title?: string
	body?: string
	position?: number
	retryCount?: number
	claimState?: "free" | "claimed" | "locked" | null
	claimedBy?: string | null
	claimedAt?: Date | null
	targets?: string[]
	dependsOn?: string | null
	scenario?: string | null
	stageRetries?: Record<string, number>
}

export interface CreateAttemptInput {
	cardId: string
	transcriptPath: string | null
	verdict: Record<string, unknown> | null
	startedAt: Date
	completedAt: Date | null
}

export interface UpdateAttemptInput {
	verdict?: Record<string, unknown> | null
	completedAt?: Date | null
}

export interface AddCardThreadEntryInput {
	cardId: string
	entryType: string
	content: string
}

export class DbStore {
	public readonly db: Database

	constructor(private readonly path: string) {
		this.db = new Database(path)
	}

	initialize(): void {
		this.run("PRAGMA journal_mode = WAL")
		this.run("PRAGMA foreign_keys = ON")
		this.run("PRAGMA busy_timeout = 5000")

		this.run(`
			CREATE TABLE IF NOT EXISTS projects (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				github_repo TEXT,
				branch TEXT,
				github_upstream TEXT,
				created_at DATETIME NOT NULL DEFAULT (datetime('now')),
				updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
			)
		`)

		this.run(`
			CREATE TABLE IF NOT EXISTS columns (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
				name TEXT NOT NULL,
				prompt TEXT NOT NULL DEFAULT '',
				skills TEXT NOT NULL DEFAULT '[]',
				model TEXT,
				position INTEGER NOT NULL DEFAULT 0,
				extras TEXT NOT NULL DEFAULT '{}',
				created_at DATETIME NOT NULL DEFAULT (datetime('now')),
				updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
			)
		`)

		this.run(`
			CREATE TABLE IF NOT EXISTS cards (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
				column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
				title TEXT NOT NULL,
				body TEXT NOT NULL DEFAULT '',
				position INTEGER NOT NULL DEFAULT 0,
				retry_count INTEGER NOT NULL DEFAULT 0,
				claim_state TEXT,
				claimed_by TEXT,
				claimed_at DATETIME,
				depends_on TEXT,
				targets TEXT,
				scenario TEXT,
				stage_retries TEXT,
				created_at DATETIME NOT NULL DEFAULT (datetime('now')),
				updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
			)
		`)

		// Additive migration for databases created before depends_on existed. SQLite
		// has no "ADD COLUMN IF NOT EXISTS", so tolerate the "duplicate column" error.
		try {
			this.run("ALTER TABLE cards ADD COLUMN depends_on TEXT")
		} catch {
			// Column already exists — nothing to do.
		}

		try {
			this.run("ALTER TABLE cards ADD COLUMN targets TEXT")
		} catch {
			// Column already exists — nothing to do.
		}

		try {
			this.run("ALTER TABLE cards ADD COLUMN scenario TEXT")
		} catch {
			// Column already exists — nothing to do.
		}

		try {
			this.run("ALTER TABLE cards ADD COLUMN stage_retries TEXT")
		} catch {
			// Column already exists — nothing to do.
		}

		try {
			this.run("ALTER TABLE projects ADD COLUMN github_upstream TEXT")
		} catch {
			// Column already exists — nothing to do.
		}

		this.run(`
			CREATE TABLE IF NOT EXISTS attempts (
				id TEXT PRIMARY KEY,
				card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
				transcript_path TEXT,
				verdict TEXT,
				started_at DATETIME NOT NULL,
				completed_at DATETIME
			)
		`)

		this.run(`
			CREATE TABLE IF NOT EXISTS card_threads (
				id TEXT PRIMARY KEY,
				card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
				entry_type TEXT NOT NULL,
				content TEXT NOT NULL,
				created_at DATETIME NOT NULL DEFAULT (datetime('now'))
			)
		`)

		this.run("CREATE INDEX IF NOT EXISTS idx_columns_project_id ON columns(project_id)")
		this.run("CREATE INDEX IF NOT EXISTS idx_cards_project_id ON cards(project_id)")
		this.run("CREATE INDEX IF NOT EXISTS idx_cards_column_id ON cards(column_id)")
		this.run("CREATE INDEX IF NOT EXISTS idx_cards_claim_state ON cards(claim_state)")
		this.run("CREATE INDEX IF NOT EXISTS idx_attempts_card_id ON attempts(card_id)")
		this.run("CREATE INDEX IF NOT EXISTS idx_card_threads_card_id ON card_threads(card_id)")
	}

	close(): void {
		this.db.close()
	}

	// Thin wrapper so callers can pass bindings variadically; forwards them to
	// Bun's array-binding form (its variadic overload is not typed in this
	// bun-types version). Zero-binding schema/DDL calls keep using this.db.run.
	private run(sql: string, ...binds: (string | number | bigint | boolean | null | Uint8Array)[]): void {
		this.db.run(sql, binds)
	}

	// --- Projects ---

	createProject(input: CreateProjectInput): DbProject {
		const id = crypto.randomUUID()
		this.run(`
			INSERT INTO projects (id, name, description, github_repo, branch, github_upstream)
			VALUES (?, ?, ?, ?, ?, ?)
		`, id, input.name, input.description, input.githubRepo ?? null, input.branch ?? null, input.githubUpstream ?? null)
		return this.getProjectById(id)!
	}

	getProjectById(id: string): DbProject | null {
		const row = this.db
			.prepare("SELECT * FROM projects WHERE id = ?")
			.get(id) as any | undefined

		if (!row) {
			return null
		}

		return {
			id: row.id,
			name: row.name,
			description: row.description,
			githubRepo: row.github_repo,
			branch: row.branch,
			githubUpstream: row.github_upstream ?? null,
			createdAt: new Date(row.created_at),
			updatedAt: new Date(row.updated_at),
		}
	}

	getAllProjects(): DbProject[] {
		const rows = this.db
			.prepare("SELECT * FROM projects ORDER BY created_at ASC")
			.all() as any[]

		return rows.map(this.parseProjectRow)
	}

	updateProject(id: string, input: UpdateProjectInput): DbProject {
		const updates: string[] = []
		const params: any[] = []

		if (input.name !== undefined) {
			updates.push("name = ?")
			params.push(input.name)
		}
		if (input.description !== undefined) {
			updates.push("description = ?")
			params.push(input.description)
		}
		if (input.githubRepo !== undefined) {
			updates.push("github_repo = ?")
			params.push(input.githubRepo ?? null)
		}
		if (input.branch !== undefined) {
			updates.push("branch = ?")
			params.push(input.branch ?? null)
		}
		if (input.githubUpstream !== undefined) {
			updates.push("github_upstream = ?")
			params.push(input.githubUpstream ?? null)
		}

		if (updates.length === 0) {
			return this.getProjectById(id)!
		}

		updates.push("updated_at = datetime('now')")
		params.push(id)

		this.run(
			`UPDATE projects SET ${updates.join(", ")} WHERE id = ?`,
			...params
		)
		return this.getProjectById(id)!
	}

	deleteProject(id: string): void {
		this.run("DELETE FROM projects WHERE id = ?", id)
	}

	// --- Columns ---

	createColumn(input: CreateColumnInput): DbColumn {
		const id = crypto.randomUUID()
		this.run(`
			INSERT INTO columns (id, project_id, name, prompt, skills, model, position, extras)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`,
			id,
			input.projectId,
			input.name,
			input.prompt,
			JSON.stringify(input.skills),
			input.model ?? null,
			input.position,
			JSON.stringify(input.extras ?? {})
		)
		return this.getColumnById(id)!
	}

	getColumnById(id: string): DbColumn | null {
		const row = this.db
			.prepare("SELECT * FROM columns WHERE id = ?")
			.get(id) as any | undefined

		if (!row) {
			return null
		}

		return this.parseColumnRow(row)
	}

	getColumnsByProject(projectId: string): DbColumn[] {
		const rows = this.db
			.prepare("SELECT * FROM columns WHERE project_id = ? ORDER BY position ASC")
			.all(projectId) as any[]

		return rows.map(this.parseColumnRow)
	}

	updateColumn(id: string, input: UpdateColumnInput): DbColumn {
		const updates: string[] = []
		const params: any[] = []

		if (input.name !== undefined) {
			updates.push("name = ?")
			params.push(input.name)
		}
		if (input.prompt !== undefined) {
			updates.push("prompt = ?")
			params.push(input.prompt)
		}
		if (input.skills !== undefined) {
			updates.push("skills = ?")
			params.push(JSON.stringify(input.skills))
		}
		if (input.model !== undefined) {
			updates.push("model = ?")
			params.push(input.model ?? null)
		}
		if (input.position !== undefined) {
			updates.push("position = ?")
			params.push(input.position)
		}
		if (input.extras !== undefined) {
			updates.push("extras = ?")
			params.push(JSON.stringify(input.extras ?? {}))
		}

		if (updates.length === 0) {
			return this.getColumnById(id)!
		}

		updates.push("updated_at = datetime('now')")
		params.push(id)

		this.run(
			`UPDATE columns SET ${updates.join(", ")} WHERE id = ?`,
			...params
		)
		return this.getColumnById(id)!
	}

	deleteColumn(id: string): void {
		this.run("DELETE FROM columns WHERE id = ?", id)
	}

	// --- Cards ---

	createCard(input: CreateCardInput): DbCard {
		const id = crypto.randomUUID()
		const targets = input.targets ?? parseTargets(input.body)
		this.run(`
			INSERT INTO cards (id, project_id, column_id, title, body, position, retry_count, depends_on, targets)
			VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
		`,
			id,
			input.projectId,
			input.columnId,
			input.title,
			input.body,
			input.position,
			input.dependsOn ?? null,
			JSON.stringify(targets)
		)
		return this.getCardById(id)!
	}

	getCardById(id: string): DbCard | null {
		const row = this.db
			.prepare("SELECT * FROM cards WHERE id = ?")
			.get(id) as any | undefined

		if (!row) {
			return null
		}

		return this.parseCardRow(row)
	}

	getCardsByProject(projectId: string): DbCard[] {
		const rows = this.db
			.prepare(
				"SELECT c.*, col.name as column_name FROM cards c LEFT JOIN columns col ON c.column_id = col.id WHERE c.project_id = ? ORDER BY c.column_id, c.position ASC"
			)
			.all(projectId) as any[]

		return rows.map((row) => {
			const card = this.parseCardRow(row)
			return card
		})
	}

	getCardsByColumn(columnId: string): DbCard[] {
		const rows = this.db
			.prepare("SELECT * FROM cards WHERE column_id = ? ORDER BY position ASC")
			.all(columnId) as any[]

		return rows.map(this.parseCardRow)
	}

	getFreeCardsByColumn(columnId: string): DbCard[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM cards WHERE column_id = ? AND claim_state IS NULL ORDER BY position ASC"
			)
			.all(columnId) as any[]

		return rows.map(this.parseCardRow)
	}

	getCardsNeedingHuman(projectId: string): DbCard[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM cards WHERE project_id = ? AND retry_count >= 3 ORDER BY created_at ASC"
			)
			.all(projectId) as any[]

		return rows.map(this.parseCardRow)
	}

	updateCard(id: string, input: UpdateCardInput): DbCard {
		const updates: string[] = []
		const params: any[] = []

		if (input.title !== undefined) {
			updates.push("title = ?")
			params.push(input.title)
		}
		if (input.body !== undefined) {
			updates.push("body = ?")
			params.push(input.body)
		}
		if (input.position !== undefined) {
			updates.push("position = ?")
			params.push(input.position)
		}
		if (input.retryCount !== undefined) {
			updates.push("retry_count = ?")
			params.push(input.retryCount)
		}
		if (input.claimState !== undefined) {
			updates.push("claim_state = ?")
			params.push(input.claimState ?? null)
		}
		if (input.claimedBy !== undefined) {
			updates.push("claimed_by = ?")
			params.push(input.claimedBy ?? null)
		}
		if (input.claimedAt !== undefined) {
			updates.push("claimed_at = ?")
			params.push(input.claimedAt ? input.claimedAt.toISOString() : null)
		}
		if (input.targets !== undefined) {
			updates.push("targets = ?")
			params.push(JSON.stringify(input.targets))
		}
		if (input.dependsOn !== undefined) {
			updates.push("depends_on = ?")
			params.push(input.dependsOn ?? null)
		}
		if (input.scenario !== undefined) {
			updates.push("scenario = ?")
			params.push(input.scenario ?? null)
		}
		if (input.stageRetries !== undefined) {
			updates.push("stage_retries = ?")
			params.push(JSON.stringify(input.stageRetries))
		}

		if (updates.length === 0) {
			return this.getCardById(id)!
		}

		updates.push("updated_at = datetime('now')")
		params.push(id)

		this.run(
			`UPDATE cards SET ${updates.join(", ")} WHERE id = ?`,
			...params
		)
		return this.getCardById(id)!
	}

	deleteCard(id: string): void {
		this.run("DELETE FROM cards WHERE id = ?", id)
	}

	claimCard(id: string, workerId: string): DbCard {
		const now = new Date()
		this.run(
			`UPDATE cards SET claim_state = 'claimed', claimed_by = ?, claimed_at = ?, updated_at = datetime('now') WHERE id = ?`,
			workerId, now.toISOString(), id
		)
		return this.getCardById(id)!
	}

	// Atomic claim: only succeeds if the card is currently unclaimed. Returns the
	// claimed card, or null if another worker already holds it (TOCTOU-safe).
	claimCardIfFree(id: string, workerId: string): DbCard | null {
		const now = new Date()
		this.run(
			`UPDATE cards SET claim_state = 'claimed', claimed_by = ?, claimed_at = ?, updated_at = datetime('now') WHERE id = ? AND claim_state IS NULL`,
			workerId, now.toISOString(), id
		)
		const changed = this.db.query("SELECT changes() AS n").get() as { n: number }
		if (changed.n === 0) {
			return null
		}
		return this.getCardById(id)!
	}

	unclaimCard(id: string): DbCard {
		this.run(
			`UPDATE cards SET claim_state = NULL, claimed_by = NULL, claimed_at = NULL, updated_at = datetime('now') WHERE id = ?`,
			id
		)
		return this.getCardById(id)!
	}

	// Restart recovery: free every card still marked claimed by this worker id. A
	// worker that crashes or is restarted mid-card leaves the claim set in the DB
	// with no live processor; without this, that card (and anything depending on it)
	// deadlocks forever. Called at worker startup. Returns the number of cards freed.
	releaseClaimsByWorker(workerId: string): number {
		this.run(
			`UPDATE cards SET claim_state = NULL, claimed_by = NULL, claimed_at = NULL, updated_at = datetime('now') WHERE claimed_by = ? AND claim_state = 'claimed'`,
			workerId
		)
		const changed = this.db.query("SELECT changes() AS n").get() as { n: number }
		return changed.n
	}

	lockCard(id: string): DbCard {
		this.run(
			`UPDATE cards SET claim_state = 'locked', updated_at = datetime('now') WHERE id = ?`,
			id
		)
		return this.getCardById(id)!
	}

	moveCard(id: string, newColumnId: string, newPosition: number, incrementRetry: boolean = false): DbCard {
		if (incrementRetry) {
			this.run(
				`UPDATE cards SET column_id = ?, position = ?, retry_count = retry_count + 1, claim_state = NULL, claimed_by = NULL, claimed_at = NULL, updated_at = datetime('now') WHERE id = ?`,
				newColumnId,
				newPosition,
				id
			)
		} else {
			this.run(
				`UPDATE cards SET column_id = ?, position = ?, updated_at = datetime('now') WHERE id = ?`,
				newColumnId,
				newPosition,
				id
			)
		}
		return this.getCardById(id)!
	}

	// --- Attempts ---

	createAttempt(input: CreateAttemptInput): DbAttempt {
		const id = crypto.randomUUID()
		this.run(`
			INSERT INTO attempts (id, card_id, transcript_path, verdict, started_at, completed_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`,
			id,
			input.cardId,
			input.transcriptPath ?? null,
			input.verdict !== null ? JSON.stringify(input.verdict) : null,
			input.startedAt.toISOString(),
			input.completedAt ? input.completedAt.toISOString() : null
		)
		return this.parseAttemptRow(this.db
			.prepare("SELECT * FROM attempts WHERE id = ?")
			.get(id) as any)
	}

	updateAttempt(id: string, input: UpdateAttemptInput): DbAttempt {
		const updates: string[] = []
		const params: any[] = []

		if (input.verdict !== undefined) {
			updates.push("verdict = ?")
			params.push(input.verdict !== null ? JSON.stringify(input.verdict) : null)
		}
		if (input.completedAt !== undefined) {
			updates.push("completed_at = ?")
			params.push(input.completedAt ? input.completedAt.toISOString() : null)
		}

		if (updates.length === 0) {
			return this.getAttemptById(id)!
		}

		params.push(id)
		this.run(
			`UPDATE attempts SET ${updates.join(", ")} WHERE id = ?`,
			...params
		)
		return this.getAttemptById(id)!
	}

	getAttemptsByCard(cardId: string): DbAttempt[] {
		const rows = this.db
			.prepare("SELECT * FROM attempts WHERE card_id = ? ORDER BY started_at DESC")
			.all(cardId) as any[]

		return rows.map(this.parseAttemptRow)
	}

	getAttemptById(id: string): DbAttempt | null {
		const row = this.db
			.prepare("SELECT * FROM attempts WHERE id = ?")
			.get(id) as any | undefined

		if (!row) {
			return null
		}

		return this.parseAttemptRow(row)
	}

	// --- Card Threads ---

	addCardThreadEntry(input: AddCardThreadEntryInput): DbCardThreadEntry {
		const id = crypto.randomUUID()
		this.run(`
			INSERT INTO card_threads (id, card_id, entry_type, content)
			VALUES (?, ?, ?, ?)
		`, id, input.cardId, input.entryType, input.content)

		const row = this.db
			.prepare("SELECT * FROM card_threads WHERE id = ?")
			.get(id) as any

		return this.parseThreadRow(row)
	}

	getCardThreads(cardId: string): DbCardThreadEntry[] {
		const rows = this.db
			.prepare("SELECT * FROM card_threads WHERE card_id = ? ORDER BY created_at ASC")
			.all(cardId) as any[]

		return rows.map(this.parseThreadRow)
	}

	// --- Cross-entity queries ---

	getProjectWithColumns(projectId: string): { project: DbProject; columns: DbColumn[] } | null {
		const project = this.getProjectById(projectId)
		if (!project) {
			return null
		}
		const columns = this.getColumnsByProject(projectId)
		return { project, columns }
	}

	// --- Parsers ---

	private parseProjectRow(row: any): DbProject {
		return {
			id: row.id,
			name: row.name,
			description: row.description,
			githubRepo: row.github_repo,
			branch: row.branch,
			githubUpstream: row.github_upstream ?? null,
			createdAt: new Date(row.created_at),
			updatedAt: new Date(row.updated_at),
		}
	}

	private parseColumnRow(row: any): DbColumn {
		return {
			id: row.id,
			projectId: row.project_id,
			name: row.name,
			prompt: row.prompt,
			skills: JSON.parse(row.skills ?? "[]"),
			model: row.model,
			position: row.position,
			extras: row.extras ? JSON.parse(row.extras) : null,
			createdAt: new Date(row.created_at),
			updatedAt: new Date(row.updated_at),
		}
	}

	private parseCardRow(row: any): DbCard {
		return {
			id: row.id,
			projectId: row.project_id,
			columnId: row.column_id,
			title: row.title,
			body: row.body,
			position: row.position,
			retryCount: row.retry_count,
			claimState: row.claim_state ?? null,
			claimedBy: row.claimed_by,
			claimedAt: row.claimed_at ? new Date(row.claimed_at) : null,
			dependsOn: row.depends_on ?? null,
			targets: row.targets ? JSON.parse(row.targets) : [],
			scenario: row.scenario ?? null,
			stageRetries: row.stage_retries ? JSON.parse(row.stage_retries) : {},
			createdAt: new Date(row.created_at),
			updatedAt: new Date(row.updated_at),
		}
	}

	private parseAttemptRow(row: any): DbAttempt {
		return {
			id: row.id,
			cardId: row.card_id,
			transcriptPath: row.transcript_path,
			verdict: row.verdict ? JSON.parse(row.verdict) : null,
			startedAt: new Date(row.started_at),
			completedAt: row.completed_at ? new Date(row.completed_at) : null,
		}
	}

	private parseThreadRow(row: any): DbCardThreadEntry {
		return {
			id: row.id,
			cardId: row.card_id,
			entryType: row.entry_type,
			content: row.content,
			createdAt: new Date(row.created_at),
		}
	}
}
