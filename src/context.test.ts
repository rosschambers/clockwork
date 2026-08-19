import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { ContextAssembler, type ContextAssemblerOptions, type PlanSlice, type ThreadEntry, type AssembledContext } from "./context.ts"
import fs from "node:fs"
import path from "node:path"

function createTempProject(projectMdContent: string): { projectRoot: string; cleanup: () => void } {
	const projectRoot = path.join("/tmp", `clockwork-context-test-${crypto.randomUUID()}`)
	fs.mkdirSync(projectRoot, { recursive: true })
	fs.writeFileSync(path.join(projectRoot, "PROJECT.md"), projectMdContent)
	return {
		projectRoot,
		cleanup(): void {
			fs.rmSync(projectRoot, { recursive: true, force: true })
		},
	}
}

function makePlanSlice(id: string, title: string, content: string, relevantCardIds: string[] = []): PlanSlice {
	return { id, title, content, relevantCardIds }
}

function makeThreadEntry(id: string, entryType: ThreadEntry["entryType"], content: string, timestamp: number): ThreadEntry {
	return { id, entryType, content, timestamp }
}

function assembleContext(options: ContextAssemblerOptions): AssembledContext {
	const assembler = new ContextAssembler(options)
	return assembler.assemble()
}

describe("ContextAssembler — basic assembly", () => {
	let projectRoot: string
	let cleanup: () => void

	beforeEach(() => {
		const tmp = createTempProject("# Test Project\nProject brief here.")
		projectRoot = tmp.projectRoot
		cleanup = tmp.cleanup
	})

	afterEach(() => {
		cleanup()
	})

	it("assembles all components in correct order", () => {
		const result = assembleContext({
			projectRoot,
			planFiles: [makePlanSlice("p1", "Plan", "Plan content here.", ["card-1"])],
			cardThread: [makeThreadEntry("t1", "note", "A note.", 1000)],
			columnExtras: "Extra context.",
			tokenBudget: 64000,
		})

		expect(result.systemPrompt).toContain("# Test Project")
		expect(result.systemPrompt).toContain("Plan content here.")
		expect(result.systemPrompt).toContain("A note.")
		expect(result.systemPrompt).toContain("Extra context.")
		expect(result.truncated).toBe(false)
	})

	it("includes section headers in output", () => {
		const result = assembleContext({
			projectRoot,
			planFiles: [makePlanSlice("p1", "Plan", "Plan content.", ["card-1"])],
			cardThread: [makeThreadEntry("t1", "feedback", "Feedback text.", 1000)],
			columnExtras: "Diff content.",
			tokenBudget: 64000,
		})

		expect(result.systemPrompt).toContain("## Project")
		expect(result.systemPrompt).toContain("## Plan")
		expect(result.systemPrompt).toContain("## Card Thread")
		expect(result.systemPrompt).toContain("## Column Extras")
	})
})

describe("ContextAssembler — PROJECT.md from disk", () => {
	it("reads PROJECT.md from default location", () => {
		const tmp = createTempProject("# My Project\nStable brief.")
		try {
			const result = assembleContext({
				projectRoot: tmp.projectRoot,
				planFiles: [],
				cardThread: [],
				columnExtras: "",
				tokenBudget: 64000,
			})

			expect(result.systemPrompt).toContain("# My Project")
			expect(result.systemPrompt).toContain("Stable brief.")
		} finally {
			tmp.cleanup()
		}
	})

	it("reads PROJECT.md from custom path", () => {
		const tmp = createTempProject("# My Project")
		try {
			fs.mkdirSync(path.join(tmp.projectRoot, "docs"), { recursive: true })
			fs.writeFileSync(path.join(tmp.projectRoot, "docs", "PROJECT.md"), "# Custom brief.\nCustom content.")

			const result = assembleContext({
				projectRoot: tmp.projectRoot,
				projectMdPath: "docs/PROJECT.md",
				planFiles: [],
				cardThread: [],
				columnExtras: "",
				tokenBudget: 64000,
			})

			expect(result.systemPrompt).toContain("# Custom brief.")
			expect(result.systemPrompt).not.toContain("# My Project")
		} finally {
			tmp.cleanup()
		}
	})

	it("handles missing PROJECT.md gracefully", () => {
		const tmp = createTempProject("# My Project")
		try {
			fs.unlinkSync(path.join(tmp.projectRoot, "PROJECT.md"))

			const result = assembleContext({
				projectRoot: tmp.projectRoot,
				planFiles: [],
				cardThread: [],
				columnExtras: "",
				tokenBudget: 64000,
			})

			expect(result.systemPrompt).toContain("## Project")
			expect(result.systemPrompt).toContain("No PROJECT.md found")
		} finally {
			tmp.cleanup()
		}
	})
})

describe("ContextAssembler — plan slice filtering", () => {
	let projectRoot: string
	let cleanup: () => void

	beforeEach(() => {
		const tmp = createTempProject("# Project")
		projectRoot = tmp.projectRoot
		cleanup = tmp.cleanup
	})

	afterEach(() => {
		cleanup()
	})

	it("includes only plan slices relevant to the card", () => {
		const result = assembleContext({
			projectRoot,
			planFiles: [
				makePlanSlice("p1", "Plan A", "Plan A content.", ["card-1"]),
				makePlanSlice("p2", "Plan B", "Plan B content.", ["card-2"]),
				makePlanSlice("p3", "Plan C", "Plan C content.", ["card-1", "card-3"]),
			],
			cardThread: [],
			columnExtras: "",
			tokenBudget: 64000,
			cardId: "card-1",
		})

		expect(result.systemPrompt).toContain("Plan A content.")
		expect(result.systemPrompt).toContain("Plan C content.")
		expect(result.systemPrompt).not.toContain("Plan B content.")
	})

	it("includes plan with empty relevantCardIds as globally relevant", () => {
		const result = assembleContext({
			projectRoot,
			planFiles: [
				makePlanSlice("p1", "General Plan", "General plan for everything.", []),
				makePlanSlice("p2", "Specific Plan", "Specific plan.", ["card-2"]),
			],
			cardThread: [],
			columnExtras: "",
			tokenBudget: 64000,
			cardId: "card-1",
		})

		expect(result.systemPrompt).toContain("General plan for everything.")
		expect(result.systemPrompt).not.toContain("Specific plan.")
	})

	it("omits plans when no slice is relevant", () => {
		const result = assembleContext({
			projectRoot,
			planFiles: [makePlanSlice("p1", "Irrelevant", "Should not appear.", ["other-card"])],
			cardThread: [],
			columnExtras: "",
			tokenBudget: 64000,
			cardId: "card-1",
		})

		expect(result.systemPrompt).not.toContain("Should not appear.")
	})
})

describe("ContextAssembler — thread truncation", () => {
	let projectRoot: string
	let cleanup: () => void

	beforeEach(() => {
		const tmp = createTempProject("# Project")
		projectRoot = tmp.projectRoot
		cleanup = tmp.cleanup
	})

	afterEach(() => {
		cleanup()
	})

	it("includes all thread entries when under maxThreadEntries", () => {
		const entries: ThreadEntry[] = Array.from({ length: 5 }, (_, i) =>
			makeThreadEntry(`t${i}`, "note", `Entry ${i}.`, 1000 + i)
		)

		const result = assembleContext({
			projectRoot,
			planFiles: [],
			cardThread: entries,
			columnExtras: "",
			tokenBudget: 64000,
			maxThreadEntries: 10,
		})

		expect(result.systemPrompt).toContain("Entry 0.")
		expect(result.systemPrompt).toContain("Entry 4.")
		expect(result.truncated).toBe(false)
	})

	it("truncates oldest entries when over maxThreadEntries", () => {
		const entries: ThreadEntry[] = Array.from({ length: 10 }, (_, i) =>
			makeThreadEntry(`t${i}`, "note", `Entry ${i}.`, 1000 + i)
		)

		const result = assembleContext({
			projectRoot,
			planFiles: [],
			cardThread: entries,
			columnExtras: "",
			tokenBudget: 64000,
			maxThreadEntries: 5,
		})

		// Oldest (0-4) dropped, newest (5-9) kept
		expect(result.systemPrompt).not.toContain("Entry 0.")
		expect(result.systemPrompt).not.toContain("Entry 4.")
		expect(result.systemPrompt).toContain("Entry 5.")
		expect(result.systemPrompt).toContain("Entry 9.")
		expect(result.truncated).toBe(true)
	})

	it("truncates by timestamp order, not array order", () => {
		const entries: ThreadEntry[] = [
			makeThreadEntry("t-new", "note", "Newest.", 3000),
			makeThreadEntry("t-old", "note", "Oldest.", 1000),
			makeThreadEntry("t-mid", "note", "Middle.", 2000),
		]

		const result = assembleContext({
			projectRoot,
			planFiles: [],
			cardThread: entries,
			columnExtras: "",
			tokenBudget: 64000,
			maxThreadEntries: 2,
		})

		expect(result.systemPrompt).not.toContain("Oldest.")
		expect(result.systemPrompt).toContain("Middle.")
		expect(result.systemPrompt).toContain("Newest.")
		expect(result.truncated).toBe(true)
	})

	it("uses default maxThreadEntries of 20", () => {
		const entries: ThreadEntry[] = Array.from({ length: 25 }, (_, i) =>
			makeThreadEntry(`t${i}`, "note", `Entry ${i}.`, 1000 + i)
		)

		const result = assembleContext({
			projectRoot,
			planFiles: [],
			cardThread: entries,
			columnExtras: "",
			tokenBudget: 64000,
		})

		expect(result.systemPrompt).not.toContain("Entry 0.")
		expect(result.systemPrompt).toContain("Entry 19.")
		expect(result.systemPrompt).toContain("Entry 24.")
		expect(result.truncated).toBe(true)
	})
})

describe("ContextAssembler — token budget enforcement", () => {
	let projectRoot: string
	let cleanup: () => void

	beforeEach(() => {
		const tmp = createTempProject("# Project")
		projectRoot = tmp.projectRoot
		cleanup = tmp.cleanup
	})

	afterEach(() => {
		cleanup()
	})

	it("stays under token budget via thread truncation", () => {
		const longEntry = makeThreadEntry("t-long", "note", "X".repeat(40000), 1000)
		const shortEntry = makeThreadEntry("t-short", "note", "Keep this.", 2000)

		const result = assembleContext({
			projectRoot,
			planFiles: [],
			cardThread: [longEntry, shortEntry],
			columnExtras: "",
			tokenBudget: 5000,
			maxThreadEntries: 2,
		})

		expect(result.tokenCount).toBeLessThanOrEqual(5000)
		expect(result.truncated).toBe(true)
		expect(result.systemPrompt).toContain("Keep this.")
	})

	it("truncates plan slice when thread alone would exceed budget", () => {
		const longPlan = makePlanSlice("p-long", "Long Plan", "P".repeat(50000), ["card-1"])
		const longEntry = makeThreadEntry("t-long", "note", "X".repeat(20000), 1000)

		const result = assembleContext({
			projectRoot,
			planFiles: [longPlan],
			cardThread: [longEntry],
			columnExtras: "",
			tokenBudget: 10000,
			maxThreadEntries: 1,
		})

		expect(result.tokenCount).toBeLessThanOrEqual(10000)
		expect(result.truncated).toBe(true)
		expect(result.systemPrompt).toContain("Long Plan")
		expect(result.systemPrompt.length).toBeLessThan(50000)
	})

	it("calculates token count using 4-char-per-token heuristic", () => {
		const result = assembleContext({
			projectRoot,
			planFiles: [],
			cardThread: [],
			columnExtras: "",
			tokenBudget: 64000,
		})

		const expectedTokens = Math.ceil(result.systemPrompt.length / 4)
		expect(result.tokenCount).toBe(expectedTokens)
	})

	it("uses default token budget of 64000", () => {
		const largeContent = "X".repeat(256000)
		const result = assembleContext({
			projectRoot,
			planFiles: [makePlanSlice("p", "P", largeContent, [])],
			cardThread: [],
			columnExtras: "",
			// tokenBudget omitted, should default to 64000
		})

		expect(result.tokenCount).toBeLessThanOrEqual(64000)
		expect(result.truncated).toBe(true)
	})
})

describe("ContextAssembler — column extras", () => {
	let projectRoot: string
	let cleanup: () => void

	beforeEach(() => {
		const tmp = createTempProject("# Project")
		projectRoot = tmp.projectRoot
		cleanup = tmp.cleanup
	})

	afterEach(() => {
		cleanup()
	})

	it("appends column extras at the end", () => {
		const result = assembleContext({
			projectRoot,
			planFiles: [],
			cardThread: [],
			columnExtras: "@@ -1 +1 @@\n-old\n+new",
			tokenBudget: 64000,
		})

		expect(result.systemPrompt).toContain("@@ -1 +1 @@")
		expect(result.systemPrompt).toContain("## Column Extras")
	})

	it("omits column extras section when empty", () => {
		const result = assembleContext({
			projectRoot,
			planFiles: [],
			cardThread: [],
			columnExtras: "",
			tokenBudget: 64000,
		})

		expect(result.systemPrompt).not.toContain("## Column Extras")
	})
})

describe("ContextAssembler — truncated flag", () => {
	let projectRoot: string
	let cleanup: () => void

	beforeEach(() => {
		const tmp = createTempProject("# Project")
		projectRoot = tmp.projectRoot
		cleanup = tmp.cleanup
	})

	afterEach(() => {
		cleanup()
	})

	it("is false when nothing is truncated", () => {
		const result = assembleContext({
			projectRoot,
			planFiles: [makePlanSlice("p1", "P", "Short plan.", [])],
			cardThread: [makeThreadEntry("t1", "note", "Short note.", 1000)],
			columnExtras: "Short extras.",
			tokenBudget: 64000,
			maxThreadEntries: 20,
		})

		expect(result.truncated).toBe(false)
	})

	it("is true when thread entries were dropped", () => {
		const entries: ThreadEntry[] = Array.from({ length: 10 }, (_, i) =>
			makeThreadEntry(`t${i}`, "note", `Entry ${i}.`, 1000 + i)
		)

		const result = assembleContext({
			projectRoot,
			planFiles: [],
			cardThread: entries,
			columnExtras: "",
			tokenBudget: 64000,
			maxThreadEntries: 5,
		})

		expect(result.truncated).toBe(true)
	})

	it("is true when plan was truncated to fit budget", () => {
		const result = assembleContext({
			projectRoot,
			planFiles: [makePlanSlice("p", "P", "X".repeat(100000), [])],
			cardThread: [],
			columnExtras: "",
			tokenBudget: 1000,
		})

		expect(result.truncated).toBe(true)
	})

	it("is true when thread was truncated for budget even if maxThreadEntries not reached", () => {
		const entries: ThreadEntry[] = Array.from({ length: 3 }, (_, i) =>
			makeThreadEntry(`t${i}`, "note", "X".repeat(20000), 1000 + i)
		)

		const result = assembleContext({
			projectRoot,
			planFiles: [],
			cardThread: entries,
			columnExtras: "",
			tokenBudget: 5000,
			maxThreadEntries: 10,
		})

		expect(result.truncated).toBe(true)
		expect(result.tokenCount).toBeLessThanOrEqual(5000)
	})
})

describe("ContextAssembler — empty inputs", () => {
	let projectRoot: string
	let cleanup: () => void

	beforeEach(() => {
		const tmp = createTempProject("# Project")
		projectRoot = tmp.projectRoot
		cleanup = tmp.cleanup
	})

	afterEach(() => {
		cleanup()
	})

	it("handles empty plan files", () => {
		const result = assembleContext({
			projectRoot,
			planFiles: [],
			cardThread: [],
			columnExtras: "",
			tokenBudget: 64000,
		})

		expect(result.systemPrompt).toContain("## Project")
		expect(result.truncated).toBe(false)
	})

	it("handles empty thread", () => {
		const result = assembleContext({
			projectRoot,
			planFiles: [makePlanSlice("p1", "P", "Plan.", [])],
			cardThread: [],
			columnExtras: "",
			tokenBudget: 64000,
		})

		expect(result.systemPrompt).toContain("## Plan")
		expect(result.systemPrompt).toContain("Plan.")
		expect(result.systemPrompt).not.toContain("## Card Thread")
	})

	it("handles all empty except PROJECT.md", () => {
		const result = assembleContext({
			projectRoot,
			planFiles: [],
			cardThread: [],
			columnExtras: "",
			tokenBudget: 64000,
		})

		expect(result.systemPrompt).toContain("## Project")
		expect(result.systemPrompt).toContain("# Project")
		expect(result.systemPrompt).not.toContain("## Plan")
		expect(result.systemPrompt).not.toContain("## Card Thread")
		expect(result.systemPrompt).not.toContain("## Column Extras")
	})
})

describe("ContextAssembler — multiple plan slices", () => {
	let projectRoot: string
	let cleanup: () => void

	beforeEach(() => {
		const tmp = createTempProject("# Project")
		projectRoot = tmp.projectRoot
		cleanup = tmp.cleanup
	})

	afterEach(() => {
		cleanup()
	})

	it("merges multiple relevant plan slices", () => {
		const result = assembleContext({
			projectRoot,
			planFiles: [
				makePlanSlice("p1", "Phase 1", "Phase 1 content.", ["card-1"]),
				makePlanSlice("p2", "Phase 2", "Phase 2 content.", ["card-1"]),
				makePlanSlice("p3", "Phase 3", "Phase 3 content.", ["card-1"]),
			],
			cardThread: [],
			columnExtras: "",
			tokenBudget: 64000,
		})

		expect(result.systemPrompt).toContain("Phase 1 content.")
		expect(result.systemPrompt).toContain("Phase 2 content.")
		expect(result.systemPrompt).toContain("Phase 3 content.")
	})

	it("labels each plan slice with its title", () => {
		const result = assembleContext({
			projectRoot,
			planFiles: [
				makePlanSlice("p1", "Auth Plan", "Auth content.", ["card-1"]),
				makePlanSlice("p2", "API Plan", "API content.", ["card-1"]),
			],
			cardThread: [],
			columnExtras: "",
			tokenBudget: 64000,
		})

		expect(result.systemPrompt).toContain("Auth Plan")
		expect(result.systemPrompt).toContain("API Plan")
		expect(result.systemPrompt).toContain("Auth content.")
		expect(result.systemPrompt).toContain("API content.")
	})
})

describe("ContextAssembler — over-budget plan slice truncation", () => {
	let projectRoot: string
	let cleanup: () => void

	beforeEach(() => {
		const tmp = createTempProject("# Project\nThis is the brief.")
		projectRoot = tmp.projectRoot
		cleanup = tmp.cleanup
	})

	afterEach(() => {
		cleanup()
	})

	it("truncates plan content from the end when over budget after thread", () => {
		const result = assembleContext({
			projectRoot,
			planFiles: [makePlanSlice("p1", "Plan", "X".repeat(100000), ["card-1"])],
			cardThread: [makeThreadEntry("t1", "note", "Important note.", 1000)],
			columnExtras: "",
			tokenBudget: 5000,
			maxThreadEntries: 10,
		})

		expect(result.tokenCount).toBeLessThanOrEqual(5000)
		expect(result.truncated).toBe(true)
		expect(result.systemPrompt).toContain("Plan")
		expect(result.systemPrompt).toContain("Important note.")
		expect(result.systemPrompt).toContain("# Project")
	})

	it("never truncates PROJECT.md even when severely over budget", () => {
		const projectBrief = "# Critical Project Brief\n\nNever lose this.\n"
		const tmp2 = createTempProject(projectBrief)
		try {
			const result = assembleContext({
				projectRoot: tmp2.projectRoot,
				planFiles: [makePlanSlice("p1", "Plan", "X".repeat(100000), ["card-1"])],
				cardThread: [],
				columnExtras: "",
				tokenBudget: 2000,
			})

			expect(result.systemPrompt).toContain("# Critical Project Brief")
			expect(result.systemPrompt).toContain("Never lose this.")
			expect(result.tokenCount).toBeLessThanOrEqual(2000)
			expect(result.truncated).toBe(true)
		} finally {
			tmp2.cleanup()
		}
	})

	it("preserves plan section label after truncation", () => {
		const result = assembleContext({
			projectRoot,
			planFiles: [makePlanSlice("p1", "Important Plan", "X".repeat(100000), ["card-1"])],
			cardThread: [],
			columnExtras: "",
			tokenBudget: 1000,
		})

		expect(result.systemPrompt).toContain("Important Plan")
		expect(result.truncated).toBe(true)
	})
})

describe("ContextAssembler — thread entry formatting", () => {
	let projectRoot: string
	let cleanup: () => void

	beforeEach(() => {
		const tmp = createTempProject("# Project")
		projectRoot = tmp.projectRoot
		cleanup = tmp.cleanup
	})

	afterEach(() => {
		cleanup()
	})

	it("labels each thread entry by type", () => {
		const result = assembleContext({
			projectRoot,
			planFiles: [],
			cardThread: [
				makeThreadEntry("t1", "feedback", "Feedback content.", 1000),
				makeThreadEntry("t2", "verdict", "Verdict content.", 2000),
				makeThreadEntry("t3", "note", "Note content.", 3000),
			],
			columnExtras: "",
			tokenBudget: 64000,
		})

		expect(result.systemPrompt).toContain("[feedback]")
		expect(result.systemPrompt).toContain("[verdict]")
		expect(result.systemPrompt).toContain("[note]")
	})

	it("orders thread entries chronologically in output", () => {
		const result = assembleContext({
			projectRoot,
			planFiles: [],
			cardThread: [
				makeThreadEntry("t3", "note", "Third.", 3000),
				makeThreadEntry("t1", "note", "First.", 1000),
				makeThreadEntry("t2", "note", "Second.", 2000),
			],
			columnExtras: "",
			tokenBudget: 64000,
		})

		const firstIndex = result.systemPrompt.indexOf("First.")
		const secondIndex = result.systemPrompt.indexOf("Second.")
		const thirdIndex = result.systemPrompt.indexOf("Third.")

		expect(firstIndex).toBeLessThan(secondIndex)
		expect(secondIndex).toBeLessThan(thirdIndex)
	})
})
