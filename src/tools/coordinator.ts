import { z } from "zod"
import { ITEM_KINDS } from "../domain/types.ts"
import type { AgentDoc, Item } from "../domain/types.ts"
import { filesOverlap, isActive } from "../domain/items.ts"
import { actorParty, answerOpen, fail, partyOf, post, resolveTarget, type Runtime } from "../runtime.ts"
import { dispatch } from "../deliver/deliver.ts"
import { computeState, stateText } from "../views/state.ts"
import { freeEngineers } from "../views/board.ts"
import { tool, type ToolCtx, type ToolSpec } from "./define.ts"
import { block, expectState, fmtOutcome, holdsCovering, needItem, oneLine } from "./helpers.ts"

const coord = ["coordinator"] as const

function toAgent(ctx: ToolCtx, agent: AgentDoc, item: string | undefined, text: string, needsAnswer: boolean, kind: "rendered" | "answer" = "rendered") {
  const m = post(ctx.rt, { from: actorParty(ctx.actor), to: partyOf(agent), kind, text, item, needsAnswer, actor: ctx.actor })
  return dispatch(ctx.rt, m).then(() => m)
}

async function proposerOf(rt: Runtime, item: Item): Promise<AgentDoc | undefined> {
  return rt.ledger.agents((a) => a.name === item.proposedBy && a.status !== "gone")[0]
}

async function answerProposal(ctx: ToolCtx, item: Item, verdict: "accepted" | "deferred" | "rejected", text: string): Promise<void> {
  const mine = [ctx.actor.session, "role:coordinator"]
  answerOpen(ctx.rt, item.id, mine, ctx.actor)
  const pm = await proposerOf(ctx.rt, item)
  if (pm) await toAgent(ctx, pm, item.id, `ANSWER ${item.id}: ${verdict.toUpperCase()} ${text}`.trim(), false, "answer")
}

export const accept = tool({
  name: "accept",
  roles: coord,
  description: "Accept a proposed work item, with conditions. It moves to accepted; refine it to make it ready to assign. The product manager gets the answer.",
  input: z.object({ item: z.string().trim().min(1), conditions: z.string().trim().optional() }).strict(),
  async run(ctx, i) {
    const item = needItem(ctx.rt, i.item)
    expectState(item, "proposed", "deferred")
    ctx.rt.ledger.append({ type: "item.accepted", actor: ctx.actor, subject: item.id, payload: { id: item.id, conditions: i.conditions } })
    await answerProposal(ctx, item, "accepted", i.conditions ?? "")
    return `${item.id} accepted. Call coordination_refine when its scope and done-when are set.`
  },
})

export const defer = tool({
  name: "defer",
  roles: coord,
  description: "Defer a proposed item, with the reason and what will bring it back.",
  input: z.object({ item: z.string().trim().min(1), reason: z.string().trim().min(1) }).strict(),
  async run(ctx, i) {
    const item = needItem(ctx.rt, i.item)
    expectState(item, "proposed", "accepted")
    ctx.rt.ledger.append({ type: "item.deferred", actor: ctx.actor, subject: item.id, payload: { id: item.id, reason: i.reason } })
    await answerProposal(ctx, item, "deferred", i.reason)
    return `${item.id} deferred.`
  },
})

export const reject = tool({
  name: "reject",
  roles: coord,
  description: "Reject a proposed item, with the reason. The product manager is told and the proposal is closed.",
  input: z.object({ item: z.string().trim().min(1), reason: z.string().trim().min(1) }).strict(),
  async run(ctx, i) {
    const item = needItem(ctx.rt, i.item)
    expectState(item, "proposed")
    ctx.rt.ledger.append({ type: "item.rejected", actor: ctx.actor, subject: item.id, payload: { id: item.id, reason: i.reason } })
    await answerProposal(ctx, item, "rejected", i.reason)
    return `${item.id} rejected.`
  },
})

export const cancel = tool({
  name: "cancel",
  roles: coord,
  description: "Cancel an item that is no longer wanted, with the reason. The assignee, if any, is told.",
  input: z.object({ item: z.string().trim().min(1), reason: z.string().trim().min(1) }).strict(),
  async run(ctx, i) {
    const item = needItem(ctx.rt, i.item)
    if (["merged", "measured", "validated", "rejected", "cancelled"].includes(item.state)) fail(`${item.id} is ${item.state} and cannot be cancelled.`)
    ctx.rt.ledger.append({ type: "item.cancelled", actor: ctx.actor, subject: item.id, payload: { id: item.id, reason: i.reason } })
    const who = item.assignee ? ctx.rt.ledger.agent(item.assignee) : undefined
    if (who) await toAgent(ctx, who, item.id, `CANCELLED ${item.id} ${item.title}: ${i.reason}. Stop work on it and call coordination_available.`, false)
    return `${item.id} cancelled.`
  },
})

export const refine = tool({
  name: "refine",
  roles: coord,
  description: "Complete an accepted item so it can be assigned: the files it will touch, the observable done-when, an estimate in blocks, constraints and reserved identifiers. It becomes ready.",
  input: z.object({
    item: z.string().trim().min(1), scopeFiles: z.array(z.string().trim().min(1)).min(1), doneWhen: z.string().trim().min(1),
    estimate: z.tuple([z.number().min(0), z.number().min(0)]).optional(), constraints: z.string().trim().optional(), identifiers: z.array(z.string()).optional(),
  }).strict(),
  run(ctx, i) {
    const item = needItem(ctx.rt, i.item)
    expectState(item, "accepted")
    ctx.rt.ledger.append({ type: "item.refined", actor: ctx.actor, subject: item.id, payload: { id: item.id, scopeFiles: i.scopeFiles, doneWhen: i.doneWhen, estimate: i.estimate, constraints: i.constraints, identifiers: i.identifiers } })
    return `${item.id} is ready to assign.`
  },
})

export const breakdown = tool({
  name: "breakdown",
  roles: coord,
  description: "Break an initiative into activities of one pull request each. Each child inherits the front and outcome of the parent unless it states its own, and starts ready to assign.",
  input: z.object({
    parent: z.string().trim().min(1),
    items: z.array(z.object({
      title: z.string().trim().min(1), kind: z.enum(ITEM_KINDS).default("feature"), scopeFiles: z.array(z.string().trim().min(1)).min(1),
      doneWhen: z.string().trim().min(1), estimate: z.tuple([z.number().min(0), z.number().min(0)]).optional(),
      moves: z.string().trim().optional(), upkeep: z.string().trim().optional(), enables: z.string().trim().optional(),
    }).strict()).min(1),
  }).strict(),
  run(ctx, i) {
    const { rt, actor } = ctx
    const parent = needItem(rt, i.parent)
    const ids: string[] = []
    let t = rt.ledger.now().getTime()
    for (const child of i.items) {
      const id = rt.ledger.newId("W", "items", "id", t++)
      const outcome = child.moves ? { moves: child.moves } : child.upkeep ? { upkeep: child.upkeep, enables: child.enables } : parent.outcome
      rt.ledger.appendMany([
        { type: "item.proposed", actor, subject: id, payload: { id, title: child.title, kind: child.kind, front: parent.front, outcome, parent: parent.id, engineerKind: parent.engineerKind, engineerKindWhy: parent.engineerKindWhy, scopeFiles: child.scopeFiles, doneWhen: child.doneWhen, estimate: child.estimate } },
        { type: "item.accepted", actor, subject: id, payload: { id } },
        { type: "item.refined", actor, subject: id, payload: { id, scopeFiles: child.scopeFiles, doneWhen: child.doneWhen, estimate: child.estimate } },
      ])
      ids.push(id)
    }
    return `Created ${ids.length} ready item(s) under ${parent.id}: ${ids.join(", ")}.`
  },
})

export interface AssignCheck {
  refusal?: string
  warnings: string[]
}

/** The checks before an assignment is recorded (docs/uml/src/12-act-assign-checks.puml). */
export function checkAssignable(rt: Runtime, item: Item, target: AgentDoc, self: string): AssignCheck {
  const warnings: string[] = []
  if (target.role !== "engineer") return { refusal: `${target.name} is a ${target.role}; ASSIGN goes only to an engineer.`, warnings }
  // A blocked item waits on something outside the engineer's hands, so it does not use up the open-item limit: the
  // engineer was told to call available and take something else. Its files still count for overlap below.
  const open = rt.ledger.items((o) => o.id !== item.id && o.assignee === target.sessionID && isActive(o) && o.state !== "blocked")
  if (open.length >= rt.profile.limits.openItemsPerEngineer) return { refusal: `${target.name} already has ${open.map((o) => o.id).join(", ")}; the limit is ${rt.profile.limits.openItemsPerEngineer} open item(s) per engineer.`, warnings }
  const holds = holdsCovering(rt, item, rt.profile.freezeExempt.includes("coordinator"))
  if (holds.length) return { refusal: `${item.id} is held by ${holds.map((h) => `${h.id} (${h.reason}; until ${h.liftOn})`).join(", ")}.`, warnings }
  const clashes = rt.ledger.items((o) => o.id !== item.id && isActive(o)).flatMap((o) => filesOverlap(item.scopeFiles, o.scopeFiles).map((f) => `${f} with ${o.id}`))
  if (clashes.length) return { refusal: `Files overlap active work: ${clashes.join("; ")}. Sequence the items or narrow the scope.`, warnings }
  const engineers = rt.ledger.agents((a) => a.role === "engineer" && a.status !== "gone").length || 1
  const upkeepActive = rt.ledger.items((o) => isActive(o) && !o.outcome.moves).length + (item.outcome.moves ? 0 : 1)
  if (!item.outcome.moves && upkeepActive / engineers > rt.profile.limits.upkeepShare) warnings.push(`upkeep share is ${upkeepActive} of ${engineers} engineers, above ${rt.profile.limits.upkeepShare}`)
  if (item.engineerKind === "claude" && target.kind === "opencode") warnings.push(`the proposal asked for a Claude engineer: ${item.engineerKindWhy ?? "no reason given"}`)
  void self
  return { warnings }
}

function assignmentText(item: Item, name: string, fresh: boolean): string {
  return block([
    fresh ? "FRESH START. This session has no earlier transcript. Your role and name are unchanged. Do not reconstruct earlier work." : undefined,
    `ASSIGN ${name}: ${item.id} ${item.title}`,
    fmtOutcome(item),
    item.predicted ? `Predicted: ${item.predicted}${item.decidedBy ? `; decided by ${item.decidedBy}` : ""}` : undefined,
    `Scope: ${item.scopeFiles.join(", ") || "—"}${item.identifiers.length ? `; numbers ${item.identifiers.join(", ")}` : ""}`,
    `Kind: ${item.engineerKind}${item.engineerKindWhy ? `: ${item.engineerKindWhy}` : ""}`,
    item.doneWhen ? `Done when: ${item.doneWhen}` : undefined,
    item.constraints ? `Constraints: ${item.constraints}` : undefined,
    item.branch ? `Take over branch ${item.branch}${item.pr ? ` and PR #${item.pr}` : ""}; say so in a comment on the PR.` : undefined,
    "Claim the item with coordination_claim (branch, worktree, files) when you start.",
  ])
}

export const assign = tool({
  name: "assign",
  roles: coord,
  description: "Assign a ready item to an engineer. The plugin refuses on file overlap, a hold or freeze, or an engineer that already has an open item. Set fresh true only for a totally new activity: the engineer's session is replaced by an empty one that keeps its name, role, model and directory.",
  input: z.object({ item: z.string().trim().min(1), engineer: z.string().trim().min(1), fresh: z.boolean().default(false) }).strict(),
  async run(ctx, i) {
    const { rt, actor } = ctx
    const item = needItem(rt, i.item)
    expectState(item, "ready")
    const target = await resolveTarget(rt, i.engineer, actor.session)
    if (target.kind !== "agent") fail("ASSIGN goes to an engineer session of this project; name one with coordination_peers.")
    let agent = target.agent
    const check = checkAssignable(rt, item, agent, actor.session)
    if (check.refusal) fail(check.refusal)
    let removed: boolean | undefined
    if (i.fresh) {
      if (agent.kind !== "opencode") fail("A fresh start replaces only an OpenCode engineer session.")
      if (!rt.host?.replaceSession) fail("This host cannot start a replacement session, so the engineer was not replaced.")
      const replaced = await rt.host.replaceSession({ sessionID: agent.sessionID, name: agent.name, agent: agent.agent, directory: agent.directory })
      rt.ledger.append({ type: "agent.renamed", actor, payload: { fromID: agent.sessionID, toID: replaced.sessionID, name: agent.name, removed: replaced.removed } })
      agent = rt.ledger.agent(replaced.sessionID) as AgentDoc
      removed = replaced.removed
    }
    rt.ledger.append({ type: "item.assigned", actor, subject: item.id, payload: { id: item.id, assignee: agent.sessionID, assigneeName: agent.name, fresh: i.fresh } })
    const m = await toAgent(ctx, agent, item.id, assignmentText(rt.ledger.item(item.id) as Item, agent.name, i.fresh), true)
    return `Assigned ${item.id} to ${agent.name} (record ${m.short}); a claim is due within a block.${removed === undefined ? "" : ` The old transcript was ${removed ? "deleted" : "archived"}.`}${check.warnings.length ? ` Warnings: ${check.warnings.join("; ")}.` : ""}`
  },
})

export const reassign = tool({
  name: "reassign",
  roles: coord,
  description: "Pass an item that is stalled or orphaned to another engineer. The branch and pull request stay; the new engineer takes them over and the previous one is told to stop.",
  input: z.object({ item: z.string().trim().min(1), engineer: z.string().trim().min(1) }).strict(),
  async run(ctx, i) {
    const { rt, actor } = ctx
    const item = needItem(rt, i.item)
    expectState(item, "assigned", "in_progress", "blocked", "in_review", "ready")
    const target = await resolveTarget(rt, i.engineer, actor.session)
    if (target.kind !== "agent") fail("Name an engineer session of this project.")
    const previous = item.assignee ? rt.ledger.agent(item.assignee) : undefined
    if (previous?.sessionID === target.agent.sessionID) fail(`${item.id} is already ${target.agent.name}'s.`)
    const check = checkAssignable(rt, item, target.agent, actor.session)
    if (check.refusal) fail(check.refusal)
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    if (item.state !== "ready") events.push({ type: "item.handed_over", payload: { id: item.id, leftToDo: `reassigned to ${target.agent.name}` } })
    events.push({ type: "item.assigned", payload: { id: item.id, assignee: target.agent.sessionID, assigneeName: target.agent.name, takesOver: item.branch } })
    rt.ledger.appendMany(events.map((e) => ({ ...e, actor, subject: item.id })))
    const m = await toAgent(ctx, target.agent, item.id, assignmentText(rt.ledger.item(item.id) as Item, target.agent.name, false), true)
    if (previous && previous.status !== "gone") await toAgent(ctx, previous, item.id, `${item.id} ${item.title} was reassigned to ${target.agent.name}. Stop pushing to ${item.branch ?? "its branch"}.`, false)
    return `Reassigned ${item.id} to ${target.agent.name} (record ${m.short}).`
  },
})

export const verdict = tool({
  name: "verdict",
  roles: coord,
  description: "Record a review verdict on an item in review. Returns the text to post as the pull-request comment (it starts with STEWARD:). With changes, the item goes back to in progress and the engineer is told.",
  input: z.object({ item: z.string().trim().min(1), verdict: z.enum(["approved", "changes"]), findings: z.string().trim().min(1) }).strict(),
  async run(ctx, i) {
    const { rt, actor } = ctx
    const item = needItem(rt, i.item)
    expectState(item, "in_review")
    const label = i.verdict === "approved" ? "STEWARD: APPROVED" : "STEWARD: CHANGES REQUESTED"
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [{ type: "item.verdict", payload: { id: item.id, verdict: i.verdict, findings: i.findings } }]
    if (i.verdict === "changes") events.push({ type: "item.returned", payload: { id: item.id } })
    rt.ledger.appendMany(events.map((e) => ({ ...e, actor, subject: item.id })))
    const who = item.assignee ? rt.ledger.agent(item.assignee) : undefined
    if (who) await toAgent(ctx, who, item.id, `${label} on ${item.id}${item.pr ? ` (PR #${item.pr})` : ""}\n${i.findings}`, false)
    return [`Verdict recorded on ${item.id}. Post this on the pull request${i.verdict === "changes" ? " and run gh pr ready --undo" : ""}:`, "", `${label}\n\n${i.findings}`].join("\n")
  },
})

export const merged = tool({
  name: "merged",
  roles: coord,
  description: "Record that an item's pull request merged, with the merge commit. Normally the GitHub sync does this; use it as a fallback. Tells the authors of other open items that main moved.",
  input: z.object({ item: z.string().trim().min(1), commit: z.string().trim().min(7) }).strict(),
  async run(ctx, i) {
    const { rt, actor } = ctx
    const item = needItem(rt, i.item)
    expectState(item, "in_review")
    rt.ledger.append({ type: "item.merged", actor, subject: item.id, payload: { id: item.id, commit: i.commit } })
    const others = rt.ledger.agents((a) => a.status !== "gone" && a.role !== "other" && a.sessionID !== actor.session && a.sessionID !== item.assignee)
    for (const a of others) await toAgent(ctx, a, item.id, `main moved: ${item.id} ${item.title} merged as ${i.commit.slice(0, 8)}. Files: ${item.scopeFiles.join(", ") || "—"}.`, false)
    return `${item.id} merged as ${i.commit.slice(0, 8)}; ${others.length} agent(s) told.`
  },
})

export const hold = tool({
  name: "hold",
  roles: coord,
  description: "Declare a hold on paths or pull requests, or a freeze of everything. It is broadcast to every agent, ready and assign refuse covered items, and it ends only with coordination_lift.",
  input: z.object({
    kind: z.enum(["hold", "freeze"]).default("hold"), paths: z.array(z.string().trim().min(1)).default([]), prs: z.array(z.number().int()).default([]),
    reason: z.string().trim().min(1), liftOn: z.string().trim().min(1),
  }).strict(),
  async run(ctx, i) {
    const { rt, actor } = ctx
    if (i.kind === "hold" && !i.paths.length && !i.prs.length) fail("A hold names paths or pull requests; use kind freeze to cover everything.")
    const id = rt.ledger.newId("H", "holds")
    rt.ledger.append({ type: "hold.declared", actor, subject: id, payload: { id, kind: i.kind, paths: i.paths, prs: i.prs, reason: i.reason, liftOn: i.liftOn } })
    const hold = rt.ledger.holds().find((h) => h.id === id) as import("../domain/types.ts").HoldDoc
    const covered = rt.ledger.items((it) => it.state === "in_review" && holdsCovering(rt, it, false).some((h) => h.id === id))
    for (const it of covered) rt.ledger.append({ type: "item.blocked", actor, subject: it.id, payload: { id: it.id, on: `hold:${id}`, unblockOn: `lift ${id}` } })
    const agents = rt.ledger.agents((a) => a.status !== "gone" && a.role !== "other" && a.sessionID !== actor.session)
    const text = `${i.kind.toUpperCase()} ${id}: ${i.reason}\n${i.kind === "freeze" ? "Covers everything." : `Covers ${[...hold.paths, ...hold.prs.map((p) => `PR #${p}`)].join(", ")}.`}\nEnds when: ${i.liftOn}. Only coordination_lift ends it.`
    for (const a of agents) {
      const m = post(rt, { from: actorParty(actor), to: partyOf(a), kind: "broadcast", text, actor })
      await dispatch(rt, m)
    }
    return `${i.kind} ${id} declared; ${agents.length} agent(s) told; ${covered.length} item(s) in review blocked.`
  },
})

export const lift = tool({
  name: "lift",
  roles: coord,
  description: "End a hold or freeze by its id. Items blocked by it go back to work; every agent is told.",
  input: z.object({ hold: z.string().trim().min(1) }).strict(),
  async run(ctx, i) {
    const { rt, actor } = ctx
    const hold = rt.ledger.holds().find((h) => h.id === i.hold)
    if (!hold) fail(`No active hold ${i.hold}. Active: ${rt.ledger.holds().map((h) => h.id).join(", ") || "none"}.`)
    rt.ledger.append({ type: "hold.lifted", actor, subject: hold.id, payload: { id: hold.id } })
    const freed = rt.ledger.items((it) => it.state === "blocked" && it.blockedOn === `hold:${hold.id}`)
    for (const it of freed) rt.ledger.append({ type: "item.unblocked", actor, subject: it.id, payload: { id: it.id } })
    const agents = rt.ledger.agents((a) => a.status !== "gone" && a.role !== "other" && a.sessionID !== actor.session)
    for (const a of agents) await dispatch(rt, post(rt, { from: actorParty(actor), to: partyOf(a), kind: "broadcast", text: `LIFT ${hold.id}: ${hold.reason} is over.`, actor }))
    return `${hold.id} lifted; ${freed.length} item(s) unblocked; ${agents.length} agent(s) told.`
  },
})

export const queue = tool({
  name: "queue",
  roles: coord,
  description: "Your review queue and loose ends: items in review in the order they became ready, pull requests that do not contain main, quiet items, blocked items, and free engineers with the next ready items.",
  input: z.object({}).strict(),
  run({ rt }) {
    const items = rt.ledger.items()
    const review = items.filter((i) => i.state === "in_review").sort((a, b) => ((a.stages.tested?.at ?? "") < (b.stages.tested?.at ?? "") ? -1 : 1))
    const quiet = items.filter((i) => ["in_progress", "assigned"].includes(i.state) && Date.parse(i.lastProgressAt ?? i.lastEventAt) < rt.now().getTime() - rt.profile.blockMinutes * 60_000)
    const blocked = items.filter((i) => i.state === "blocked")
    const nextReady = items.filter((i) => i.state === "ready").sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9))
    const free = freeEngineers(rt.ledger)
    const l = (xs: string[]) => (xs.length ? xs.map((x) => `  - ${x}`).join("\n") : "  —")
    return [
      `In review (ready order):\n${l(review.map((i) => `${i.id} ${oneLine(i.title, 60)} — ${i.assigneeName ?? "?"}${i.pr ? ` PR #${i.pr}` : ""}${i.containsMain === false ? " DOES NOT CONTAIN MAIN" : ""}`))}`,
      `Quiet for a block (idle drafts, unclaimed):\n${l(quiet.map((i) => `${i.id} ${oneLine(i.title, 60)} — ${i.assigneeName ?? "?"} [${i.state}]`))}`,
      `Blocked:\n${l(blocked.map((i) => `${i.id} ${oneLine(i.title, 60)}: ${i.blockedOn}`))}`,
      `Free engineers: ${free.map((a) => a.name).join(", ") || "none"}`,
      `Next ready to assign:\n${l(nextReady.slice(0, 8).map((i) => `${i.id} [${i.front ?? "-"}] ${oneLine(i.title, 70)}`))}`,
    ].join("\n")
  },
})

export const state = tool({
  name: "state",
  roles: coord,
  description: "The STATE digest: merged, in flight, blocked, stalled, free engineers, owner decisions pending. Generated; with send true it goes to the product manager. The clock also sends it every block.",
  input: z.object({ send: z.boolean().default(false) }).strict(),
  async run(ctx, i) {
    const text = stateText(computeState(ctx.rt))
    if (!i.send) return text
    const pms = ctx.rt.ledger.agents((a) => a.role === "product-manager" && a.status !== "gone")
    for (const pm of pms) await toAgent(ctx, pm, undefined, text, false)
    return `${text}\n\n(sent to ${pms.length} product manager session(s))`
  },
})

export const decisionAnswer = tool({
  name: "decision_answer",
  roles: coord,
  description: "Answer a product manager's decision: done (with what you assigned), cannot (with the reason), accepted (will be done, with when) or in_progress. Done and cannot close it.",
  input: z.object({ decision: z.string().trim().min(1), answer: z.enum(["done", "cannot", "accepted", "in_progress"]), reason: z.string().trim().optional(), items: z.array(z.string()).optional() }).strict(),
  async run(ctx, i) {
    const { rt, actor } = ctx
    const d = rt.ledger.decision(i.decision)
    if (!d) fail(`No decision ${i.decision}. Decisions: ${rt.ledger.decisions().map((x) => x.id).join(", ") || "none"}.`)
    if ((i.answer === "cannot" || i.answer === "accepted" || i.answer === "in_progress") && !i.reason) fail(`${i.answer} needs a reason or a time.`)
    rt.ledger.append({ type: "decision.answered", actor, subject: d.id, payload: { id: d.id, answer: i.answer, reason: i.reason, items: i.items } })
    if (i.answer === "done" || i.answer === "cannot") {
      const open = rt.ledger.messages({ item: d.id }).filter((m) => !m.answeredBy && m.needsAnswerBy).map((m) => m.id)
      for (const id of open) rt.ledger.append({ type: "message.answered", actor, payload: { id, by: actor.session } })
    }
    const pm = rt.ledger.agents((a) => a.role === "product-manager" && a.status !== "gone")
    for (const a of pm) await toAgent(ctx, a, undefined, `${i.answer.toUpperCase().replace("_", " ")} ${d.id}${i.reason ? `: ${i.reason}` : ""}${i.items?.length ? ` (${i.items.join(", ")})` : ""}`, false, "answer")
    return `${d.id}: ${i.answer}.`
  },
})

export const coordinatorTools: ToolSpec[] = [accept, defer, reject, cancel, refine, breakdown, assign, reassign, verdict, merged, hold, lift, queue, state, decisionAnswer]
