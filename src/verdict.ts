export interface Verdict {
	verdict: "pass" | "fail" | "blocked"
	feedback: string
	artifacts: string[]
}

type VerdictKind = "pass" | "fail" | "blocked"
const VALID_VERDICTS = new Set<VerdictKind>(["pass", "fail", "blocked"])

function isVerdictKind(value: unknown): value is VerdictKind {
	return typeof value === "string" && VALID_VERDICTS.has(value as VerdictKind)
}

function findLastJsonBracket(output: string): { json: string; start: number } | null {
	let depth = 0
	let lastOpen = -1
	let inString = false
	let escape = false

	for (let i = output.length - 1; i >= 0; i--) {
		const ch = output[i]

		if (inString) {
			if (escape) {
				escape = false
			} else if (ch === "\\") {
				escape = true
			} else if (ch === "\"") {
				inString = false
			}
			continue
		}

		if (ch === "\"") {
			inString = true
			continue
		}

		if (ch === "}") {
			if (depth === 0) {
				lastOpen = i
			}
			depth++
		} else if (ch === "{") {
			depth--
			if (depth === 0) {
				return { json: output.slice(i, lastOpen + 1), start: i }
			}
		}
	}

	return null
}

function isVerdictShape(obj: unknown): obj is { verdict: string; feedback?: unknown; artifacts?: unknown } {
	if (typeof obj !== "object" || obj === null) {
		return false
	}

	const v = obj as Record<string, unknown>

	if (typeof v.verdict !== "string") {
		return false
	}

	return true
}

function isStringArray(obj: unknown): obj is string[] {
	if (!Array.isArray(obj)) {
		return false
	}
	for (const a of obj) {
		if (typeof a !== "string") {
			return false
		}
	}
	return true
}

function normalizeVerdict(raw: Verdict): Verdict {
	let verdict: "pass" | "fail" | "blocked" = raw.verdict

	if (!VALID_VERDICTS.has(verdict)) {
		verdict = "blocked"
	}

	return {
		verdict,
		feedback: raw.feedback ?? "",
		artifacts: raw.artifacts ?? [],
	}
}

// The feedback strings parseVerdict uses when it could NOT parse a verdict from
// the output (as opposed to the model explicitly declaring blocked). The worker
// uses this to decide whether to run the grammar-constrained extraction fallback.
const PARSE_FAILURE_FEEDBACK = new Set<string>([
	"Empty output",
	"No JSON found in output",
	"Malformed verdict",
])

// True when a verdict is `blocked` ONLY because the output could not be parsed —
// i.e. the model likely did the work but omitted the JSON verdict trailer. This
// is the case the extraction fallback should rescue.
export function isParseFailureVerdict(verdict: Verdict): boolean {
	return verdict.verdict === "blocked" && PARSE_FAILURE_FEEDBACK.has(verdict.feedback)
}

export function parseVerdict(output: string): Verdict {
	const trimmed = output.trim()

	if (trimmed.length === 0) {
		return { verdict: "blocked", feedback: "Empty output", artifacts: [] }
	}

	const found = findLastJsonBracket(trimmed)

	if (found === null) {
		return { verdict: "blocked", feedback: "No JSON found in output", artifacts: [] }
	}

	// Verify the JSON is at the tail — no prose after it
	// Strip trailing markdown code block markers and whitespace
	const afterJson = trimmed.slice(found.start + found.json.length).replace(/\s*```+\s*$/, "").trim()
	if (afterJson.length > 0) {
		return { verdict: "blocked", feedback: "No JSON found in output", artifacts: [] }
	}

	try {
		const parsed = JSON.parse(found.json)

		if (!isVerdictShape(parsed)) {
			return { verdict: "blocked", feedback: "Malformed verdict", artifacts: [] }
		}

		const artifacts = isStringArray(parsed.artifacts) ? parsed.artifacts : undefined
		const feedback = typeof parsed.feedback === "string" ? parsed.feedback : undefined

		if (feedback === undefined && "feedback" in parsed) {
			return { verdict: "blocked", feedback: "Malformed verdict", artifacts: [] }
		}

		if (artifacts === undefined && "artifacts" in parsed) {
			return { verdict: "blocked", feedback: "Malformed verdict", artifacts: [] }
		}

		const verdict: VerdictKind = isVerdictKind(parsed.verdict) ? parsed.verdict : "blocked"
		return {
			verdict,
			feedback: feedback ?? "",
			artifacts: artifacts ?? [],
		}
	} catch {
		return { verdict: "blocked", feedback: "Malformed verdict", artifacts: [] }
	}
}
