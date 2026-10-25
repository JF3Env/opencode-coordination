import { z } from "zod"
import { filesOverlap, isActive } from "../domain/items.ts"
import { actorParty, answerOpen, fail, postToRole } from "../runtime.ts"
import { dispatch } from "../deliver/deliver.ts"
import { tool, type ToolCtx, type ToolSpec } from "./define.ts"
import { block, expectState, holdsCovering, needMine } from "./helpers.ts"

const eng = ["engineer"] as const

async function toCoordinator(ctx: ToolCtx, item: string | undefined, text: string, needsAnswer: boolean): Promise<string> {
  const sent = postToRole(ctx.rt, "coordinator", { from: actorParty(ctx.actor), kind: "rendered", text, item, needsAnswer, actor: ctx.actor }, ctx.actor.session)
  for (const m of sent) await dispatch(ctx.rt, m)
  return sent.map((m) => m.short).join(", ")
}

export const available = tool({
  name: "available",
  roles: eng,
  description: "Tell the coordinator you can take work: at the start of a session, after your pull request merged or closed, or when your work is blocked and you can take something else.",
  input: z.object({ waitingOn: z.string().trim().optional(), canTake: z.string().trim().optional() }).strict(),
  async run(ctx, i) {
    const { rt, actor } = ctx
    const mine = rt.ledger.items((it) => it.assignee === actor.session || it.assigneeName === actor.name).sort((a, b) => (a.lastEventAt < b.lastEventAt ? 1 : -1))[0]
    rt.ledger.append({ type: "agent.available", actor, payload: { waitingOn: i.waitingOn, canTake: i.canTake } })
    const short = await toCoordinator(ctx, undefined, block([
      `AVAILABLE ${actor.name}`,
      `Last: ${mine ? `${mine.id} ${mine.title} [${mine.state}]${mine.pr ? ` PR #${mine.pr}` : ""}` : "none"}`,
      `Waiting on: ${i.waitingOn ?? "nothing"}`,
      i.canTake ? `Can take: ${i.canTake}` : undefined,
    ]), true)
    return `Availability sent (record ${short || "none: no coordinator is registered yet; it will arrive when one is"}). The coordinator assigns work; you start no branch until it does.`
  },
})

export const claim = tool({
  name: "claim",
  roles: eng,
  description: "Claim an assigned item: its branch, worktree and the files you will change. The ACTIVE page and the coordinator's roster come from this call; nobody types them. Warns when your files overlap another active item.",
  input: z.object({ item: z.string().trim().min(1), branch: z.string().trim().min(1), worktree: z.string().trim().min(1), files: z.array(z.string().trim().min(1)).min(1) }).strict(),
  async run(ctx, i) {
    const { rt, actor } = ctx
    const item = needMine(ctx, i.item)
    expectState(item, "assigned")
    const clashes = rt.ledger.items((o) => o.id !== item.id && isActive(o)).flatMap((o) => filesOverlap(i.files, o.scopeFiles).map((f) => `${f} (${o.id} ${o.assigneeName ?? ""})`))
    rt.ledger.append({ type: "item.claimed", actor, subject: item.id, payload: { id: item.id, branch: i.branch, worktree: i.worktree, files: i.files } })
    answerOpen(rt, item.id, [actor.session], actor)
    if (clashes.length) await toCoordinator(ctx, item.id, `SCOPE overlap on claim by ${actor.name} for ${item.id}: ${clashes.join("; ")}`, false)
    return clashes.length ? `Claimed ${item.id}. Warning: your files overlap other active work: ${clashes.join("; ")}. The coordinator was told.` : `Claimed ${item.id}; no file collisions.`
  },
})

export const scope = tool({
  name: "scope",
  roles: eng,
  description: "Send the coordinator a scope note before design-heavy work: files, numbers, refusals, and numbered open questions. Each question becomes its own tracked question.",
  input: z.object({ item: z.string().trim().min(1), summary: z.string().trim().min(1).max(4000), questions: z.array(z.string().trim().min(1)).default([]) }).strict(),
  async run(ctx, i) {
    const item = needMine(ctx, i.item)
    await toCoordinator(ctx, item.id, `SCOPE ${item.id} from ${ctx.actor.name}:\n${i.summary}`, false)
    const shorts: string[] = []
    for (const [n, q] of i.questions.entries()) shorts.push(await toCoordinator(ctx, item.id, `QUESTION ${n + 1} of ${i.questions.length} (${item.id}): ${q}`, true))
    return `Scope note sent${shorts.length ? `; ${shorts.length} question(s) tracked: ${shorts.join(", ")}` : ""}.`
  },
})

export const progress = tool({
  name: "progress",
  roles: eng,
  description: "Post one line of progress on your item (what is done, what is left, when you expect to be ready). It shows on the board and keeps the item from reading as stalled.",
  input: z.object({ item: z.string().trim().min(1), line: z.string().trim().min(1).max(300) }).strict(),
  run(ctx, i) {
    const item = needMine(ctx, i.item)
    ctx.rt.ledger.append({ type: "item.progress", actor: ctx.actor, subject: item.id, payload: { id: item.id, line: i.line } })
    return `Progress recorded on ${item.id}.`
  },
})

export const ready = tool({
  name: "ready",
  roles: eng,
  description: "Mark your item ready for review after you marked the pull request ready. The plugin checks on GitHub that the PR is not a draft and contains main, and that no hold covers it, then sends the coordinator the review request.",
  input: z.object({
    item: z.string().trim().min(1),
    pr: z.number().int().positive().optional(),
    checks: z.array(z.object({ name: z.string().trim().min(1), result: z.string().trim().min(1) }).strict()).min(1),
    sharedFiles: z.array(z.string()).default([]),
    numbers: z.array(z.string()).default([]),
    result: z.string().trim().min(1),
    next: z.string().trim().optional(),
  }).strict(),
  async run(ctx, i) {
    const { rt, actor } = ctx
    const item = needMine(ctx, i.item)
    expectState(item, "in_progress")
    const holds = holdsCovering(rt, item, rt.profile.freezeExempt.includes(actor.role))
    if (holds.length) fail(`${item.id} is held by ${holds.map((h) => `${h.id} (${h.reason}; until ${h.liftOn})`).join(", ")}. Do not mark ready until it is lifted.`)
    let head: string | undefined
    let pr = i.pr ?? item.pr
    if (rt.github) {
      const info = await rt.github.prForItem(item.branch, pr)
      if (!info) fail(`No pull request found for ${item.branch ?? "this item"}. Open it (a draft first), then call ready.`)
      if (info.isDraft) fail(`Pull request #${info.number} is still a draft. Run gh pr ready ${info.number} first.`)
      if (!info.containsMain) fail(`Pull request #${info.number} does not contain main. Merge main into the branch, push, and call ready again.`)
      head = info.head
      pr = info.number
      rt.ledger.append({ type: "pr.synced", actor, subject: item.id, payload: { item: item.id, pr, head, containsMain: true, isDraft: false } })
    }
    rt.ledger.append({ type: "item.in_review", actor, subject: item.id, payload: { id: item.id, pr, head, checks: i.checks, sharedFiles: i.sharedFiles, numbers: i.numbers, result: i.result, next: i.next } })
    const short = await toCoordinator(ctx, item.id, block([
      `READY ${pr ? `#${pr} ` : ""}${head ?? ""} ${item.id} ${item.title}`,
      `Contains main: ${head ? "yes (checked on GitHub)" : "not checked (no GitHub link configured)"}`,
      `Checks: ${i.checks.map((c) => `${c.name}: ${c.result}`).join("; ")}`,
      `Shared files touched by the merge: ${i.sharedFiles.join(", ") || "none"}`,
      `Numbers used: ${i.numbers.join(", ") || "none"}`,
      `Result: ${i.result}`,
      i.next ? `Next: ${i.next}` : undefined,
    ]), true)
    return `${item.id} is in review (record ${short || "queued for the coordinator"}). Answer the findings with commits and a comment, then call ready again.`
  },
})

export const result = tool({
  name: "result",
  roles: ["engineer", "product-manager"],
  description: "Report what a merged item measured against its prediction: before, after, the committed record, and whether it met, missed or was inconclusive. The product manager and the coordinator are told.",
  input: z.object({
    item: z.string().trim().min(1), before: z.string().trim().min(1), after: z.string().trim().min(1),
    record: z.string().trim().min(1), verdict: z.enum(["met", "missed", "inconclusive"]),
    measure: z.string().trim().optional(), unit: z.string().trim().default(""),
  }).strict(),
  async run(ctx, i) {
    const { rt, actor } = ctx
    const item = rt.ledger.resolveItem(i.item)
    if (!("found" in item)) fail(`No item ${i.item}.`)
    const it = item.found
    if (actor.role === "engineer" && it.assignee !== actor.session) fail(`${it.id} is not assigned to you.`)
    expectState(it, "merged")
    const id = rt.ledger.newId("M", "measures")
    rt.ledger.appendMany([
      { type: "measure.recorded", actor, subject: it.id, payload: { id, name: i.measure ?? it.outcome.moves ?? it.title, front: it.front, value: i.after, unit: i.unit, record: i.record } },
      { type: "item.measured", actor, subject: it.id, payload: { id: it.id, result: { before: i.before, after: i.after, record: i.record, verdict: i.verdict } } },
    ])
    const text = `RESULT ${it.id}: ${i.measure ?? it.outcome.moves ?? it.title} ${i.before} → ${i.after} (${i.record})\nPrediction: ${it.predicted ?? "none"}; ${i.verdict}`
    const sent = [
      ...(actor.role === "engineer" ? postToRole(rt, "product-manager", { from: actorParty(actor), kind: "rendered", text, item: it.id, actor }, actor.session) : []),
      ...postToRole(rt, "coordinator", { from: actorParty(actor), kind: "rendered", text, item: it.id, actor }, actor.session),
    ]
    for (const m of sent) await dispatch(rt, m)
    return `Result recorded on ${it.id}: ${i.verdict}.`
  },
})

export const blocked = tool({
  name: "blocked",
  roles: eng,
  description: "Say that your item is blocked, on what, and which event unblocks it. The coordinator sees it in the review queue and can hand you other work.",
  input: z.object({ item: z.string().trim().min(1), on: z.string().trim().min(1), unblockOn: z.string().trim().min(1) }).strict(),
  async run(ctx, i) {
    const item = needMine(ctx, i.item)
    expectState(item, "assigned", "in_progress", "in_review")
    ctx.rt.ledger.append({ type: "item.blocked", actor: ctx.actor, subject: item.id, payload: { id: item.id, on: i.on, unblockOn: i.unblockOn } })
    await toCoordinator(ctx, item.id, `BLOCKED ${item.id} ${item.title}: on ${i.on}; unblocked by ${i.unblockOn}`, false)
    return `${item.id} is blocked on ${i.on}. Call coordination_available if you can take something else.`
  },
})

export const defectFound = tool({
  name: "defect_found",
  roles: eng,
  description: "Record a defect you found outside your assignment so it is not lost. It is reported to the product manager and the coordinator. Write the defect file your project requires before you fix anything.",
  input: z.object({ summary: z.string().trim().min(1).max(2000), area: z.string().trim().optional() }).strict(),
  async run({ rt, actor }, i) {
    const id = rt.ledger.newId("I", "incidents")
    rt.ledger.append({ type: "incident.reported", actor, subject: id, payload: { id, kind: "defect", text: i.summary, area: i.area } })
    const text = `DEFECT found by ${actor.name}${i.area ? ` in ${i.area}` : ""} (${id}): ${i.summary}`
    const sent = [...postToRole(rt, "coordinator", { from: actorParty(actor), kind: "incident", text, actor }, actor.session), ...postToRole(rt, "product-manager", { from: actorParty(actor), kind: "incident", text, actor }, actor.session)]
    for (const m of sent) await dispatch(rt, m)
    return `Defect recorded as ${id}. Record it in your project's defect register as OPEN before fixing it, and keep to your assignment.`
  },
})

export const handover = tool({
  name: "handover",
  roles: eng,
  description: "Hand your item back to the coordinator, with what is left and the data others rely on. Your branch and pull request stay as they are.",
  input: z.object({ item: z.string().trim().min(1), leftToDo: z.string().trim().min(1), data: z.string().trim().optional() }).strict(),
  async run(ctx, i) {
    const item = needMine(ctx, i.item)
    expectState(item, "assigned", "in_progress", "blocked", "in_review")
    ctx.rt.ledger.append({ type: "item.handed_over", actor: ctx.actor, subject: item.id, payload: { id: item.id, leftToDo: i.leftToDo, data: i.data } })
    await toCoordinator(ctx, item.id, block([`HANDOVER ${item.id} ${item.title} from ${ctx.actor.name}`, `Branch: ${item.branch ?? "none"}${item.pr ? `, PR #${item.pr}` : ""}`, `Left to do: ${i.leftToDo}`, i.data ? `Data: ${i.data}` : undefined]), true)
    return `${item.id} handed over; it is back in the coordinator's queue.`
  },
})

export const engineerTools: ToolSpec[] = [available, claim, scope, progress, ready, result, blocked, defectFound, handover]
