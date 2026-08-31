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

// --- SMS to Ross via the exocortex async-workload-complete webhook ---
//
// A separate path from notify() above: that speaks the clockwork event shape
// (Bearer header); the exocortex webhook expects { token, message } in the BODY
// (see exocortex automation/notify.md). We keep them distinct so this SMS-to-a-
// human channel and the generic event webhook can't drift into each other.

export interface SmsConfig {
	url: string
	token: string
}

// Build the human-readable text for a card that has parked at needs-human. The
// feedback carries the specific block reason, which is exactly what Ross wants.
export function smsForNeedsHuman(cardTitle: string, reason: string): string {
	const trimmed = reason.trim()
	const detail = trimmed.length > 0 ? ` — ${trimmed}` : ""
	return `clockwork BLOCKED: "${cardTitle}" needs a human${detail}`
}

// Build the text for milestone completion, optionally naming the shared build path.
export function smsForMilestoneComplete(milestone: string, buildPath?: string): string {
	const where = buildPath ? ` Build ready to play-test at: ${buildPath}` : ""
	return `clockwork COMPLETE: ${milestone}.${where}`
}

// Fire-and-forget SMS. A 200 does not prove SMS delivery (see notify.md), but a
// non-2xx or a throw is worth logging. Never throws out to the caller — a failed
// notification must not affect card processing.
export async function sendSms(message: string, config: SmsConfig): Promise<void> {
	try {
		const res = await fetch(config.url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: config.token, message }),
		})
		if (!res.ok) {
			console.error(`[clockwork] SMS webhook returned ${res.status} ${res.statusText}`)
		}
	} catch (err) {
		console.error(`[clockwork] SMS webhook failed: ${String(err)}`)
	}
}
