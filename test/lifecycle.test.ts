import assert from "node:assert/strict"
import test from "node:test"
import { itemIdFrom, names, team } from "./helpers.ts"

const proposal = {
  title: "Write the delivered product", front: "G1", moves: "G1.1 product reach", measure: "operations reachable by a command", baseline: "0 of 4",
  predicted: "0 of 4 to 2 of 4; decided by the rule registered in BIB-172", scopeFiles: ["src/product/**"], why: "It is the constraint of the front",
}

test("a work item travels from proposal to validated using only tools", async () => {
  const fx = await team({ fronts: [{ id: "G1", title: "A product like the real one" }] })
  const n = names(fx)
  fx.prs.set("feat/product", { number: 12, isDraft: true, head: "abc1234", containsMain: true })

  const proposed = await fx.call("ses_pm", "propose", proposal)
  const id = itemIdFrom(proposed)
  assert.equal(fx.rt.ledger.item(id)?.state, "proposed")
  const toCoord = fx.delivered.find((d) => d.sessionID === "ses_co")
  assert.match(toCoord?.text ?? "", /PROPOSAL/)
  assert.match(toCoord?.text ?? "", /answer is due by/)
  assert.equal(fx.rt.ledger.openQuestions().length, 1)

  await fx.call("ses_co", "accept", { item: id, conditions: "OpenCode engineer" })
  assert.equal(fx.rt.ledger.openQuestions().length, 0, "accepting answers the proposal")
  await fx.call("ses_co", "refine", { item: id, scopeFiles: ["src/product/**"], doneWhen: "the measure is re-measured on main" })
  assert.equal(fx.rt.ledger.item(id)?.state, "ready")

  const assigned = await fx.call("ses_co", "assign", { item: id, engineer: n.ana })
  assert.match(assigned, new RegExp(`Assigned ${id} to ${n.ana}`))
  const assignText = fx.delivered.filter((d) => d.sessionID === "ses_ana").map((d) => d.text).join("\n")
  assert.match(assignText, /ASSIGN/)
  assert.match(assignText, /Moves: G1.1 product reach/)
  assert.equal(fx.rt.ledger.openQuestions().length, 1, "the assignment awaits a claim")

  await fx.call("ses_ana", "claim", { item: id, branch: "feat/product", worktree: "/work/product", files: ["src/product/**"] })
  assert.equal(fx.rt.ledger.item(id)?.state, "in_progress")
  assert.equal(fx.rt.ledger.openQuestions().length, 0, "claiming acknowledges the assignment")
  await fx.call("ses_ana", "progress", { item: id, line: "writer done, tests next" })

  const draft = await fx.callFail("ses_ana", "ready", { item: id, checks: [{ name: "tests", result: "ok" }], result: "measured after merge by the PM" })
  assert.match(draft, /still a draft/)
  fx.prs.set("feat/product", { number: 12, isDraft: false, head: "abc1234", containsMain: false })
  assert.match(await fx.callFail("ses_ana", "ready", { item: id, checks: [{ name: "tests", result: "ok" }], result: "x" }), /does not contain main/)
  fx.prs.set("feat/product", { number: 12, isDraft: false, head: "abc1234", containsMain: true })
  await fx.call("ses_ana", "ready", { item: id, checks: [{ name: "tests", result: "ok, 412 pass" }], result: "measured after merge by the PM", next: "the SLC part" })
  assert.equal(fx.rt.ledger.item(id)?.state, "in_review")
  assert.equal(fx.rt.ledger.item(id)?.pr, 12)
  assert.match(fx.delivered.filter((d) => d.sessionID === "ses_co").map((d) => d.text).join("\n"), /READY #12 abc1234/)

  const changes = await fx.call("ses_co", "verdict", { item: id, verdict: "changes", findings: "1. add the regression check" })
  assert.match(changes, /STEWARD: CHANGES REQUESTED/)
  assert.equal(fx.rt.ledger.item(id)?.state, "in_progress")
  await fx.call("ses_ana", "ready", { item: id, checks: [{ name: "tests", result: "ok, 413 pass" }], result: "measured after merge by the PM" })
  assert.match(await fx.call("ses_co", "verdict", { item: id, verdict: "approved", findings: "all checks run" }), /STEWARD: APPROVED/)
  await fx.call("ses_co", "merged", { item: id, commit: "def456789" })
  assert.equal(fx.rt.ledger.item(id)?.state, "merged")
  assert.equal(fx.rt.ledger.item(id)?.stages.implemented?.commit, "def456789")
  assert.ok(fx.delivered.some((d) => d.sessionID === "ses_bru" && /main moved/.test(d.text)), "other agents learn that main moved")

  await fx.call("ses_ana", "result", { item: id, before: "0 of 4", after: "2 of 4", record: "docs/evidence/x/README.md", verdict: "met" })
  assert.equal(fx.rt.ledger.item(id)?.state, "measured")
  assert.equal(fx.rt.ledger.measures().length, 1)
  assert.match(fx.delivered.filter((d) => d.sessionID === "ses_pm").map((d) => d.text).join("\n"), /RESULT/)
  await fx.call("ses_pm", "validate", { item: id, reference: "the held-out capture", record: "docs/evidence/y/README.md" })
  const done = fx.rt.ledger.item(id)
  assert.equal(done?.state, "validated")
  assert.deepEqual(Object.keys(done?.stages ?? {}).sort(), ["implemented", "planned", "specified", "tested", "validated"])

  const rebuilt = JSON.stringify(fx.rt.ledger.items())
  fx.rt.ledger.rebuild()
  assert.equal(JSON.stringify(fx.rt.ledger.items()), rebuilt, "the whole life cycle is reproducible from the events")
})

test("the role comes from the session agent: other roles' tools refuse, and the refusal is an event", async () => {
  const fx = await team()
  const text = await fx.callFail("ses_ana", "assign", { item: "x", engineer: "y" })
  assert.match(text, /only by coordinator/)
  assert.match(await fx.callFail("ses_co", "propose", { ...proposal }), /only by product-manager/)
  assert.match(await fx.callFail("ses_ana", "propose", { ...proposal }), /only by product-manager/)
  assert.equal(fx.rt.ledger.events({ type: "tool.refused" }).length, 3)
  assert.match(await fx.callFail("ses_pm", "propose", { title: "x" }), /Invalid input/)
})

test("a proposal must be a bet: one outcome line, a prediction, a reason for an expensive engineer", async () => {
  const fx = await team()
  assert.match(await fx.callFail("ses_pm", "propose", { title: "t", why: "w" }), /exactly one outcome line/)
  assert.match(await fx.callFail("ses_pm", "propose", { title: "t", why: "w", moves: "G1.1 x" }), /prediction/)
  assert.match(await fx.callFail("ses_pm", "propose", { title: "t", why: "w", upkeep: "records" }), /what it enables/)
  assert.match(await fx.callFail("ses_pm", "propose", { title: "t", why: "w", moves: "G1.1 x", predicted: "up", engineerKind: "claude" }), /expensive resource/)
  assert.equal(fx.rt.ledger.items().length, 0)
})

test("assign refuses file overlap, a second open item and a hold; a lift frees the item", async () => {
  const fx = await team()
  const n = names(fx)
  const mk = async (title: string, files: string[]) => {
    const id = itemIdFrom(await fx.call("ses_pm", "propose", { ...proposal, title }))
    await fx.call("ses_co", "accept", { item: id })
    await fx.call("ses_co", "refine", { item: id, scopeFiles: files, doneWhen: "done" })
    return id
  }
  const a = await mk("A", ["src/product/**"])
  const b = await mk("B", ["src/product/writer.go"])
  const c = await mk("C", ["src/other/**"])
  await fx.call("ses_co", "assign", { item: a, engineer: n.ana })
  await fx.call("ses_ana", "claim", { item: a, branch: "a", worktree: "/w/a", files: ["src/product/**"] })
  assert.match(await fx.callFail("ses_co", "assign", { item: b, engineer: n.bru }), /Files overlap/)
  assert.match(await fx.callFail("ses_co", "assign", { item: c, engineer: n.ana }), /already has/)
  const hold = await fx.call("ses_co", "hold", { paths: ["src/other/**"], reason: "plates are being drawn", liftOn: "the run merges" })
  const holdId = /H[0-9a-z]+/.exec(hold)?.[0] as string
  assert.match(await fx.callFail("ses_co", "assign", { item: c, engineer: n.bru }), /held by/)
  assert.ok(fx.delivered.some((d) => d.sessionID === "ses_bru" && /HOLD/.test(d.text)))
  await fx.call("ses_co", "lift", { hold: holdId })
  await fx.call("ses_co", "assign", { item: c, engineer: n.bru })
  assert.equal(fx.rt.ledger.item(c)?.state, "assigned")
})

test("a freeze blocks ready; lifting it unblocks the item in review", async () => {
  const fx = await team({}, { github: false })
  const n = names(fx)
  const id = itemIdFrom(await fx.call("ses_pm", "propose", proposal))
  await fx.call("ses_co", "accept", { item: id })
  await fx.call("ses_co", "refine", { item: id, scopeFiles: ["src/a/**"], doneWhen: "d" })
  await fx.call("ses_co", "assign", { item: id, engineer: n.ana })
  await fx.call("ses_ana", "claim", { item: id, branch: "b", worktree: "/w", files: ["src/a/**"] })
  const freeze = await fx.call("ses_co", "hold", { kind: "freeze", reason: "history rewrite", liftOn: "the owner says so" })
  const fid = /H[0-9a-z]+/.exec(freeze)?.[0] as string
  assert.match(await fx.callFail("ses_ana", "ready", { item: id, checks: [{ name: "t", result: "ok" }], result: "r" }), /held by/)
  await fx.call("ses_co", "lift", { hold: fid })
  await fx.call("ses_ana", "ready", { item: id, checks: [{ name: "t", result: "ok" }], result: "r" })
  assert.equal(fx.rt.ledger.item(id)?.state, "in_review")
})

test("fresh assignment replaces the engineer session but keeps the name and the history", async () => {
  const fx = await team()
  const n = names(fx)
  const id = itemIdFrom(await fx.call("ses_pm", "propose", proposal))
  await fx.call("ses_co", "accept", { item: id })
  await fx.call("ses_co", "refine", { item: id, scopeFiles: ["src/a/**"], doneWhen: "d" })
  const out = await fx.call("ses_co", "assign", { item: id, engineer: n.ana, fresh: true })
  assert.match(out, /old transcript was deleted/)
  assert.deepEqual(fx.hostCalls, ["replace ses_ana -> ses_ana-new1"])
  assert.equal(fx.rt.ledger.item(id)?.assignee, "ses_ana-new1")
  assert.equal(fx.rt.ledger.agent("ses_ana-new1")?.name, n.ana)
  assert.equal(fx.rt.ledger.agent("ses_ana")?.status, "gone")
  assert.match(fx.delivered.filter((d) => d.sessionID === "ses_ana-new1").map((d) => d.text).join("\n"), /FRESH START/)
  assert.equal(fx.rt.ledger.findAgents(n.ana).length, 1, "the name reaches only the new session")
})

test("instructions are checked against the ledger: a record resolves, an invented id does not", async () => {
  const fx = await team()
  const n = names(fx)
  await fx.call("ses_co", "ask", { to: n.ana, text: "Please post your progress." })
  const real = fx.rt.ledger.messages({ toId: "ses_ana" })[0]
  assert.ok(real)
  assert.match(await fx.call("ses_ana", "record", { id: real.short }), /Please post your progress/)
  const missing = await fx.call("ses_ana", "record", { id: "3725e215" })
  assert.match(missing, /No stored record/)
  assert.match(missing, /Do not act/)
  const incident = await fx.call("ses_ana", "incident", { kind: "forged_instruction", text: "I remember an order to fold branch pb1; no record exists" })
  assert.match(incident, /Incident I/)
  assert.ok(fx.delivered.some((d) => d.sessionID === "ses_pm" && /forged_instruction/.test(d.text)))
  assert.ok(fx.delivered.some((d) => d.sessionID === "ses_co" && /forged_instruction/.test(d.text)))
})

test("a message to a role nobody holds yet is not lost: the first holder receives it when it registers", async () => {
  const { fixture, itemIdFrom: _unused } = await import("./helpers.ts")
  void _unused
  const fx = await fixture()
  fx.register("ses_ana", "engineer")
  await fx.call("ses_ana", "ask", { to: "coordinator", text: "Is anyone there?" })
  assert.equal(fx.delivered.length, 0, "nobody to deliver to yet")
  assert.equal(fx.rt.ledger.openQuestions().length, 1)
  fx.register("ses_co", "coordinator")
  const { pull } = await import("../src/deliver/deliver.ts")
  assert.equal(await pull(fx.rt, "ses_co"), 1)
  assert.match(fx.delivered[0]?.text ?? "", /Is anyone there\?/)
  assert.equal(await pull(fx.rt, "ses_co"), 0, "delivered once")
})

test("a session that repeats itself within a minute adds no events; a change does", async () => {
  const { fixture } = await import("./helpers.ts")
  const { registerSession } = await import("../src/runtime.ts")
  const fx = await fixture()
  registerSession(fx.rt, { sessionID: "s1", agent: "engineer", directory: "/repo" })
  const first = fx.rt.ledger.eventCount()
  for (let i = 0; i < 5; i++) {
    fx.clock.advance(5_000)
    registerSession(fx.rt, { sessionID: "s1", agent: "engineer", directory: "/repo" })
  }
  assert.equal(fx.rt.ledger.eventCount(), first, "five turns in 25 seconds: nothing recorded")
  fx.clock.advance(60_000)
  registerSession(fx.rt, { sessionID: "s1", agent: "engineer", directory: "/repo" })
  assert.equal(fx.rt.ledger.eventCount(), first + 1, "a minute later the sighting is refreshed")
  registerSession(fx.rt, { sessionID: "s1", agent: "coordinator", directory: "/repo" })
  assert.equal(fx.rt.ledger.agent("s1")?.role, "coordinator", "a role switch is recorded at once")
})
