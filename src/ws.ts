import type { ServerWebSocket, WebSocketHandler } from "bun"

export type WSMessage =
  | { type: "card.moved"; cardId: string; projectId: string; fromColumn: string; toColumn: string; actor?: string; reason?: string; timestamp: number }
  | { type: "card.claimed"; cardId: string; projectId: string; workerId: string; timestamp: number }
  | { type: "card.unclaimed"; cardId: string; projectId: string; timestamp: number }
  | { type: "card.created"; cardId: string; projectId: string; columnId: string; timestamp: number }
  | { type: "card.updated"; cardId: string; projectId: string; timestamp: number }
  | { type: "card.deleted"; cardId: string; projectId: string; timestamp: number }
  | { type: "attempt.recorded"; cardId: string; projectId: string; transcriptPath: string | null; timestamp: number }
  | { type: "column.created"; columnId: string; projectId: string; timestamp: number }
  | { type: "column.updated"; columnId: string; projectId: string; timestamp: number }
  | { type: "column.deleted"; columnId: string; projectId: string; timestamp: number }
  | { type: "project.created"; projectId: string; timestamp: number }
  | { type: "project.updated"; projectId: string; timestamp: number }
  | { type: "project.deleted"; projectId: string; timestamp: number }

interface ClientState {
	ws: ServerWebSocket<unknown>
	subscribedProjects: Set<string>
}

export class WsBroker {
	private clients: Map<ServerWebSocket<unknown>, ClientState> = new Map()

	onOpen(ws: ServerWebSocket<unknown>): void {
		const state: ClientState = {
			ws,
			subscribedProjects: new Set(),
		}
		this.clients.set(ws, state)
	}

	onClose(ws: ServerWebSocket<unknown>, _code: number, _reason: string): void {
		this.clients.delete(ws)
	}

	onMessage(ws: ServerWebSocket<unknown>, message: string | Buffer): void {
		let data: any

		try {
			data = typeof message === "string"
				? JSON.parse(message)
				: JSON.parse(new TextDecoder().decode(message))
		} catch {
			return
		}

		if (!data || typeof data !== "object") {
			return
		}

		if (data.type === "subscribe" && typeof data.projectId === "string") {
			const state = this.clients.get(ws)
			if (state) {
				state.subscribedProjects.add(data.projectId)
			}
		}
	}

	broadcast(msg: WSMessage): void {
		const payload = JSON.stringify(msg)
		const buf = new TextEncoder().encode(payload)

		for (const [ws, state] of this.clients) {
			if (ws.readyState !== WebSocket.OPEN) {
				this.clients.delete(ws)
				continue
			}

			if (shouldReceive(state, msg)) {
				try {
					ws.send(buf)
				} catch {
					this.clients.delete(ws)
				}
			}
		}
	}

	closeAll(code: number = 1000, reason: string = "shutting down"): void {
		for (const ws of this.clients.keys()) {
			ws.close(code, reason)
		}
		this.clients.clear()
	}
}

function shouldReceive(state: ClientState, msg: WSMessage): boolean {
	if (state.subscribedProjects.size === 0) {
		// No subscriptions — receive everything
		return true
	}

	const projectId = (msg as any).projectId
	if (!projectId) {
		return false
	}

	return state.subscribedProjects.has(projectId)
}

export function wsHandler(broker: WsBroker): WebSocketHandler<unknown> {
	return {
		open(ws: ServerWebSocket<unknown>): void {
			broker.onOpen(ws)
		},

		close(ws: ServerWebSocket<unknown>, code: number, reason: string): void {
			broker.onClose(ws, code, reason)
		},

		message(ws: ServerWebSocket<unknown>, message: string | Buffer): void {
			broker.onMessage(ws, message)
		},
	}
}
