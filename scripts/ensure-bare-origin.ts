import fs from "node:fs"

export interface EnsureBareOriginResult {
	ok: boolean
	action: "already-bare" | "converted" | "created"
}

async function run(args: string[]): Promise<{ code: number; stdout: string }> {
	const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" })
	const stdout = proc.stdout ? await new Response(proc.stdout).text() : ""
	const code = await proc.exited
	return { code, stdout: stdout.trim() }
}

export async function ensureBareOrigin(originPath: string): Promise<EnsureBareOriginResult> {
	if (!fs.existsSync(originPath)) {
		await run(["init", "--bare", originPath])
		return { ok: true, action: "created" }
	}
	const isBare = await run(["-C", originPath, "rev-parse", "--is-bare-repository"])
	if (isBare.code === 0 && isBare.stdout === "true") {
		return { ok: true, action: "already-bare" }
	}
	// Existing non-bare origin (cannot be safely recloned in place): the documented
	// fallback lets it accept a push to its checked-out branch without a hand config.
	await run(["-C", originPath, "config", "receive.denyCurrentBranch", "updateInstead"])
	return { ok: true, action: "converted" }
}

if (import.meta.main) {
	const originPath = process.argv[2]
	if (!originPath) {
		console.log("Usage: bun scripts/ensure-bare-origin.ts <origin-path>")
		process.exit(1)
	}
	ensureBareOrigin(originPath).then((r) => {
		console.log(JSON.stringify(r))
	})
}
