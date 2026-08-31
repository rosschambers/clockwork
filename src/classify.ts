export type ParkReason =
	| "scope-mismatch"
	| "deliverable-missing"
	| "dependency"
	| "genuine-failure"
	| "preemption-exhausted"
	| "sync-diverged"

// Deterministic keyword classification of a parked card's last feedback. Machinery
// stays dumb: no model call, just a fixed mapping the director can rely on.
export function classifyParkReason(feedback: string): ParkReason {
	const f = feedback.toLowerCase()
	if (f.includes("deliverable") || f.includes("not changed")) {
		return "deliverable-missing"
	}
	if (f.includes("depend") || f.includes("prerequisite")) {
		return "dependency"
	}
	if (f.includes("scope") || f.includes("too big") || f.includes("re-scope")) {
		return "scope-mismatch"
	}
	if (f.includes("preempt")) {
		return "preemption-exhausted"
	}
	if (f.includes("diverg") || f.includes("sync")) {
		return "sync-diverged"
	}
	return "genuine-failure"
}

// Director-action set surfaced with a parked card, keyed by its classified reason.
// Lives beside ParkReason (DRY) so the ws layer and any board/SMS surface share it.
export const SUGGESTED_ACTIONS: Record<ParkReason, string[]> = {
	"scope-mismatch": ["reScopeCard", "requeueCard"],
	"deliverable-missing": ["requeueCard", "reScopeCard", "abandonCard"],
	"dependency": ["setCardDependsOn", "requeueCard"],
	"genuine-failure": ["reScopeCard", "abandonCard", "resetRetry"],
	"preemption-exhausted": ["resetRetry", "requeueCard"],
	"sync-diverged": ["reconcileSync", "requeueCard"],
}
