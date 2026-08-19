export interface NotifyEvent {
	type: "needs-human" | "needs-director" | "retry-exhausted" | "deploy-done"
	projectId: string
	projectTitle: string
	cardId: string
	cardTitle: string
	column?: string
	feedback?: string
}

export async function notify(
	event: NotifyEvent,
	url: string,
	token: string,
):Promise<void> {
	const body = JSON.stringify(event)

	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body,
	})

	if (!res.ok) {
		console.error(
			`[clockwork] notification failed: ${res.status} ${res.statusText}`,
		)
	}
}

export function columnNotificationType(columnName: string): NotifyEvent["type"] | null {
	const name = columnName.toLowerCase()

	if (name.includes("human")) {
		return "needs-human"
	}
	if (name.includes("director")) {
		return "needs-director"
	}
	if (name.includes("done") || name.includes("deploy")) {
		return "deploy-done"
	}

	return null
}

export function retryExhausted(retryCount: number, maxRetries: number): boolean {
	return retryCount >= maxRetries
}
