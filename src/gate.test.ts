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

	it("passes when a declared target is a directory prefix of a changed file", () => {
		expect(targetsSatisfied(["scenarios/main.yaml", "scenarios/saves/fix.json"], ["scenarios"])).toBe(true)
	})

	it("does not prefix-match a partial directory name (scripts vs scripts_old)", () => {
		expect(targetsSatisfied(["scripts_old/foo.gd"], ["scripts"])).toBe(false)
	})

	it("passes when the target has a trailing slash (directory convention)", () => {
		expect(targetsSatisfied(["scenarios/saves/fix.json"], ["scenarios/"])).toBe(true)
	})
})
