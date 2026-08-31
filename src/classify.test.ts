import { describe, it, expect } from "bun:test"
import { classifyParkReason, SUGGESTED_ACTIONS } from "./classify.ts"

describe("classifyParkReason", () => {
	it("classifies a deliverable-gate feedback", () => {
		expect(classifyParkReason("deliverable gate: declared targets not changed")).toBe("deliverable-missing")
	})
	it("classifies a dependency feedback", () => {
		expect(classifyParkReason("blocked: prerequisite card not done")).toBe("dependency")
	})
	it("classifies a scope feedback", () => {
		expect(classifyParkReason("this card is too big, re-scope")).toBe("scope-mismatch")
	})
	it("classifies preemption", () => {
		expect(classifyParkReason("arbiter preempted repeatedly")).toBe("preemption-exhausted")
	})
	it("defaults to genuine-failure", () => {
		expect(classifyParkReason("tests failed with assertion error")).toBe("genuine-failure")
	})
	it("classifies a sync divergence", () => {
		expect(classifyParkReason("sync-diverged: pipeline both ahead and behind github")).toBe("sync-diverged")
	})
	it("classifies the word diverged", () => {
		expect(classifyParkReason("the repo has diverged from upstream")).toBe("sync-diverged")
	})
	it("exposes suggested actions for sync-diverged", () => {
		expect(SUGGESTED_ACTIONS["sync-diverged"]).toEqual(["reconcileSync", "requeueCard"])
	})
})
