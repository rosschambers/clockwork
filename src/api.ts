import type { Server } from "bun"
import { DbStore, type DbCard } from "./db.ts"
import { WsBroker, wsHandler, type WSMessage } from "./ws.ts"
import { serveStatic } from "./web.ts"
import { notify, columnNotificationType, retryExhausted, type NotifyEvent } from "./notify.ts"
import path from "node:path"

export interface ServerConfig {
	dbStore: DbStore
	port?: number
	maxRetries?: number
	notifyUrl?: string
	notifyToken?: string
	gitToken?: string
}

export interface ServerHandle {
	server: Server<unknown>
	port: number
	stop(): void
}

function jsonResponse(status: number, data: unknown): Response {
	const body = JSON.stringify(data)
	return new Response(body, {
		status,
		headers: { "Content-Type": "application/json" },
	})
}

function errorResponse(status: number, message: string): Response {
	return jsonResponse(status, { error: message })
}

function checkAuth(request: Request, requiredToken: string | null): boolean {
	if (!requiredToken) {
		return true
	}

	const auth = request.headers.get("Authorization")
	if (!auth) {
		return false
	}

	const parts = auth.split(" ")
	if (parts.length !== 2 || parts[0] !== "Bearer") {
		return false
	}

	return parts[1] === requiredToken
}

function parseBody(request: Request): Promise<any> {
	return new Promise((resolve, reject) => {
		request.json().then(resolve).catch((err) => reject(err))
	})
}

function findParam(path: string, pattern: string, paramName: string): { match: boolean; param: string | null; rest: string } {
	const regex = new RegExp(`^${pattern}/([^/]+)(/.*)?$`)
	const match = path.match(regex)
	if (match) {
		return { match: true, param: match[1] ?? null, rest: match[2] || "" }
	}
	return { match: false, param: null, rest: "" }
}

function parseProjectRequest(body: any): { ok: boolean; data?: any; error?: string } {
	if (!body.name || typeof body.name !== "string") {
		return { ok: false, error: "name is required and must be a string" }
	}

	return { ok: true, data: {
		name: body.name,
		description: typeof body.description === "string" ? body.description : "",
		githubRepo: typeof body.github_repo === "string" ? body.github_repo : null,
		branch: typeof body.branch === "string" ? body.branch : null,
	}}
}

function parseUpdateProject(body: any): { ok: boolean; data?: any; error?: string } {
	const updates: any = {}

	if (body.name !== undefined && typeof body.name !== "string") {
		return { ok: false, error: "name must be a string if provided" }
	}
	if (body.description !== undefined && typeof body.description !== "string") {
		return { ok: false, error: "description must be a string if provided" }
	}

	if (body.name !== undefined) {
		updates.name = body.name
	}
	if (body.description !== undefined) {
		updates.description = body.description
	}
	if (body.github_repo !== undefined) {
		updates.githubRepo = body.github_repo
	}
	if (body.branch !== undefined) {
		updates.branch = body.branch
	}

	return { ok: true, data: updates }
}

function parseColumnRequest(body: any): { ok: boolean; data?: any; error?: string } {
	if (!body.name || typeof body.name !== "string") {
		return { ok: false, error: "name is required" }
	}

	if (typeof body.prompt !== "string") {
		return { ok: false, error: "prompt is required" }
	}

	if (typeof body.position !== "number") {
		return { ok: false, error: "position is required" }
	}

	const skills: string[] = Array.isArray(body.skills)
		? body.skills.map((s: any) => String(s))
		: []

	const model: string | null = typeof body.model === "string" ? body.model : null

	const extras: Record<string, unknown> | null = body.extras && typeof body.extras === "object"
		? body.extras
		: null

	return { ok: true, data: {
		name: body.name,
		prompt: body.prompt,
		skills,
		model,
		position: body.position,
		extras,
	}}
}

function parseUpdateColumn(body: any): { ok: boolean; data?: any; error?: string } {
	const updates: any = {}

	if (body.name !== undefined) {
		updates.name = body.name
	}
	if (body.prompt !== undefined) {
		updates.prompt = body.prompt
	}
	if (body.skills !== undefined) {
		updates.skills = body.skills
	}
	if (body.model !== undefined) {
		updates.model = body.model
	}
	if (body.position !== undefined) {
		updates.position = body.position
	}
	if (body.extras !== undefined) {
		updates.extras = body.extras
	}

	return { ok: true, data: updates }
}

function parseCardRequest(body: any): { ok: boolean; data?: any; error?: string } {
	if (!body.column_id || typeof body.column_id !== "string") {
		return { ok: false, error: "column_id is required" }
	}

	if (!body.title || typeof body.title !== "string") {
		return { ok: false, error: "title is required" }
	}

	return { ok: true, data: {
		columnId: body.column_id,
		title: body.title,
		body: typeof body.body === "string" ? body.body : "",
	}}
}

function parseUpdateCard(body: any): { ok: boolean; data?: any; error?: string } {
	const updates: any = {}

	if (body.title !== undefined) {
		updates.title = body.title
	}
	if (body.body !== undefined) {
		updates.body = body.body
	}
	if (body.position !== undefined) {
		updates.position = body.position
	}

	return { ok: true, data: updates }
}

function nextPositionInColumn(dbStore: DbStore, projectId: string, columnId: string): number {
	const cards = dbStore.getCardsByProject(projectId)
	let maxPos = -1

	for (const card of cards) {
		if (card.columnId === columnId && card.position > maxPos) {
			maxPos = card.position
		}
	}

	return maxPos + 1
}

function findClaimableCard(dbStore: DbStore, projectId: string): DbCard | null {
	const allCards = dbStore.getCardsByProject(projectId)

	const eligible = allCards.filter((card) => {
		if (card.claimState !== null) {
			return false
		}
		if (card.retryCount >= 3) {
			return false
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

	return eligible[0] ?? null
}

async function handleProjectsGet(_request: Request, dbStore: DbStore, _broker: WsBroker): Promise<Response> {
	const projects = dbStore.getAllProjects()
	return jsonResponse(200, projects)
}

async function handleProjectsPost(request: Request, dbStore: DbStore, broker: WsBroker): Promise<Response> {
	let body: any

	try {
		body = await parseBody(request)
	} catch {
		return errorResponse(400, "invalid JSON body")
	}

	const parsed = parseProjectRequest(body)
	if (!parsed.ok) {
		return errorResponse(400, parsed.error!)
	}

	const project = dbStore.createProject(parsed.data!)
	broker.broadcast({ type: "project.created", projectId: project.id, timestamp: Date.now() } as WSMessage)
	return jsonResponse(201, project)
}

async function handleProjectGet(request: Request, dbStore: DbStore, id: string, _broker: WsBroker): Promise<Response> {
	const result = dbStore.getProjectWithColumns(id)

	if (!result) {
		return errorResponse(404, "project not found")
	}

	return jsonResponse(200, result)
}

async function handleProjectPut(request: Request, dbStore: DbStore, id: string, broker: WsBroker): Promise<Response> {
	let body: any

	try {
		body = await parseBody(request)
	} catch {
		return errorResponse(400, "invalid JSON body")
	}

	const existing = dbStore.getProjectById(id)
	if (!existing) {
		return errorResponse(404, "project not found")
	}

	const parsed = parseUpdateProject(body)
	if (!parsed.ok) {
		return errorResponse(400, parsed.error!)
	}

	const updated = dbStore.updateProject(id, parsed.data!)
	broker.broadcast({ type: "project.updated", projectId: updated.id, timestamp: Date.now() } as WSMessage)
	return jsonResponse(200, updated)
}

async function handleProjectDelete(request: Request, dbStore: DbStore, id: string, broker: WsBroker): Promise<Response> {
	const existing = dbStore.getProjectById(id)
	if (!existing) {
		return errorResponse(404, "project not found")
	}

	dbStore.deleteProject(id)
	broker.broadcast({ type: "project.deleted", projectId: id, timestamp: Date.now() } as WSMessage)
	return jsonResponse(200, { deleted: id })
}

async function handleColumnsGet(request: Request, dbStore: DbStore, projectId: string, _broker: WsBroker): Promise<Response> {
	const project = dbStore.getProjectById(projectId)
	if (!project) {
		return errorResponse(404, "project not found")
	}

	const columns = dbStore.getColumnsByProject(projectId)
	return jsonResponse(200, columns)
}

async function handleColumnsPost(request: Request, dbStore: DbStore, projectId: string, broker: WsBroker): Promise<Response> {
	const project = dbStore.getProjectById(projectId)
	if (!project) {
		return errorResponse(404, "project not found")
	}

	let body: any

	try {
		body = await parseBody(request)
	} catch {
		return errorResponse(400, "invalid JSON body")
	}

	const parsed = parseColumnRequest(body)
	if (!parsed.ok) {
		return errorResponse(400, parsed.error!)
	}

	const column = dbStore.createColumn({
		projectId,
		...parsed.data!,
	})

	broker.broadcast({ type: "column.created", columnId: column.id, projectId, timestamp: Date.now() } as WSMessage)
	return jsonResponse(201, column)
}

async function handleColumnPut(request: Request, dbStore: DbStore, id: string, broker: WsBroker): Promise<Response> {
	let body: any

	try {
		body = await parseBody(request)
	} catch {
		return errorResponse(400, "invalid JSON body")
	}

	const existing = dbStore.getColumnById(id)
	if (!existing) {
		return errorResponse(404, "column not found")
	}

	const parsed = parseUpdateColumn(body)
	if (!parsed.ok) {
		return errorResponse(400, parsed.error!)
	}

	const updated = dbStore.updateColumn(id, parsed.data!)
	broker.broadcast({ type: "column.updated", columnId: updated.id, projectId: updated.projectId, timestamp: Date.now() } as WSMessage)
	return jsonResponse(200, updated)
}

async function handleColumnDelete(request: Request, dbStore: DbStore, id: string, broker: WsBroker): Promise<Response> {
	const existing = dbStore.getColumnById(id)
	if (!existing) {
		return errorResponse(404, "column not found")
	}

	const projectId = existing.projectId
	dbStore.deleteColumn(id)
	broker.broadcast({ type: "column.deleted", columnId: id, projectId, timestamp: Date.now() } as WSMessage)
	return jsonResponse(200, { deleted: id })
}

async function handleCardsGet(request: Request, dbStore: DbStore, projectId: string, _broker: WsBroker): Promise<Response> {
	const project = dbStore.getProjectById(projectId)
	if (!project) {
		return errorResponse(404, "project not found")
	}

	const url = new URL(request.url)
	const columnId = url.searchParams.get("column_id")

	let cards: DbCard[]

	if (columnId) {
		const projectCards = dbStore.getCardsByProject(projectId)
		cards = projectCards.filter((c) => c.columnId === columnId)
	} else {
		cards = dbStore.getCardsByProject(projectId)
	}

	return jsonResponse(200, cards)
}

async function handleCardsPost(request: Request, dbStore: DbStore, projectId: string, broker: WsBroker): Promise<Response> {
	const project = dbStore.getProjectById(projectId)
	if (!project) {
		return errorResponse(404, "project not found")
	}

	let body: any

	try {
		body = await parseBody(request)
	} catch {
		return errorResponse(400, "invalid JSON body")
	}

	const parsed = parseCardRequest(body)
	if (!parsed.ok) {
		return errorResponse(400, parsed.error!)
	}

	const pos = nextPositionInColumn(dbStore, projectId, parsed.data!.columnId)

	const card = dbStore.createCard({
		projectId,
		columnId: parsed.data!.columnId,
		title: parsed.data!.title,
		body: parsed.data!.body,
		position: pos,
	})

	broker.broadcast({ type: "card.created", cardId: card.id, projectId, columnId: card.columnId, timestamp: Date.now() } as WSMessage)
	return jsonResponse(201, card)
}

async function handleCardGet(request: Request, dbStore: DbStore, id: string, _broker: WsBroker): Promise<Response> {
	const card = dbStore.getCardById(id)
	if (!card) {
		return errorResponse(404, "card not found")
	}

	const threads = dbStore.getCardThreads(id)
	const attempts = dbStore.getAttemptsByCard(id)

	return jsonResponse(200, {
		card,
		threads,
		attempts,
	})
}

async function handleCardPut(request: Request, dbStore: DbStore, id: string, broker: WsBroker): Promise<Response> {
	let body: any

	try {
		body = await parseBody(request)
	} catch {
		return errorResponse(400, "invalid JSON body")
	}

	const existing = dbStore.getCardById(id)
	if (!existing) {
		return errorResponse(404, "card not found")
	}

	const parsed = parseUpdateCard(body)
	if (!parsed.ok) {
		return errorResponse(400, parsed.error!)
	}

	const updated = dbStore.updateCard(id, parsed.data!)
	broker.broadcast({ type: "card.updated", cardId: updated.id, projectId: updated.projectId, timestamp: Date.now() } as WSMessage)
	return jsonResponse(200, updated)
}

async function handleCardDelete(request: Request, dbStore: DbStore, id: string, broker: WsBroker): Promise<Response> {
	const existing = dbStore.getCardById(id)
	if (!existing) {
		return errorResponse(404, "card not found")
	}

	const projectId = existing.projectId
	dbStore.deleteCard(id)
	broker.broadcast({ type: "card.deleted", cardId: id, projectId, timestamp: Date.now() } as WSMessage)
	return jsonResponse(200, { deleted: id })
}

async function handleCardMove(request: Request, dbStore: DbStore, id: string, broker: WsBroker, maxRetries: number, notifyUrl: string | undefined, notifyToken: string | undefined): Promise<Response> {
	let body: any

	try {
		body = await parseBody(request)
	} catch {
		return errorResponse(400, "invalid JSON body")
	}

	if (!body.to_column_id || typeof body.to_column_id !== "string") {
		return errorResponse(400, "to_column_id is required")
	}

	const card = dbStore.getCardById(id)
	if (!card) {
		return errorResponse(404, "card not found")
	}

	const targetColumn = dbStore.getColumnById(body.to_column_id)
	if (!targetColumn) {
		return errorResponse(404, "target column not found")
	}

	const fromColumn = card.columnId
	const projectId = card.projectId
	const isKickback = body.kickback === true
	const pos = nextPositionInColumn(dbStore, card.projectId, targetColumn.id)

	const moved = dbStore.moveCard(id, targetColumn.id, pos, isKickback)

	// Fire notifications based on destination column and retry state

	if (notifyUrl && notifyToken) {
		const proj = dbStore.getProjectById(projectId)
		const projTitle = proj ? proj.name : "Unknown"
		const cardAfter = dbStore.getCardById(id)
		const colName = targetColumn.name

		const eventBase: Omit<NotifyEvent, "type"> = {
			projectId,
			projectTitle: projTitle,
			cardId: id,
			cardTitle: cardAfter ? cardAfter.title : "Unknown",
			column: colName,
		}

		if (isKickback && cardAfter && retryExhausted(cardAfter.retryCount, maxRetries)) {
			await notify({ ...eventBase, type: "retry-exhausted" }, notifyUrl, notifyToken)
		}

		const colType = columnNotificationType(colName)
		if (colType) {
			await notify({ ...eventBase, type: colType, feedback: body.reason ? String(body.reason) : undefined }, notifyUrl, notifyToken)
		}
	}

	if (body.actor || body.reason) {
		const actor = body.actor || "unknown"
		const reason = body.reason || ""
		dbStore.addCardThreadEntry({
			cardId: id,
			entryType: "move",
			content: JSON.stringify({ actor, reason, from: fromColumn, to: targetColumn.id }),
		})
	}

	broker.broadcast({
		type: "card.moved",
		cardId: id,
		projectId,
		fromColumn,
		toColumn: targetColumn.id,
		actor: body.actor ? String(body.actor) : undefined,
		reason: body.reason ? String(body.reason) : undefined,
		timestamp: Date.now(),
	} as WSMessage)

	return jsonResponse(200, moved)
}

async function handleAttemptsPost(request: Request, dbStore: DbStore, cardId: string, broker: WsBroker): Promise<Response> {
	const card = dbStore.getCardById(cardId)
	if (!card) {
		return errorResponse(404, "card not found")
	}

	let body: any

	try {
		body = await parseBody(request)
	} catch {
		return errorResponse(400, "invalid JSON body")
	}

	const transcriptPath = typeof body.transcript_path === "string" ? body.transcript_path : null
	const verdict: Record<string, unknown> | null =
		body.verdict !== undefined && typeof body.verdict === "object" ? body.verdict : null

	const attempt = dbStore.createAttempt({
		cardId,
		transcriptPath,
		verdict,
		startedAt: new Date(),
		completedAt: null,
	})

	broker.broadcast({
		type: "attempt.recorded",
		cardId,
		projectId: card.projectId,
		transcriptPath,
		timestamp: Date.now(),
	} as WSMessage)

	return jsonResponse(201, attempt)
}

async function handleAttemptsGet(request: Request, dbStore: DbStore, cardId: string, _broker: WsBroker): Promise<Response> {
	const attempts = dbStore.getAttemptsByCard(cardId)
	return jsonResponse(200, attempts)
}

async function handleClaim(request: Request, dbStore: DbStore, projectId: string, broker: WsBroker): Promise<Response> {
	const project = dbStore.getProjectById(projectId)
	if (!project) {
		return errorResponse(404, "project not found")
	}

	let body: any

	try {
		body = await parseBody(request)
	} catch {
		return errorResponse(400, "invalid JSON body")
	}

	if (!body.worker_id || typeof body.worker_id !== "string") {
		return errorResponse(400, "worker_id is required")
	}

	const card = findClaimableCard(dbStore, projectId)
	if (!card) {
		return errorResponse(404, "no claimable cards found")
	}

	const claimed = dbStore.claimCard(card.id, body.worker_id)
	broker.broadcast({ type: "card.claimed", cardId: claimed.id, projectId, workerId: body.worker_id, timestamp: Date.now() } as WSMessage)
	return jsonResponse(200, claimed)
}

async function handleUnclaim(request: Request, dbStore: DbStore, id: string, broker: WsBroker): Promise<Response> {
	const existing = dbStore.getCardById(id)
	if (!existing) {
		return errorResponse(404, "card not found")
	}

	dbStore.unclaimCard(id)
	broker.broadcast({ type: "card.unclaimed", cardId: id, projectId: existing.projectId, timestamp: Date.now() } as WSMessage)
	return jsonResponse(200, { unclaimed: id })
}

function route(request: Request, dbStore: DbStore, requiredToken: string | null, broker: WsBroker, maxRetries: number, notifyUrl: string | undefined, notifyToken: string | undefined): Response | Promise<Response> {
	if (!checkAuth(request, requiredToken)) {
		return errorResponse(401, "unauthorized")
	}

	const url = new URL(request.url)
	const path = url.pathname
	const method = request.method

	if (method === "GET" && path === "/api/projects") {
		return handleProjectsGet(request, dbStore, broker)
	}

	if (method === "POST" && path === "/api/projects") {
		return handleProjectsPost(request, dbStore, broker)
	}

	const projectMatch = findParam(path, "/api/projects", "project_id")

	if (method === "GET" && projectMatch.match && !projectMatch.rest) {
		return handleProjectGet(request, dbStore, projectMatch.param!, broker)
	}

	if (method === "PUT" && projectMatch.match && !projectMatch.rest) {
		return handleProjectPut(request, dbStore, projectMatch.param!, broker)
	}

	if (method === "DELETE" && projectMatch.match && !projectMatch.rest) {
		return handleProjectDelete(request, dbStore, projectMatch.param!, broker)
	}

	if (method === "GET" && projectMatch.match && projectMatch.rest === "/columns") {
		return handleColumnsGet(request, dbStore, projectMatch.param!, broker)
	}

	if (method === "POST" && projectMatch.match && projectMatch.rest === "/columns") {
		return handleColumnsPost(request, dbStore, projectMatch.param!, broker)
	}

	if (method === "POST" && projectMatch.match && projectMatch.rest === "/claim") {
		return handleClaim(request, dbStore, projectMatch.param!, broker)
	}

	if (method === "GET" && projectMatch.match && projectMatch.rest === "/cards") {
		return handleCardsGet(request, dbStore, projectMatch.param!, broker)
	}

	if (method === "POST" && projectMatch.match && projectMatch.rest === "/cards") {
		return handleCardsPost(request, dbStore, projectMatch.param!, broker)
	}

	const columnMatch = findParam(path, "/api/columns", "column_id")

	if (method === "PUT" && columnMatch.match && !columnMatch.rest) {
		return handleColumnPut(request, dbStore, columnMatch.param!, broker)
	}

	if (method === "DELETE" && columnMatch.match && !columnMatch.rest) {
		return handleColumnDelete(request, dbStore, columnMatch.param!, broker)
	}

	const cardMatch = findParam(path, "/api/cards", "card_id")

	if (method === "GET" && cardMatch.match && !cardMatch.rest) {
		return handleCardGet(request, dbStore, cardMatch.param!, broker)
	}

	if (method === "PUT" && cardMatch.match && !cardMatch.rest) {
		return handleCardPut(request, dbStore, cardMatch.param!, broker)
	}

	if (method === "DELETE" && cardMatch.match && !cardMatch.rest) {
		return handleCardDelete(request, dbStore, cardMatch.param!, broker)
	}

	if (method === "POST" && cardMatch.match && cardMatch.rest === "/move") {
		return handleCardMove(request, dbStore, cardMatch.param!, broker, maxRetries, notifyUrl, notifyToken)
	}

	if (method === "POST" && cardMatch.match && cardMatch.rest === "/attempts") {
		return handleAttemptsPost(request, dbStore, cardMatch.param!, broker)
	}

	if (method === "GET" && cardMatch.match && cardMatch.rest === "/attempts") {
		return handleAttemptsGet(request, dbStore, cardMatch.param!, broker)
	}

	if (method === "POST" && cardMatch.match && cardMatch.rest === "/unclaim") {
		return handleUnclaim(request, dbStore, cardMatch.param!, broker)
	}

	return errorResponse(404, "not found")
}

export function startServer(config: ServerConfig): ServerHandle {
	const dbStore = config.dbStore
	const requiredToken = process.env.CLOCKWORK_TOKEN || null
	const broker = new WsBroker()

	// Apply env overrides if not explicitly set in config
	if (!config.notifyUrl) {
		config.notifyUrl = process.env.CLOCKWORK_NOTIFY_URL
	}
	if (!config.notifyToken) {
		config.notifyToken = process.env.CLOCKWORK_NOTIFY_TOKEN
	}
	if (!config.gitToken) {
		config.gitToken = process.env.CLOCKWORK_GIT_TOKEN
	}
	if (config.maxRetries === undefined) {
		config.maxRetries = 3
	}

	const bunServer = Bun.serve({
		port: config.port ?? 3000,

		fetch(request: Request): Response | Promise<Response> | undefined {
			const url = new URL(request.url)
			if (url.pathname === "/ws" && request.headers.get("upgrade") === "websocket") {
				if (bunServer.upgrade(request, { data: {} })) {
					return undefined
				}
				return errorResponse(400, "websocket upgrade failed")
			}

			const staticDir = path.join(import.meta.dir, "..", "public")
			const staticHandler = serveStatic(staticDir)
			const staticRes = staticHandler(request)
			if (staticRes !== undefined) {
				return staticRes
			}

			return route(request, dbStore, requiredToken, broker, config.maxRetries ?? 3, config.notifyUrl, config.notifyToken)
		},

		websocket: wsHandler(broker),
	})

	return {
		server: bunServer,
		port: bunServer.port ?? 0,
		stop(): void {
			broker.closeAll()
			bunServer.stop()
		},
	}
}
