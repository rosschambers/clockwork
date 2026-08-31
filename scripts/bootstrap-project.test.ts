import { describe, it, expect } from "bun:test"
import { pipelineColumns } from "./bootstrap-project.ts"

describe("pipelineColumns", () => {
	it("Code-Review prompt rejects a plan-only deliverable", () => {
		const cols = pipelineColumns("MODEL")
		const review = cols.find((c) => c.name === "Code-Review")
		expect(review).toBeDefined()
		expect(review!.prompt.toLowerCase()).toContain("deliverable")
		expect(review!.prompt.toLowerCase()).toContain("plan")
	})
})
