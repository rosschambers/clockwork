export interface ChainItem {
	title: string
	body?: string
	scenario?: string
}

export interface ChainNode {
	title: string
	body: string
	scenario: string | null
	dependsOnIndex: number | null
}

// Turn an ordered list of plan items into a dependency-ordered chain: each item
// after the first depends on the one before it, so the scheduler runs them in
// order (card N only starts once card N-1 reaches Done). Replaces the throwaway
// queue-render.py hand script with a first-class director command.
export function buildChain(items: ChainItem[]): ChainNode[] {
	return items.map((item, index) => ({
		title: item.title,
		body: item.body ?? "",
		scenario: item.scenario ?? null,
		dependsOnIndex: index === 0 ? null : index - 1,
	}))
}
