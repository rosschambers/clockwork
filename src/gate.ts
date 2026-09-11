// Pure deliverable-gate predicate. A card with no declared targets is unaffected
// (planning/doc cards return true). Otherwise the diff must touch at least one
// declared target — either an exact file path or a DIRECTORY PREFIX (a target
// like "scenarios" matches "scenarios/main.yaml"). Without prefix support, a
// bare directory target never matches any file and the card loops to Needs-Human
// (project-bastion M2-21, 2026-09-10).
export function targetsSatisfied(changed: string[], targets: string[]): boolean {
	if (targets.length === 0) {
		return true
	}
	return targets.some((target) => {
		// Normalize: strip trailing slash for consistent prefix matching.
		const prefix = target.endsWith("/") ? target : target + "/"
		return changed.some((file) =>
			file === target || file.startsWith(prefix)
		)
	})
}
