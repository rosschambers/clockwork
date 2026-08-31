// Preload (NODE_OPTIONS=--require) that makes pi's HTTP stack timeout-free.
//
// WHY: the frame-arbiter BUFFERS low-priority responses (settled design — a
// mid-generation preemption becomes a clean 503, not a truncated 200). That
// means pi receives ZERO bytes — not even response headers — until the model
// turn has fully generated. An M2-sized turn (18-24K context, 16-21 tokens/s)
// takes >5 minutes, and undici's dispatcher headersTimeout (300,000ms default,
// set by pi's cli.js at import time) kills the silent wait. pi's own
// httpIdleTimeoutMs setting governs the SDK request timer but does not reliably
// reach the dispatcher the captured fetch implementation actually uses.
//
// WHAT: resolve pi's OWN bundled undici (require("undici") from this file's
// location resolves nothing — must resolve relative to pi's entry script),
// install a no-timeout dispatcher, replace globalThis.fetch with npm-undici's
// fetch BEFORE any module captures the built-in one, and monkey-patch
// setGlobalDispatcher so pi's later configureHttpDispatcher calls can never
// reinstall a finite timeout.
//
// bodyTimeout/headersTimeout: 0 is documented by undici as "disabled".
"use strict";
try {
	const { createRequire } = require("node:module");
	let undici;
	try {
		// process.argv[1] is pi's entry script (.../pi-monorepo/dist/cli.js);
		// resolve the undici copy pi itself uses.
		undici = createRequire(process.argv[1] || __filename)("undici");
	} catch {
		undici = require("undici");
	}
	const realSetGlobalDispatcher = undici.setGlobalDispatcher.bind(undici);
	function forceNoTimeoutDispatcher() {
		const AgentCtor = undici.EnvHttpProxyAgent ?? undici.Agent;
		realSetGlobalDispatcher(new AgentCtor({
			allowH2: false,
			bodyTimeout: 0,
			headersTimeout: 0,
		}));
	}
	// Any later setGlobalDispatcher call (pi's configureHttpDispatcher with its
	// 5-minute default) is replaced with our no-timeout agent.
	undici.setGlobalDispatcher = forceNoTimeoutDispatcher;
	forceNoTimeoutDispatcher();
	// Replace globalThis.fetch with npm-undici's fetch so every consumer
	// (including SDKs that captured fetch early) goes through our dispatcher.
	undici.install?.();
} catch {
	// Best-effort: pi still works, just with its default timeouts.
}
