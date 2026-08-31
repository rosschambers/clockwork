import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { ensureBareOrigin } from "./ensure-bare-origin.ts"
import fs from "node:fs"

function makeTempDir(): string {
	return fs.mkdtempSync("/tmp/clockwork-bare-test-")
}

describe("ensureBareOrigin", () => {
	let root: string

	beforeEach(() => {
		root = makeTempDir()
	})

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true })
	})

	it("creates a bare repo when the origin does not exist", async () => {
		const origin = `${root}/origin.git`
		const result = await ensureBareOrigin(origin)
		expect(result.ok).toBe(true)
		expect(result.action).toBe("created")
		const check = Bun.spawnSync(["git", "-C", origin, "rev-parse", "--is-bare-repository"], {})
		expect(new TextDecoder().decode(check.stdout!).trim()).toBe("true")
	})

	it("is a no-op when the origin is already bare", async () => {
		const origin = `${root}/origin.git`
		await ensureBareOrigin(origin)
		const result = await ensureBareOrigin(origin)
		expect(result.action).toBe("already-bare")
	})

	it("converts a non-bare origin via updateInstead", async () => {
		const origin = `${root}/nonbare`
		fs.mkdirSync(origin)
		Bun.spawnSync(["git", "-C", origin, "init"], {})
		const result = await ensureBareOrigin(origin)
		expect(result.action).toBe("converted")
		const check = Bun.spawnSync(["git", "-C", origin, "config", "receive.denyCurrentBranch"], {})
		expect(new TextDecoder().decode(check.stdout!).trim()).toBe("updateInstead")
	})
})
