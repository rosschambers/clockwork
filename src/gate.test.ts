import { describe, it, expect } from "bun:test"
import { targetsSatisfied } from "./gate.ts"

describe("targetsSatisfied", () => {
	it("passes when no targets are declared", () => {
		expect(targetsSatisfied(["docs/plan.md"], [])).toBe(true)
	})

	it("fails when a declared code target is unchanged (docs-only diff)", () => {
		expect(targetsSatisfied(["docs/plan.md"], ["scripts/main.gd"])).toBe(false)
	})

	it("passes when a declared target is in the changed set", () => {
		expect(targetsSatisfied(["scripts/main.gd", "docs/plan.md"], ["scripts/main.gd"])).toBe(true)
	})
})
