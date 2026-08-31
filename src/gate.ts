// Pure deliverable-gate predicate. A card with no declared targets is unaffected
// (planning/doc cards return true). Otherwise the diff must touch at least one
// declared target path, else the card claimed code but shipped none of it.
export function targetsSatisfied(changed: string[], targets: string[]): boolean {
	if (targets.length === 0) {
		return true
	}
	const changedSet = new Set(changed)
	return targets.some((t) => changedSet.has(t))
}
