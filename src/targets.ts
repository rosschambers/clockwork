// Extract the file paths a card declares as its deliverable. Two accepted forms:
//   targets: a/b.gd, c.gd
//   Only main.gd (the existing card-body convention)
// Returns [] when the card declares nothing (a planning/doc card).
export function parseTargets(body: string): string[] {
	const explicit = body.match(/^\s*targets:\s*(.+)$/im)
	if (explicit && explicit[1]) {
		return splitPaths(explicit[1])
	}
	// Stop at a sentence-ending period (one followed by whitespace or end of
	// input) or a newline — but not at the dot inside a filename like main.gd.
	const only = body.match(/\bOnly\s+(.+?)(?:\.(?=\s|$)|\n|$)/i)
	if (only && only[1]) {
		return splitPaths(only[1])
	}
	return []
}

// A token looks like a file path if it contains a slash or has a recognized
// file extension. Rejects natural-English words ("when", "true;", "for") that
// leak in when the "Only" heuristic matches mid-sentence prose.
const FILE_PATH_RE = /\/|\.(?:gd|ts|js|json|tscn|tres|cfg|md|txt|yaml|yml|toml|csv|godot|sh|html|css|svg)$/i

function looksLikeFilePath(token: string): boolean {
	return FILE_PATH_RE.test(token)
}

function splitPaths(raw: string): string[] {
	return raw
		.split(/[,\s]+/)
		.map((p) => p.trim())
		.filter((p) => p !== "" && p.toLowerCase() !== "should" && p.toLowerCase() !== "change")
		.filter(looksLikeFilePath)
}
