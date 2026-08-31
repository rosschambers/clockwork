import { describe, it, expect } from "bun:test"
import { parseTargets } from "./targets.ts"

describe("parseTargets", () => {
	it("parses an explicit targets: line", () => {
		expect(parseTargets("Do the thing.\ntargets: scripts/main.gd, project.godot")).toEqual([
			"scripts/main.gd",
			"project.godot",
		])
	})

	it("parses the 'Only <files>' body convention", () => {
		expect(parseTargets("Only main.gd should change.")).toEqual(["main.gd"])
	})

	it("returns [] when nothing is declared", () => {
		expect(parseTargets("Just write a plan document.")).toEqual([])
	})

	it("rejects natural-English 'only' that does not contain file paths", () => {
		// "only when X is true" — no file paths in the match
		expect(parseTargets("flips DAMAGED → LIVE only when `can_repair` is true; returns bool.")).toEqual([])
		// "only to another weapon" — no file paths
		expect(parseTargets("a weapon adjacent only to another weapon chains power through it (weapons conduct).")).toEqual([])
		// "only for M2" — no file paths
		expect(parseTargets("tier (1 only for M2)")).toEqual([])
	})

	it("keeps valid file paths from the 'Only' heuristic", () => {
		expect(parseTargets("Only scripts/main.gd and project.godot should change.")).toEqual([
			"scripts/main.gd",
			"project.godot",
		])
	})

	it("keeps valid file paths from an explicit targets: line", () => {
		expect(parseTargets("Do stuff.\ntargets: scripts/grid.gd, tests/test_grid.gd")).toEqual([
			"scripts/grid.gd",
			"tests/test_grid.gd",
		])
	})
})
