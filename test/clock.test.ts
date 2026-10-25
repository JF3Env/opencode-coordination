import assert from "node:assert/strict"
import test from "node:test"
import { tick } from "../src/clock/clock.ts"
import { itemIdFrom, names, team } from "./helpers.ts"

const BLOCK = 60 * 60_000

test("a question gets a reminder after one block and an escalation after two, with nobody counting", async () => {
  const fx = await team()
  const n = names(fx)
  await fx.call("ses_ana", "ask", { to: "coordinator", text: "Which of the two layouts do you want?" })
  const q = fx.rt.ledger.openQuestions()[0]
  assert.ok(q)
  assert.deepEqual((await tick(fx.rt)).reminded, [])
  fx.clock.advance(BLOCK)
  const first = await tick(fx.rt)
  assert.deepEqual(first.reminded, [q.short])
  assert.match(fx.delivered.filter((d) => d.sessionID === "ses_co").map((d) => d.text).join("\n"), /\(resent\) Which of the two layouts/)
  assert.match(fx.delivered.filter((d) => d.sessionID === "ses_ana").map((d) => d.text).join("\n"), /was sent again/)
  assert.deepEqual((await tick(fx.rt)).reminded, [], "one reminder only")
  fx.clock.advance(BLOCK)
  const second = await tick(fx.rt)
  assert.deepEqual(second.escalated, [q.short])
  assert.match(fx.delivered.filter((d) => d.sessionID === "ses_pm").map((d) => d.text).join("\n"), /ESCALATED/)
  assert.equal(fx.rt.ledger.message(q.id)?.escalated, true)
  // answering closes it for good
  await fx.call("ses_co", "answer", { message: q.short, text: "The second." })
  fx.clock.advance(3 * BLOCK)
  const later = await tick(fx.rt)
  assert.deepEqual([later.reminded, later.escalated], [[], []])
  assert.ok(n.co)
})

test("an assignment nobody claims, and an item with no event for two blocks, reach the coordinator and the PM", async () => {
  const fx = await team()
  const n = names(fx)
  const id = itemIdFrom(await fx.call("ses_pm", "propose", { title: "T", moves: "G1 x", predicted: "up", why: "w", scopeFiles: ["a/**"] }))
  await fx.call("ses_co", "accept", { item: id })
  await fx.call("ses_co", "refine", { item: id, scopeFiles: ["a/**"], doneWhen: "d" })
  await fx.call("ses_co", "assign", { item: id, engineer: n.ana })
  fx.clock.advance(BLOCK)
  const a = await tick(fx.rt)
  assert.deepEqual(a.unclaimed, [id])
  assert.deepEqual((await tick(fx.rt)).unclaimed, [], "reported once")
  await fx.call("ses_ana", "claim", { item: id, branch: "b", worktree: "/w", files: ["a/**"] })
  fx.clock.advance(BLOCK)
  assert.deepEqual((await tick(fx.rt)).quiet, [id], "no progress line for a block")
  fx.clock.advance(2 * BLOCK)
  const c = await tick(fx.rt)
  assert.deepEqual(c.stalled, [id])
  const stall = (sid: string) => fx.delivered.filter((d) => d.sessionID === sid && /STALL/.test(d.text)).length
  assert.equal(stall("ses_co"), 1)
  assert.equal(stall("ses_pm"), 1)
})

test("a parked front draws no stall alert", async () => {
  const fx = await team()
  const n = names(fx)
  const id = itemIdFrom(await fx.call("ses_pm", "propose", { title: "T", front: "G2", moves: "G2 x", predicted: "up", why: "w", scopeFiles: ["a/**"] }))
  await fx.call("ses_co", "accept", { item: id })
  await fx.call("ses_co", "refine", { item: id, scopeFiles: ["a/**"], doneWhen: "d" })
  await fx.call("ses_co", "assign", { item: id, engineer: n.ana })
  await fx.call("ses_ana", "claim", { item: id, branch: "b", worktree: "/w", files: ["a/**"] })
  await fx.call("ses_pm", "park", { front: "G2", reason: "waits for a new capture", unparkOn: "the catalogue changes" })
  fx.clock.advance(5 * BLOCK)
  assert.deepEqual((await tick(fx.rt)).stalled, [])
})

test("a session the host no longer lists goes gone and its item returns to the queue with branch and PR kept", async () => {
  const fx = await team()
  const n = names(fx)
  const id = itemIdFrom(await fx.call("ses_pm", "propose", { title: "T", moves: "G1 x", predicted: "up", why: "w", scopeFiles: ["a/**"] }))
  await fx.call("ses_co", "accept", { item: id })
  await fx.call("ses_co", "refine", { item: id, scopeFiles: ["a/**"], doneWhen: "d" })
  await fx.call("ses_co", "assign", { item: id, engineer: n.ana })
  await fx.call("ses_ana", "claim", { item: id, branch: "feat/t", worktree: "/w", files: ["a/**"] })
  fx.sessions.delete("ses_ana")
  fx.clock.advance(31 * 60_000)
  const r = await tick(fx.rt)
  assert.deepEqual(r.gone, [n.ana])
  const item = fx.rt.ledger.item(id)
  assert.equal(item?.state, "ready")
  assert.equal(item?.assignee, undefined)
  assert.equal(item?.branch, "feat/t")
  assert.equal(fx.rt.ledger.agent("ses_ana")?.status, "gone")
  assert.match(fx.delivered.filter((d) => d.sessionID === "ses_co").map((d) => d.text).join("\n"), /is gone\. Orphaned/)
  // a second engineer can take the branch over
  await fx.call("ses_co", "reassign", { item: id, engineer: n.bru })
  assert.match(fx.delivered.filter((d) => d.sessionID === "ses_bru").map((d) => d.text).join("\n"), /Take over branch feat\/t/)
})

test("the state digest goes to the product manager once per block", async () => {
  const fx = await team()
  fx.clock.advance(BLOCK)
  assert.equal((await tick(fx.rt)).digest, true)
  assert.equal((await tick(fx.rt)).digest, false)
  const digests = fx.delivered.filter((d) => d.sessionID === "ses_pm" && /^\[coordination\] NOTE[^\n]*\n\nSTATE /.test(d.text))
  assert.equal(digests.length, 1)
  fx.clock.advance(BLOCK)
  assert.equal((await tick(fx.rt)).digest, true)
})
