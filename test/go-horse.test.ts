import assert from "node:assert/strict"
import test from "node:test"
import { tick } from "../src/clock/clock.ts"
import { GO_HORSE_IDLE_MS, GO_HORSE_QUESTIONS, goHorseMode, setGoHorse, tickGoHorse } from "../src/clock/go-horse.ts"
import { SYSTEM_ACTOR } from "../src/domain/system.ts"
import { buildPrompt } from "../src/prompt/prompt.ts"
import { pull } from "../src/deliver/deliver.ts"
import { actorFor } from "../src/runtime.ts"
import { itemIdFrom, team } from "./helpers.ts"

async function setup() {
  const fx = await team({}, { github: false })
  fx.rt.ledger.append({ type: "agent.status", actor: actorFor(fx.rt, "ses_pm"), payload: { sessionID: "ses_pm", status: "idle" } })
  const enable = (value = true) => setGoHorse(fx.rt, actorFor(fx.rt, "ses_pm"), value)
  const questions = () => fx.rt.ledger.messages({ toId: "ses_pm" }).filter((m) => m.from.id === "go-horse" && m.needsAnswerBy)
  return { ...fx, enable, questions }
}

async function readyItem(fx: Awaited<ReturnType<typeof setup>>, title = "Exercise the main flow", scopeFiles = ["src/flow/**"]) {
  const id = itemIdFrom(await fx.call("ses_pm", "propose", { title, moves: "G1 functional coverage", predicted: "unknown: this is a measurement", why: "Exercise the authorized main flow", scopeFiles }))
  await fx.call("ses_co", "accept", { item: id })
  await fx.call("ses_co", "refine", { item: id, scopeFiles, doneWhen: "The main flow has an execution record" })
  return id
}

async function startItem(fx: Awaited<ReturnType<typeof setup>>, id: string) {
  await fx.call("ses_co", "assign", { item: id, engineer: fx.rt.ledger.agent("ses_ana")!.name })
  await fx.call("ses_ana", "claim", { item: id, branch: `work/${id}`, worktree: `/work/${id}`, files: ["src/flow/**"] })
}

test("GO HORSE is opt-in and wakes an idle PM at 15 minutes, not before", async (t) => {
  const fx = await setup()
  t.after(() => fx.rt.ledger.close())
  fx.clock.advance(GO_HORSE_IDLE_MS)
  await tickGoHorse(fx.rt)
  assert.equal(fx.questions().length, 0)
  fx.enable()
  fx.clock.advance(GO_HORSE_IDLE_MS - 1)
  await tickGoHorse(fx.rt)
  assert.equal(fx.questions().length, 0)
  fx.clock.advance(1)
  await tick(fx.rt)
  assert.equal(fx.questions().length, 1)
  const q = fx.questions()[0]!
  assert.match(q.text, /GO HORSE 1\/10/)
  assert.match(q.text, /coordination_ask/)
  assert.ok(q.needsAnswerBy && q.delivered)
  assert.ok(fx.delivered.some((d) => d.sessionID === "ses_pm" && d.text.includes(q.short)))
  await Promise.all([tickGoHorse(fx.rt), tickGoHorse(fx.rt)])
  fx.clock.advance(GO_HORSE_IDLE_MS)
  await tickGoHorse(fx.rt)
  assert.equal(fx.questions().length, 1, "a pending question prevents another question")
})

test("busy, gone and non-OpenCode PMs do not receive wake-ups", async (t) => {
  const fx = await setup()
  t.after(() => fx.rt.ledger.close())
  fx.enable()
  for (const status of ["busy", "gone"]) {
    fx.rt.ledger.append({ type: "agent.status", actor: SYSTEM_ACTOR, payload: { sessionID: "ses_pm", status } })
    fx.clock.advance(GO_HORSE_IDLE_MS)
    await tickGoHorse(fx.rt)
  }
  fx.rt.ledger.append({ type: "agent.seen", actor: SYSTEM_ACTOR, payload: { sessionID: "ses_pm", role: "product-manager", status: "idle", kind: "cli" } })
  fx.clock.advance(GO_HORSE_IDLE_MS)
  await tickGoHorse(fx.rt)
  assert.equal(fx.questions().length, 0)
})

test("new PM activity resets the idle window", async (t) => {
  const fx = await setup()
  t.after(() => fx.rt.ledger.close())
  fx.enable()
  fx.clock.advance(GO_HORSE_IDLE_MS - 1000)
  fx.rt.ledger.append({ type: "agent.status", actor: SYSTEM_ACTOR, payload: { sessionID: "ses_pm", status: "idle" } })
  fx.clock.advance(1000)
  await tickGoHorse(fx.rt)
  assert.equal(fx.questions().length, 0)
  fx.clock.advance(GO_HORSE_IDLE_MS - 1000)
  await tickGoHorse(fx.rt)
  assert.equal(fx.questions().length, 1)
})

test("the PM must obtain the coordinator's answer before closing a wake-up, including a resent copy", async (t) => {
  const fx = await setup()
  t.after(() => fx.rt.ledger.close())
  fx.enable()
  fx.clock.advance(GO_HORSE_IDLE_MS)
  await tickGoHorse(fx.rt)
  const q = fx.questions()[0]!
  assert.match(await fx.callFail("ses_pm", "answer", { message: q.short, text: "Everything works." }), /consult the coordinator first/)
  const id = await readyItem(fx)
  await fx.call("ses_pm", "ask", { to: "coordinator", item: id, text: "Start this item and obtain the engineer claim." })
  const follow = fx.rt.ledger.openQuestions().find((m) => m.from.id === "ses_pm")!
  assert.match(await fx.callFail("ses_pm", "answer", { message: q.short, text: "I asked." }), /after its answer arrives/)
  fx.clock.advance(60 * 60_000)
  await tick(fx.rt)
  const copy = fx.rt.ledger.messages({ toId: "ses_pm" }).find((m) => m.inReplyTo === q.id)!
  assert.ok(copy)
  assert.match(await fx.callFail("ses_pm", "answer", { message: copy.short, text: "Skip the coordinator." }), /consult the coordinator first/)
  await fx.call("ses_co", "answer", { message: follow.short, text: "No approved work exists. Both engineers remain available; the PM must define the next functional priority." })
  assert.match(await fx.callFail("ses_pm", "answer", { message: copy.short, text: "We are waiting." }), /concrete work is required/)
  await startItem(fx, id)
  await fx.call("ses_pm", "answer", { message: copy.short, text: `Work started on ${id}; coordinator record ${follow.short}.` })
  assert.equal(fx.rt.ledger.message(q.id)?.answeredBy, "ses_pm")
})

test("ten questions rotate across restart/rebuild, without repeating on an unanswered cycle", async (t) => {
  const fx = await setup()
  t.after(() => fx.rt.ledger.close())
  fx.enable()
  assert.equal(GO_HORSE_QUESTIONS.length, 10)
  assert.equal(new Set(GO_HORSE_QUESTIONS).size, 10)
  for (let i = 0; i < 11; i++) {
    fx.clock.advance(GO_HORSE_IDLE_MS)
    await tickGoHorse(fx.rt)
    const q = fx.questions().find((m) => !m.answeredBy)!
    assert.ok(q.text.includes(GO_HORSE_QUESTIONS[i % 10]!))
    const id = await readyItem(fx, `Main flow execution ${i}`)
    await fx.call("ses_pm", "ask", { to: "coordinator", item: id, text: `Start execution ${i} and obtain the engineer claim.` })
    const follow = fx.rt.ledger.openQuestions().find((m) => m.from.id === "ses_pm")!
    await startItem(fx, id)
    await fx.call("ses_co", "answer", { message: follow.short, text: `The engineer claimed ${id}.` })
    await fx.call("ses_pm", "answer", { message: q.short, text: `The engineer started ${id}; coordinator record ${follow.short}.` })
    await fx.call("ses_ana", "ready", { item: id, checks: [{ name: "flow", result: "execution record" }], result: "Main flow executed" })
    await fx.call("ses_co", "merged", { item: id, commit: "abc1234567" })
    fx.rt.ledger.rebuild()
    assert.equal(goHorseMode(fx.rt)?.payload.enabled, true)
  }
  assert.equal(fx.questions().length, 11)
})

test("a pending cycle wakes the PM and coordinator again after 15 idle minutes without opening another question", async (t) => {
  const fx = await setup()
  t.after(() => fx.rt.ledger.close())
  fx.enable()
  fx.clock.advance(GO_HORSE_IDLE_MS)
  await tickGoHorse(fx.rt)
  const q = fx.questions()[0]!
  fx.clock.advance(GO_HORSE_IDLE_MS - 1)
  await tickGoHorse(fx.rt)
  assert.equal(fx.rt.ledger.events({ type: "go_horse.retried" }).length, 0)
  fx.clock.advance(1)
  await Promise.all([tickGoHorse(fx.rt), tickGoHorse(fx.rt)])
  assert.equal(fx.questions().length, 1)
  assert.equal(fx.rt.ledger.events({ type: "go_horse.retried" }).length, 1)
  assert.ok(fx.delivered.some((d) => d.sessionID === "ses_pm" && d.text.includes(`record ${q.short} still requires concrete work`)))
  assert.ok(fx.delivered.some((d) => d.sessionID === "ses_co" && d.text.includes(`record ${q.short}`)))
  fx.rt.ledger.rebuild()
  await tickGoHorse(fx.rt)
  assert.equal(fx.rt.ledger.events({ type: "go_horse.retried" }).length, 1)
  fx.clock.advance(GO_HORSE_IDLE_MS)
  await tickGoHorse(fx.rt)
  assert.equal(fx.rt.ledger.events({ type: "go_horse.retried" }).length, 2)
})

test("conversation, proposals, assignment alone and progress text do not close an inactive cycle", async (t) => {
  const fx = await setup()
  t.after(() => fx.rt.ledger.close())
  fx.enable()
  fx.clock.advance(GO_HORSE_IDLE_MS)
  await tickGoHorse(fx.rt)
  const q = fx.questions()[0]!
  const id = await readyItem(fx)
  await fx.call("ses_pm", "ask", { to: "coordinator", item: id, text: "Start the functional execution." })
  const follow = fx.rt.ledger.openQuestions().find((m) => m.from.id === "ses_pm")!
  await fx.call("ses_co", "answer", { message: follow.short, text: "Waiting." })
  assert.match(await fx.callFail("ses_pm", "answer", { message: q.short, text: "No change." }), /concrete work is required/)
  await fx.call("ses_co", "assign", { item: id, engineer: fx.rt.ledger.agent("ses_ana")!.name })
  await fx.call("ses_ana", "progress", { item: id, line: "Waiting for the next step." })
  assert.match(await fx.callFail("ses_pm", "answer", { message: q.short, text: "Assigned and updated status." }), /concrete work is required/)
  assert.equal(fx.rt.ledger.message(q.id)?.answeredBy, undefined)
  await fx.call("ses_ana", "claim", { item: id, branch: "work/flow", worktree: "/work/flow", files: ["src/flow/**"] })
  await fx.call("ses_ana", "blocked", { item: id, on: "Missing approval", unblockOn: "Owner approval" })
  assert.match(await fx.callFail("ses_pm", "answer", { message: q.short, text: "Blocked, stop here." }), /concrete work is required/)
})

test("work on an unrelated item and work before the wake-up do not close the cycle", async (t) => {
  const fx = await setup()
  t.after(() => fx.rt.ledger.close())
  const old = await readyItem(fx, "Earlier work")
  await startItem(fx, old)
  fx.enable()
  fx.clock.advance(GO_HORSE_IDLE_MS)
  await tickGoHorse(fx.rt)
  const q = fx.questions()[0]!
  await fx.call("ses_pm", "ask", { to: "coordinator", item: old, text: "Move this item forward." })
  const follow = fx.rt.ledger.openQuestions().find((m) => m.from.id === "ses_pm" && m.kind === "ask")!
  await fx.call("ses_co", "answer", { message: follow.short, text: "It started before the wake-up." })
  assert.match(await fx.callFail("ses_pm", "answer", { message: q.short, text: "Already active." }), /concrete work is required/)
  const other = await readyItem(fx, "Other work", ["src/other/**"])
  await fx.call("ses_co", "assign", { item: other, engineer: fx.rt.ledger.agent("ses_bru")!.name })
  await fx.call("ses_bru", "claim", { item: other, branch: "work/other", worktree: "/work/other", files: ["src/other/**"] })
  await fx.call("ses_bru", "ready", { item: other, checks: [{ name: "other", result: "execution record" }], result: "Other flow executed" })
  // Independent work does not prove that the item named in the PM's question advanced.
  await fx.call("ses_co", "verdict", { item: other, verdict: "approved", findings: "Other item reviewed" })
  assert.match(await fx.callFail("ses_pm", "answer", { message: q.short, text: "Other work moved." }), /concrete work is required/)
  await fx.call("ses_ana", "ready", { item: old, checks: [{ name: "flow", result: "execution record" }], result: "Main flow executed" })
  await fx.call("ses_co", "verdict", { item: old, verdict: "approved", findings: "Functional execution record reviewed" })
  await fx.call("ses_pm", "answer", { message: q.short, text: `The coordinator reviewed ${old} after the wake-up.` })
})

test("disable closes wake-up deadlines and stops the clock without deleting history", async (t) => {
  const fx = await setup()
  t.after(() => fx.rt.ledger.close())
  fx.enable()
  fx.clock.advance(GO_HORSE_IDLE_MS)
  await tickGoHorse(fx.rt)
  fx.enable(false)
  fx.rt.ledger.rebuild()
  fx.clock.advance(3 * 60 * 60_000)
  await tick(fx.rt)
  assert.equal(fx.questions().length, 1)
  assert.ok(fx.questions()[0]?.cancelled)
  assert.equal(fx.rt.ledger.openQuestions().filter((m) => m.from.id === "go-horse").length, 0)
  assert.equal(goHorseMode(fx.rt)?.payload.enabled, false)
  fx.enable()
  await tickGoHorse(fx.rt)
  assert.equal(fx.questions().length, 1, "re-enable starts a new 15-minute window")
})

test("failed delivery retries the same record on the next tick", async (t) => {
  const fx = await setup()
  t.after(() => fx.rt.ledger.close())
  fx.enable()
  fx.clock.advance(GO_HORSE_IDLE_MS)
  const deliver = fx.rt.host!.deliver
  fx.rt.host!.deliver = async () => { throw new Error("host unavailable") }
  await tickGoHorse(fx.rt)
  const q = fx.questions()[0]!
  assert.equal(q.delivered, false)
  fx.rt.host!.deliver = deliver
  fx.clock.advance(60_000)
  await tickGoHorse(fx.rt)
  assert.equal(fx.questions().length, 1)
  assert.equal(fx.rt.ledger.message(q.id)?.delivered, true)
})

test("disable cancels undelivered wake-ups without claiming delivery or an answer", async (t) => {
  const fx = await setup()
  t.after(() => fx.rt.ledger.close())
  fx.enable()
  fx.clock.advance(GO_HORSE_IDLE_MS)
  const deliver = fx.rt.host!.deliver
  fx.rt.host!.deliver = async () => { throw new Error("host unavailable") }
  await tickGoHorse(fx.rt)
  const q = fx.questions()[0]!
  fx.enable(false)
  fx.rt.ledger.rebuild()
  fx.rt.host!.deliver = deliver
  assert.equal(await pull(fx.rt, "ses_pm"), 0)
  assert.equal(fx.rt.ledger.pendingCount(["ses_pm"]), 0)
  assert.equal(fx.rt.ledger.undeliveredCount(), 0)
  const cancelled = fx.rt.ledger.message(q.id)!
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.delivered, false)
  assert.equal(cancelled.answeredBy, undefined)
  assert.match(await fx.callFail("ses_pm", "answer", { message: q.short, text: "Already disabled." }), /cancelled/)
})

test("the coordinator receives allocation instructions without new tools or authority", async (t) => {
  const fx = await setup()
  t.after(() => fx.rt.ledger.close())
  assert.doesNotMatch(buildPrompt(fx.rt, "ses_co"), /GO HORSE/)
  fx.enable()
  assert.match(buildPrompt(fx.rt, "ses_co"), /Assign useful independent work through coordination_assign/)
  assert.match(buildPrompt(fx.rt, "ses_co"), /Respect holds, parked fronts and approvals/)
  assert.doesNotMatch(buildPrompt(fx.rt, "ses_ana"), /GO HORSE/)
})

test("a missing PM session is not woken before gone detection", async (t) => {
  const fx = await setup()
  t.after(() => fx.rt.ledger.close())
  fx.enable()
  fx.sessions.delete("ses_pm")
  fx.clock.advance(GO_HORSE_IDLE_MS)
  await tickGoHorse(fx.rt)
  assert.equal(fx.questions().length, 0)
})

test("disable or new activity during the host lookup prevents a late wake-up", async (t) => {
  const fx = await setup()
  t.after(() => fx.rt.ledger.close())
  fx.enable()
  fx.clock.advance(GO_HORSE_IDLE_MS)
  fx.rt.host!.liveSessions = async (ids) => { fx.enable(false); return new Set(ids) }
  await tickGoHorse(fx.rt)
  assert.equal(fx.questions().length, 0)
  fx.enable()
  fx.clock.advance(GO_HORSE_IDLE_MS)
  fx.rt.host!.liveSessions = async (ids) => {
    fx.rt.ledger.append({ type: "agent.status", actor: SYSTEM_ACTOR, payload: { sessionID: "ses_pm", status: "busy" } })
    return new Set(ids)
  }
  await tickGoHorse(fx.rt)
  assert.equal(fx.questions().length, 0)
})
