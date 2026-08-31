import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { notify, columnNotificationType, retryExhausted, smsForNeedsHuman, smsForMilestoneComplete, sendSms, type NotifyEvent } from "./notify.ts"

function makeEvent(overrides: Partial<NotifyEvent> = {}): NotifyEvent {
	return {
		type: "needs-human",
		projectId: "proj-1",
		projectTitle: "Test Project",
		cardId: "card-1",
		cardTitle: "Test Card",
		column: "Needs Human",
		feedback: "Manual review needed",
		...overrides,
	}
}

describe("notify — successful delivery", () => {
	let originalFetch: typeof fetch

	beforeEach(() => {
		originalFetch = globalThis.fetch
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	it("POSTs the event JSON with bearer token", async () => {
		const event = makeEvent({ type: "needs-human" })
		let capturedBody: string = ""
		let capturedUrl = ""
		let capturedHeaders: Record<string, string> = {}

		// @ts-expect-error test mock does not implement fetch.preconnect
		globalThis.fetch = mock(async (url: string, init: RequestInit) => {
			capturedUrl = url
			capturedBody = init.body as string
			capturedHeaders = (init.headers as Record<string, string>) ?? {}
			return new Response(null, { status: 200 })
		})

		await notify(event, "https://notify.example.com/webhook", "test-token")

		expect(capturedUrl).toBe("https://notify.example.com/webhook")
		expect(capturedHeaders["Content-Type"]).toBe("application/json")
		expect(capturedHeaders["Authorization"]).toBe("Bearer test-token")
		expect(JSON.parse(capturedBody)).toEqual(event)
	})

	it("resolves when server returns 200", async () => {
		// @ts-expect-error test mock does not implement fetch.preconnect
		globalThis.fetch = mock(async () =>
			new Response(null, { status: 200 })
		)

		await expect(
			notify(makeEvent(), "https://example.com/hook", "tok"),
		).resolves.toBeUndefined()
	})
})

describe("notify — error handling", () => {
	let originalFetch: typeof fetch

	beforeEach(() => {
		originalFetch = globalThis.fetch
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	it("logs error but resolves on non-200", async () => {
		const logs: string[] = []
		const origErr = console.error
		console.error = (...args: unknown[]) => {
			logs.push(args.map(String).join(" "))
		}

		// @ts-expect-error test mock does not implement fetch.preconnect
		globalThis.fetch = mock(async () =>
			new Response("Not found", { status: 404 })
		)

		await notify(makeEvent(), "https://example.com/hook", "tok")

		console.error = origErr
		expect(logs[0]).toMatch(/^\[clockwork\] notification failed: 404 /)
	})

	it("throws on network failure", async () => {
		// @ts-expect-error test mock does not implement fetch.preconnect
		globalThis.fetch = mock(async () => {
			throw new Error("ENOTFOUND")
		})

		await expect(
			notify(makeEvent(), "https://example.com/hook", "tok"),
		).rejects.toThrow("ENOTFOUND")
	})
})

describe("columnNotificationType", () => {
	it("returns needs-human for column containing 'human'", () => {
		expect(columnNotificationType("Needs Human")).toBe("needs-human")
		expect(columnNotificationType("needs-human")).toBe("needs-human")
		expect(columnNotificationType("NEEDS HUMAN")).toBe("needs-human")
		expect(columnNotificationType("human-review")).toBe("needs-human")
	})

	it("returns needs-director for column containing 'director'", () => {
		expect(columnNotificationType("Needs Director")).toBe("needs-director")
		expect(columnNotificationType("director-review")).toBe("needs-director")
	})

	it("returns deploy-done for column containing 'done'", () => {
		expect(columnNotificationType("Done")).toBe("deploy-done")
		expect(columnNotificationType("done")).toBe("deploy-done")
	})

	it("returns deploy-done for column containing 'deploy'", () => {
		expect(columnNotificationType("Deploy")).toBe("deploy-done")
		expect(columnNotificationType("deploy")).toBe("deploy-done")
		expect(columnNotificationType("deploy-staging")).toBe("deploy-done")
	})

	it("returns null for columns without matching keywords", () => {
		expect(columnNotificationType("Backlog")).toBeNull()
		expect(columnNotificationType("Implementation")).toBeNull()
		expect(columnNotificationType("Review")).toBeNull()
		expect(columnNotificationType("Testing")).toBeNull()
	})
})

describe("retryExhausted", () => {
	it("returns true when retryCount equals maxRetries", () => {
		expect(retryExhausted(3, 3)).toBe(true)
	})

	it("returns true when retryCount exceeds maxRetries", () => {
		expect(retryExhausted(5, 3)).toBe(true)
	})

	it("returns false when retryCount is below maxRetries", () => {
		expect(retryExhausted(0, 3)).toBe(false)
		expect(retryExhausted(1, 3)).toBe(false)
		expect(retryExhausted(2, 3)).toBe(false)
	})

	it("returns true when both are zero", () => {
		expect(retryExhausted(0, 0)).toBe(true)
	})
})

describe("SMS to Ross (exocortex webhook)", () => {
	let originalFetch: typeof fetch
	beforeEach(() => { originalFetch = globalThis.fetch })
	afterEach(() => { globalThis.fetch = originalFetch })

	it("needs-human message names the card and includes the block reason", () => {
		const msg = smsForNeedsHuman("Render: HUD", "vision QA failed: no build tray visible")
		expect(msg).toContain("Render: HUD")
		expect(msg).toContain("no build tray visible")
		expect(msg.toLowerCase()).toContain("block")
	})

	it("milestone message includes the shared build path when provided", () => {
		const msg = smsForMilestoneComplete("M1 render", "/srv/playtest/prism-drift")
		expect(msg).toContain("M1 render")
		expect(msg).toContain("/srv/playtest/prism-drift")
	})

	it("sendSms POSTs { token, message } in the body (exocortex webhook shape)", async () => {
		let capturedBody = ""
		// @ts-expect-error test mock does not implement fetch.preconnect
		globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
			capturedBody = init.body as string
			return { ok: true, status: 200, statusText: "OK" } as Response
		})
		await sendSms("hello", { url: "https://n8n.example/webhook/x", token: "tok" })
		const parsed = JSON.parse(capturedBody)
		expect(parsed.token).toBe("tok")
		expect(parsed.message).toBe("hello")
	})

	it("sendSms never throws even if the webhook fails", async () => {
		// @ts-expect-error test mock does not implement fetch.preconnect
		globalThis.fetch = mock(async () => { throw new Error("network down") })
		await expect(
			sendSms("x", { url: "https://n8n.example/webhook/x", token: "t" }),
		).resolves.toBeUndefined()
	})
})
