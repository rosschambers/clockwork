import fs from "node:fs"
import path from "node:path"

export interface ContextAssemblerOptions {
	projectRoot: string
	projectMdPath?: string
	planFiles: PlanSlice[]
	cardThread: ThreadEntry[]
	columnExtras: string
	tokenBudget?: number
	maxThreadEntries?: number
	cardId?: string
}

export interface PlanSlice {
	id: string
	title: string
	content: string
	relevantCardIds: string[]
}

export interface ThreadEntry {
	id: string
	entryType: "feedback" | "verdict" | "note"
	timestamp: number
	content: string
}

export interface AssembledContext {
	systemPrompt: string
	tokenCount: number
	truncated: boolean
}

const DEFAULT_TOKEN_BUDGET = 64000
const DEFAULT_MAX_THREAD_ENTRIES = 20
const CHARS_PER_TOKEN = 4

function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function readProjectMd(projectRoot: string, projectMdPath?: string): string | null {
	const resolvedPath = projectMdPath
		? projectMdPath.startsWith("/")
			? projectMdPath
			: path.join(projectRoot, projectMdPath)
		: path.join(projectRoot, "PROJECT.md")

	try {
		return fs.readFileSync(resolvedPath, "utf8")
	} catch {
		return null
	}
}

function filterPlanSlices(planFiles: PlanSlice[], cardId?: string): PlanSlice[] {
	if (cardId === undefined) {
		// No card specified: include all plan slices
		return [...planFiles]
	}
	// Filter to slices relevant to this specific card
	// Slices with empty relevantCardIds are globally relevant
	return planFiles.filter((slice) =>
		slice.relevantCardIds.length === 0 || slice.relevantCardIds.includes(cardId)
	)
}

function truncateThreadByMax(
	entries: ThreadEntry[],
	maxEntries: number
): { entries: ThreadEntry[]; truncated: boolean } {
	const allSorted = [...entries].sort((a, b) => a.timestamp - b.timestamp)

	if (allSorted.length <= maxEntries) {
		return { entries: allSorted, truncated: false }
	}

	// Keep newest entries (highest timestamps), drop oldest
	const newestFirst = allSorted.reverse()
	const kept = newestFirst.slice(0, maxEntries)
	// Return in chronological order (oldest first)
	const chronological = kept.reverse()
	return { entries: chronological, truncated: true }
}

function formatThreadEntry(entry: ThreadEntry): string {
	return `  - [${entry.entryType}] ${entry.content}\n`
}

function formatPlanSlices(slices: PlanSlice[]): string {
	if (slices.length === 0) {
		return ""
	}

	return slices
		.map((slice) => `### ${slice.title}\n\n${slice.content}`)
		.join("\n\n")
}

function formatThread(entries: ThreadEntry[]): string {
	if (entries.length === 0) {
		return ""
	}

	return entries.map(formatThreadEntry).join("")
}

function assembleProjectSection(projectMdContent: string | null): string {
	if (projectMdContent) {
		return `## Project\n\n${projectMdContent}`
	}
	return "## Project\n\nNo PROJECT.md found in the project root."
}

function truncateThreadByBudget(
	entries: ThreadEntry[],
	budget: number
): { entries: ThreadEntry[]; truncated: boolean } {
	if (entries.length === 0) {
		return { entries: [], truncated: false }
	}

	// Keep newest entries that fit within budget. Sort descending, accumulate, then reverse.
	const sorted = [...entries].sort((a, b) => b.timestamp - a.timestamp)

	let kept: ThreadEntry[] = []
	let currentLength = 0
	let truncated = false

	for (const entry of sorted) {
		const entryText = formatThreadEntry(entry)
		if (currentLength + entryText.length <= budget) {
			kept.push(entry)
			currentLength += entryText.length
		} else {
			truncated = true
			break
		}
	}

	// Return in chronological order (oldest first)
	return { entries: kept.reverse(), truncated }
}

function truncatePlanSlices(
	slices: PlanSlice[],
	budget: number
): { slices: PlanSlice[]; truncated: boolean } {
	if (slices.length === 0) {
		return { slices: [], truncated: false }
	}

	let currentLength = 0
	let truncated = false

	const result = slices.map((s) => ({ ...s }))

	for (let i = 0; i < result.length; i++) {
		const slice = result[i]
		if (slice === undefined) {
			continue
		}
		const header = `### ${slice.title}\n\n`
		const separator = i > 0 ? "\n\n" : ""
		const overhead = separator.length + header.length

		if (currentLength + overhead + slice.content.length <= budget) {
			currentLength += overhead + slice.content.length
		} else {
			truncated = true
			const available = budget - currentLength - overhead

			if (available > 40) {
				slice.content = `${slice.content.slice(0, available - 40)}\n\n[Plan truncated due to token budget]`
			} else {
				slice.content = "[Plan truncated — no budget remaining]"
			}
			currentLength += overhead + slice.content.length

			for (let j = i + 1; j < result.length; j++) {
				const later = result[j]
				if (later !== undefined) {
					later.content = "[Plan truncated — no budget remaining]"
				}
			}
			break
		}
	}

	return { slices: result, truncated }
}

export class ContextAssembler {
	constructor(private readonly options: ContextAssemblerOptions) {}

	assemble(): AssembledContext {
		const {
			projectRoot,
			projectMdPath,
			planFiles,
			cardThread,
			columnExtras,
			tokenBudget,
			maxThreadEntries,
			cardId,
		} = this.options

		const budget = tokenBudget ?? DEFAULT_TOKEN_BUDGET
		const maxEntries = maxThreadEntries ?? DEFAULT_MAX_THREAD_ENTRIES
		const charBudget = budget * CHARS_PER_TOKEN

		let truncated = false

		// Step 1: PROJECT.md (never truncated)
		const projectMdContent = readProjectMd(projectRoot, projectMdPath)
		const projectSection = assembleProjectSection(projectMdContent)

		// Step 2: Filter plan slices by cardId
		const relevantSlices = filterPlanSlices(planFiles, cardId)

		// Step 3: Limit thread by maxEntries (chronological order)
		const { entries: limitedThread, truncated: maxTruncated } = truncateThreadByMax(
			cardThread,
			maxEntries
		)
		if (maxTruncated) {
			truncated = true
		}

		// Build initial assembly
		let assembled = projectSection

		if (relevantSlices.length > 0) {
			assembled += `\n\n## Plan\n\n${formatPlanSlices(relevantSlices)}`
		}

		if (limitedThread.length > 0) {
			assembled += `\n\n## Card Thread\n\n${formatThread(limitedThread)}`
		}

		if (columnExtras) {
			assembled += `\n\n## Column Extras\n\n${columnExtras}`
		}

		// Enforce token budget if over
		if (assembled.length > charBudget) {
			const projectLength = projectSection.length

			if (projectLength >= charBudget) {
				return {
					systemPrompt: projectSection,
					tokenCount: estimateTokens(projectSection),
					truncated: true,
				}
			}

			const remainingAfterProject = charBudget - projectLength

			// Truncate thread first (drop oldest entries)
			const { entries: budgetThread, truncated: threadTruncated } = truncateThreadByBudget(
				limitedThread,
				remainingAfterProject
			)
			if (threadTruncated) {
				truncated = true
			}

			// Calculate remaining budget after thread
			const threadText = budgetThread.length > 0 ? formatThread(budgetThread) : ""
			const threadSectionLength = budgetThread.length > 0
				? `\n\n## Card Thread\n\n${threadText}`.length
				: 0

			const remainingAfterThread = remainingAfterProject - threadSectionLength

			// Truncate plan if needed
			let planBudget = 0
			let planContent: PlanSlice[] = []
			let planSectionLength = 0

			if (relevantSlices.length > 0) {
				const planHeaderLength = `\n\n## Plan\n\n`.length
				planBudget = Math.max(remainingAfterThread - planHeaderLength, 0)

				if (planBudget <= 10) {
					truncated = true
				} else {
					const { slices: truncatedSlices, truncated: planTruncated } = truncatePlanSlices(
						relevantSlices,
						planBudget
					)
					if (planTruncated) {
						truncated = true
					}
					planContent = truncatedSlices
					planSectionLength = planHeaderLength + formatPlanSlices(truncatedSlices).length
				}
			}

			// Reassemble with truncated content
			assembled = projectSection

			if (planContent.length > 0) {
				assembled += `\n\n## Plan\n\n${formatPlanSlices(planContent)}`
			}

			if (budgetThread.length > 0) {
				assembled += `\n\n## Card Thread\n\n${formatThread(budgetThread)}`
			}

			// Column extras only if space remains
			if (columnExtras && assembled.length < charBudget) {
				const extrasSection = `\n\n## Column Extras\n\n${columnExtras}`
				if (assembled.length + extrasSection.length <= charBudget) {
					assembled += extrasSection
				} else {
					const remaining = charBudget - assembled.length
					const header = `\n\n## Column Extras\n\n`
					if (remaining > header.length + 10) {
						const trimmedExtras = columnExtras.slice(0, remaining - header.length)
						assembled += `${header}${trimmedExtras}\n\n[Column extras truncated]`
						truncated = true
					}
				}
			}

			// Final safety: hard truncate if still over (never touch PROJECT.md)
			if (assembled.length > charBudget) {
				assembled = assembled.slice(0, charBudget) + "\n\n[Context truncated]"
				truncated = true
			}
		}

		return {
			systemPrompt: assembled,
			tokenCount: estimateTokens(assembled),
			truncated,
		}
	}
}

export function assembleContext(options: ContextAssemblerOptions): AssembledContext {
	const assembler = new ContextAssembler(options)
	return assembler.assemble()
}
