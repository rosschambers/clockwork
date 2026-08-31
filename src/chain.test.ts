import { describe, it, expect } from "bun:test"
import { buildChain } from "./chain.ts"

describe("buildChain", () => {
	it("chains each item to the previous by index", () => {
		const chain = buildChain([{ title: "A" }, { title: "B" }, { title: "C" }])
		expect(chain[0]!.dependsOnIndex).toBeNull()
		expect(chain[1]!.dependsOnIndex).toBe(0)
		expect(chain[2]!.dependsOnIndex).toBe(1)
	})

	it("carries body and scenario through", () => {
		const chain = buildChain([{ title: "A", body: "do", scenario: "a.yaml" }])
		expect(chain[0]!.body).toBe("do")
		expect(chain[0]!.scenario).toBe("a.yaml")
	})
})
