import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { serveStatic, type StaticHandler } from "./web.ts"
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

function createTempDir(): { dir: string; cleanup(): void } {
	const dir = `/tmp/clockwork-static-test-${randomUUID()}`
	fs.mkdirSync(dir, { recursive: true })
	return {
		dir,
		cleanup(): void {
			fs.rmSync(dir, { recursive: true, force: true })
		},
	}
}

describe("serveStatic", () => {
	let dir: string
	let handler: StaticHandler
	let cleanup: () => void

	beforeEach(() => {
		const result = createTempDir()
		dir = result.dir
		cleanup = result.cleanup

		// Write a test file
		fs.writeFileSync(path.join(dir, "test.txt"), "hello world")
		fs.writeFileSync(path.join(dir, "style.css"), "body { margin: 0; }")
		fs.writeFileSync(path.join(dir, "app.js"), "console.log('hi')")

		handler = serveStatic(dir)
	})

	afterEach(() => {
		cleanup()
	})

	it("serves an existing file", () => {
		const req = new Request(`http://localhost/test.txt`)
		const res = handler(req)

		expect(res).toBeDefined()
		expect(res!.status).toBe(200)
		expect(res!.headers.get("Content-Type")).toContain("text/plain")
	})

	it("returns undefined for a non-existent file", () => {
		const req = new Request(`http://localhost/does-not-exist.txt`)
		const res = handler(req)

		expect(res).toBeUndefined()
	})

	it("returns correct Content-Type by extension", () => {
		const cssReq = new Request(`http://localhost/style.css`)
		const cssRes = handler(cssReq)
		expect(cssRes).toBeDefined()
		expect(cssRes!.headers.get("Content-Type")).toContain("text/css")

		const jsReq = new Request(`http://localhost/app.js`)
		const jsRes = handler(jsReq)
		expect(jsRes).toBeDefined()
		expect(jsRes!.headers.get("Content-Type")).toContain("application/javascript")
	})
})
