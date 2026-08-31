import { describe, it, expect } from "bun:test"
import { parseVerdict, extractAssistantText, type Verdict } from "./verdict.ts"

function makeVerdict(verdict: Verdict["verdict"], feedback = "", artifacts: string[] = []): Verdict {
	return { verdict, feedback, artifacts }
}

describe("parseVerdict — valid verdicts", () => {
	it("parses a valid pass verdict", () => {
		const output = JSON.stringify(makeVerdict("pass", "All tests green."))

		const result = parseVerdict(output)

		expect(result.verdict).toBe("pass")
		expect(result.feedback).toBe("All tests green.")
		expect(result.artifacts).toEqual([])
	})

	it("parses a valid fail verdict", () => {
		const output = JSON.stringify(makeVerdict("fail", "Unit test assertion failed on line 42."))

		const result = parseVerdict(output)

		expect(result.verdict).toBe("fail")
		expect(result.feedback).toBe("Unit test assertion failed on line 42.")
		expect(result.artifacts).toEqual([])
	})

	it("parses a valid blocked verdict", () => {
		const output = JSON.stringify(makeVerdict("blocked", "Waiting on external API."))

		const result = parseVerdict(output)

		expect(result.verdict).toBe("blocked")
		expect(result.feedback).toBe("Waiting on external API.")
		expect(result.artifacts).toEqual([])
	})

	it("parses verdict with artifacts", () => {
		const output = JSON.stringify(makeVerdict("pass", "Done.", ["src/main.ts", "README.md"]))

		const result = parseVerdict(output)

		expect(result.verdict).toBe("pass")
		expect(result.artifacts).toEqual(["src/main.ts", "README.md"])
	})
})

describe("parseVerdict — extra fields", () => {
	it("ignores extra fields in the JSON", () => {
		const output = JSON.stringify({
			verdict: "pass",
			feedback: "Good.",
			artifacts: [],
			_extra: "should be ignored",
			score: 99,
		})

		const result = parseVerdict(output)

		expect(result.verdict).toBe("pass")
		expect(result.feedback).toBe("Good.")
	})
})

describe("parseVerdict — default fields", () => {
	it("defaults feedback to empty string when missing", () => {
		const output = JSON.stringify({ verdict: "pass", artifacts: [] })

		const result = parseVerdict(output)

		expect(result.verdict).toBe("pass")
		expect(result.feedback).toBe("")
	})

	it("defaults artifacts to empty array when missing", () => {
		const output = JSON.stringify({ verdict: "pass", feedback: "Good." })

		const result = parseVerdict(output)

		expect(result.verdict).toBe("pass")
		expect(result.artifacts).toEqual([])
	})

	it("defaults both when both missing", () => {
		const output = JSON.stringify({ verdict: "pass" })

		const result = parseVerdict(output)

		expect(result.verdict).toBe("pass")
		expect(result.feedback).toBe("")
		expect(result.artifacts).toEqual([])
	})
})

describe("parseVerdict — no JSON in output", () => {
	it("returns blocked when output has no JSON at all", () => {
		const result = parseVerdict("Just some plain text from the agent.")

		expect(result.verdict).toBe("blocked")
		expect(result.feedback).toBe("No JSON found in output")
		expect(result.artifacts).toEqual([])
	})

	it("returns blocked when output is only whitespace", () => {
		const result = parseVerdict("   \n\t  ")

		expect(result.verdict).toBe("blocked")
	})
})

describe("parseVerdict — malformed JSON", () => {
	it("returns blocked on truncated JSON", () => {
		const result = parseVerdict(`{"verdict": "pass", "feedback": "`)

		expect(result.verdict).toBe("blocked")
	})

	it("returns blocked on bad syntax", () => {
		const result = parseVerdict(`{verdict: "pass", feedback: "ok"}`)

		expect(result.verdict).toBe("blocked")
	})

	it("returns blocked on single trailing brace", () => {
		const result = parseVerdict("} ")

		expect(result.verdict).toBe("blocked")
	})
})

describe("parseVerdict — JSON not at tail", () => {
	it("extracts the LAST JSON object, not the first", () => {
		const output = JSON.stringify({ verdict: "fail", feedback: "Wrong." }) +
			"\n\n" +
			JSON.stringify({ verdict: "pass", feedback: "Fixed." })

		const result = parseVerdict(output)

		expect(result.verdict).toBe("pass")
		expect(result.feedback).toBe("Fixed.")
	})

	it("ignores JSON in the middle when tail has no JSON", () => {
		const output = JSON.stringify({ verdict: "pass" }) + "\n\nSome agent chatter with no JSON."

		const result = parseVerdict(output)

		expect(result.verdict).toBe("blocked")
	})
})

describe("parseVerdict — empty input", () => {
	it("returns blocked for empty string", () => {
		const result = parseVerdict("")

		expect(result.verdict).toBe("blocked")
		expect(result.feedback).toBe("Empty output")
	})
})

describe("parseVerdict — unknown verdict value", () => {
	it("treats unknown verdict as blocked", () => {
		const output = JSON.stringify({ verdict: "maybe", feedback: "Not sure." })

		const result = parseVerdict(output)

		expect(result.verdict).toBe("blocked")
	})

	it("treats empty string verdict as blocked", () => {
		const output = JSON.stringify({ verdict: "", feedback: "Empty verdict." })

		const result = parseVerdict(output)

		expect(result.verdict).toBe("blocked")
	})
})

describe("parseVerdict — feedback with JSON-like chars", () => {
	it("handles feedback containing curly braces", () => {
		const output = JSON.stringify({
			verdict: "pass",
			feedback: 'The code looks like {"key": "value"} but works.',
		})

		const result = parseVerdict(output)

		expect(result.verdict).toBe("pass")
		expect(result.feedback).toBe('The code looks like {"key": "value"} but works.')
	})

	it("handles feedback containing JSON-like text", () => {
		const output = JSON.stringify({
			verdict: "fail",
			feedback: "Expected {\"a\":1} but got {\"a\":2}",
		})

		const result = parseVerdict(output)

		expect(result.verdict).toBe("fail")
		expect(result.feedback).toBe('Expected {"a":1} but got {"a":2}')
	})

	it("handles feedback with nested braces", () => {
		const output = JSON.stringify({
			verdict: "pass",
			feedback: "Deep nesting: {{{{}}}}",
		})

		const result = parseVerdict(output)

		expect(result.verdict).toBe("pass")
		expect(result.feedback).toBe("Deep nesting: {{{{}}}}")
	})
})

describe("parseVerdict — real pi session output", () => {
	it("extracts verdict from mixed prose + JSON output", () => {
		const output = [
			"Here's what I did:\n",
			"1. Modified src/main.ts\n",
			"2. Ran tests\n",
			"All good. Here's the verdict:\n",
			JSON.stringify(makeVerdict("pass", "Implementation complete.")),
		].join("")

		const result = parseVerdict(output)

		expect(result.verdict).toBe("pass")
		expect(result.feedback).toBe("Implementation complete.")
	})

	it("extracts verdict from markdown code block", () => {
		const output = [
			"```json\n",
			JSON.stringify(makeVerdict("fail", "Integration test flake.")),
			"\n```\n",
		].join("")

		const result = parseVerdict(output)

		expect(result.verdict).toBe("fail")
		expect(result.feedback).toBe("Integration test flake.")
	})

	it("extracts verdict from pi tool-use output", () => {
		const output = [
			"<tool_use>\n  <name>bash</name>\n  <arguments>{\"cmd\": " +
			JSON.stringify("bun test") + "}</arguments>\n</tool_use>\n\n",
			JSON.stringify(makeVerdict("pass", "All 42 tests pass.")),
		].join("")

		const result = parseVerdict(output)

		expect(result.verdict).toBe("pass")
		expect(result.feedback).toBe("All 42 tests pass.")
	})
})

describe("parseVerdict — edge cases", () => {
	it("handles verdict with null feedback (JSON null)", () => {
		const output = JSON.stringify({ verdict: "pass", feedback: null, artifacts: [] })

		const result = parseVerdict(output)

		expect(result.verdict).toBe("blocked")
	})

	it("handles verdict with non-string artifacts (invalid shape)", () => {
		const output = JSON.stringify({
			verdict: "pass",
			feedback: "ok",
			artifacts: [1, 2, 3],
		})

		const result = parseVerdict(output)

		expect(result.verdict).toBe("blocked")
	})

	it("handles verdict with null artifacts (invalid shape)", () => {
		const output = JSON.stringify({
			verdict: "pass",
			feedback: "ok",
			artifacts: null,
		})

		const result = parseVerdict(output)

		expect(result.verdict).toBe("blocked")
	})

	it("handles verdict with non-object top-level (invalid shape)", () => {
		const result = parseVerdict('"pass"')

		expect(result.verdict).toBe("blocked")
	})

	it("handles verdict with array top-level (invalid shape)", () => {
		const result = parseVerdict('["pass", "fail"]')

		expect(result.verdict).toBe("blocked")
	})

	it("handles deeply nested JSON that is valid but wrong shape", () => {
		const output = JSON.stringify({
			deep: {
				nested: {
					verdict: "pass",
				},
			},
		})

		const result = parseVerdict(output)

		expect(result.verdict).toBe("blocked")
	})

	it("handles verdict with unicode in feedback", () => {
		const output = JSON.stringify({
			verdict: "pass",
			feedback: "Done ✓ — 日本語テスト 🎉",
		})

		const result = parseVerdict(output)

		expect(result.verdict).toBe("pass")
		expect(result.feedback).toBe("Done ✓ — 日本語テスト 🎉")
	})

	it("handles verdict with empty artifacts array", () => {
		const output = JSON.stringify({
			verdict: "pass",
			feedback: "Clean.",
			artifacts: [],
		})

		const result = parseVerdict(output)

		expect(result.verdict).toBe("pass")
		expect(result.artifacts).toEqual([])
	})
})

describe("extractAssistantText", () => {
	const trailer = '{"verdict": "pass", "feedback": "ok", "artifacts": []}'

	it("returns the text parts of the last assistant message in the final agent_end, skipping thinking", () => {
		const stream = [
			'{"type":"turn_start"}',
			'{"type":"agent_end","messages":[{"role":"user","content":[{"type":"text","text":"do it"}]},{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":' + JSON.stringify(trailer) + '}]}]}',
		].join("\n")
		expect(extractAssistantText(stream)).toBe(trailer)
	})

	it("falls back to turn_end.message when there is no agent_end", () => {
		const stream =
			'{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":' + JSON.stringify(trailer) + '}]}}'
		expect(extractAssistantText(stream)).toBe(trailer)
	})

	it("returns empty string when there is no terminal event (killed mid-turn)", () => {
		const stream = [
			'{"type":"turn_start"}',
			'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"partial"}}',
		].join("\n")
		expect(extractAssistantText(stream)).toBe("")
	})

	it("ignores blank and non-JSON lines", () => {
		const stream = [
			"",
			"not json at all",
			'{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"hi"}]}]}',
		].join("\n")
		expect(extractAssistantText(stream)).toBe("hi")
	})

	it("returns empty string for empty input", () => {
		expect(extractAssistantText("")).toBe("")
	})
})
