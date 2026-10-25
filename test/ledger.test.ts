import assert from "node:assert/strict"
import test from "node:test"
import { Ledger } from "../src/ledger/ledger.ts"
import type { Actor } from "../src/domain/types.ts"

const pm: Actor = { session: "ses_pm", name: "Wilken", role: "product-manager" }
const coord: Actor = { session: "ses_co", name: "Isabel", role: "coordinator" }

async function ledger() {
  return Ledger.open(":memory:", "/repo/.git")
}

test("events are append-only: UPDATE and DELETE are refused by the database", async () => {
  const l = await ledger()
  l.append({ type: "agent.seen", actor: pm, payload: { sessionID: "ses_pm", role: "product-manager", directory: "/repo" } })
  assert.throws(() => l.db.run("UPDATE events SET type = 'x'"), /append-only/)
  assert.throws(() => l.db.run("DELETE FROM events"), /append-only/)
  assert.equal(l.eventCount(), 1)
})

test("appendMany is atomic: a failing event leaves nothing behind", async () => {
  const l = await ledger()
  assert.throws(() =>
    l.appendMany([
      { type: "agent.seen", actor: pm, payload: { sessionID: "a", role: "other", directory: "/" } },
      { type: "agent.seen", actor: { ...pm, name: undefined as unknown as string }, payload: {} },
    ]),
  )
  assert.equal(l.eventCount(), 0)
  assert.equal(l.agents().length, 0)
})

test("projections are a pure function of the events: rebuild reproduces them", async () => {
  const l = await ledger()
  l.append({ type: "agent.seen", actor: coord, payload: { sessionID: "ses_co", role: "coordinator", directory: "/repo", agent: "coordinator" } })
  l.append({ type: "agent.named", actor: coord, payload: { sessionID: "ses_co", name: "Isabel" } })
  const id = l.newId("W", "items")
  l.append({ type: "item.proposed", actor: pm, subject: id, payload: { id, title: "A", kind: "feature", outcome: { moves: "G1.1 x" } } })
  l.append({ type: "item.accepted", actor: coord, subject: id, payload: { id } })
  const before = JSON.stringify({ items: l.items(), agents: l.agents() })
  const replayed = l.rebuild()
  assert.equal(replayed, 4)
  assert.equal(JSON.stringify({ items: l.items(), agents: l.agents() }), before)
  assert.equal(l.item(id)?.state, "accepted")
  assert.ok(l.item(id)?.stages.planned)
})

test("event ids stay unique and ordered when many events share a millisecond", async () => {
  const l = await ledger()
  const at = "2026-10-25T10:00:00.000Z"
  const ids = Array.from({ length: 30 }, () => l.append({ type: "note", actor: pm, at }).id)
  assert.equal(new Set(ids).size, 30)
  assert.deepEqual([...ids].sort(), ids)
})

test("message short ids resolve, and ambiguity is reported instead of guessed", async () => {
  const l = await ledger()
  const send = (id: string) =>
    l.append({
      type: "message.sent", actor: pm,
      payload: { id, kind: "ask", from: { kind: "opencode", id: "a", name: "A" }, to: { kind: "opencode", id: "b", name: "B" }, text: "hi", transport: "opencode" },
    })
  send("abcdef0123456789")
  send("abcdef0199999999")
  send("1234567890abcdef")
  const one = l.resolveMessage("12345678")
  assert.ok("found" in one && one.found.id === "1234567890abcdef")
  const many = l.resolveMessage("abcdef01")
  assert.ok("ambiguous" in many && many.ambiguous.length === 2)
  assert.deepEqual(l.resolveMessage("zzzzzzzz"), { missing: true })
  assert.deepEqual(l.resolveMessage("abc"), { missing: true })
})

test("claimPending reserves a message so two passes never deliver it twice", async () => {
  const l = await ledger()
  l.append({
    type: "message.sent", actor: pm,
    payload: { id: "00000000deadbeef", kind: "note", from: { kind: "opencode", id: "a", name: "A" }, to: { kind: "opencode", id: "b", name: "B" }, text: "x", transport: "opencode" },
  })
  const now = new Date("2026-10-25T10:00:00Z")
  assert.equal(l.claimPending("b", now).length, 1)
  assert.equal(l.claimPending("b", now).length, 0)
  assert.equal(l.claimPending("b", new Date(now.getTime() + 31_000)).length, 1)
  l.append({ type: "message.delivered", actor: pm, payload: { id: "00000000deadbeef" } })
  assert.equal(l.claimPending("b", new Date(now.getTime() + 120_000)).length, 0)
})
