import assert from "node:assert/strict"
import test from "node:test"
import { pull } from "../src/deliver/deliver.ts"
import { SYSTEM_ACTOR } from "../src/domain/system.ts"
import { post, registerSession, type Registration } from "../src/runtime.ts"
import { fixture } from "./helpers.ts"

test("automatic delivery leaves messages pending for unknown, ordinary, child and non-OpenCode sessions", async (t) => {
  const fx = await fixture()
  t.after(() => fx.rt.ledger.close())
  const cases: Array<{ sessionID: string; registration?: Partial<Registration> }> = [
    { sessionID: "unknown" },
    { sessionID: "helper", registration: { agent: "build" } },
    { sessionID: "child", registration: { agent: "coordinator", parent: "ses_co" } },
    { sessionID: "cli", registration: { agent: "engineer", kind: "cli" } },
    { sessionID: "claude", registration: { agent: "engineer", kind: "claude" } },
  ]
  for (const { sessionID, registration } of cases) {
    if (registration) registerSession(fx.rt, { sessionID, agent: "", directory: "/repo", ...registration })
    const message = post(fx.rt, {
      from: { kind: "system", id: "system", name: "coordination" },
      to: { kind: "opencode", id: sessionID, name: sessionID },
      kind: "note", text: `Message for ${sessionID}`, actor: SYSTEM_ACTOR,
    })
    assert.equal(await pull(fx.rt, sessionID), 0, sessionID)
    assert.equal(fx.rt.ledger.pendingCount([sessionID]), 1, sessionID)
    assert.equal(fx.rt.ledger.message(message.id)?.delivered, false, sessionID)
    assert.deepEqual(fx.rt.ledger.claimPending(sessionID, fx.rt.now()).map((m) => m.id), [message.id], sessionID)
  }
  assert.deepEqual(fx.delivered, [])
  assert.equal(fx.rt.ledger.events({ type: "message.delivered" }).length, 0)
})

test("automatic delivery sends each role session its pending message exactly once", async (t) => {
  const fx = await fixture()
  t.after(() => fx.rt.ledger.close())
  for (const role of ["coordinator", "product-manager", "engineer"]) {
    fx.register(role, role)
    post(fx.rt, {
      from: { kind: "system", id: "system", name: "coordination" },
      to: { kind: "opencode", id: role, name: role },
      kind: "note", text: `Message for ${role}`, actor: SYSTEM_ACTOR,
    })
    assert.equal(await pull(fx.rt, role), 1, role)
    assert.equal(await pull(fx.rt, role), 0, role)
    assert.equal(fx.rt.ledger.pendingCount([role]), 0, role)
    assert.equal(fx.delivered.filter((m) => m.sessionID === role).length, 1, role)
  }
})
