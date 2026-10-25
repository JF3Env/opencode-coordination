// Runs the ledger on bun:sqlite, the runtime OpenCode uses. Run: bun scripts/bun-smoke.ts
import assert from "node:assert/strict"
import { Ledger } from "../src/ledger/ledger.ts"
import { ALL_TOOLS, callTool, toolByName } from "../src/tools/index.ts"
import { actorFor, registerSession, type Runtime } from "../src/runtime.ts"
import { defaultProfile } from "../src/config/profile.ts"

assert.ok((globalThis as { Bun?: unknown }).Bun, "run this with bun")
const ledger = await Ledger.open(":memory:", "/repo/.git")
const rt: Runtime = { ledger, profile: defaultProfile(), now: () => ledger.now() }
registerSession(rt, { sessionID: "pm", agent: "product-manager", directory: "/repo" })
registerSession(rt, { sessionID: "co", agent: "coordinator", directory: "/repo" })
const out = await callTool(rt, toolByName("propose")!, actorFor(rt, "pm"), { title: "Smoke", moves: "G1 x", predicted: "up", why: "w" })
assert.match(out, /Proposed W/)
assert.throws(() => ledger.db.run("DELETE FROM events"), /append-only/)
const before = JSON.stringify(ledger.items())
ledger.rebuild()
assert.equal(JSON.stringify(ledger.items()), before)
assert.ok(ALL_TOOLS.length > 40)
console.log(`bun ${Bun.version}: ${ledger.eventCount()} events, rebuild identical, append-only enforced`)
