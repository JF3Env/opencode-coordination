import { z } from "zod"
import { ITEM_KINDS } from "../domain/types.ts"
import { actorParty, fail, postToRole } from "../runtime.ts"
import { dispatch } from "../deliver/deliver.ts"
import { boardText, computeBoard } from "../views/board.ts"
import { tool, type ToolCtx, type ToolSpec } from "./define.ts"
import { block, expectState, needItem } from "./helpers.ts"

const pm = ["product-manager"] as const

async function toCoordinators(ctx: ToolCtx, text: string, item: string | undefined, needsAnswer: boolean): Promise<string[]> {
  const sent = postToRole(ctx.rt, "coordinator", { from: actorParty(ctx.actor), kind: "rendered", text, item, needsAnswer, actor: ctx.actor }, ctx.actor.session)
  for (const m of sent) await dispatch(ctx.rt, m)
  return sent.map((m) => m.short)
}

export const propose = tool({
  name: "propose",
  roles: pm,
  description: "Propose a work item to the coordinator. Every item is a bet: it moves a named measure or is upkeep that says what it enables, with a prediction and the rule that will decide it, registered before any run. The coordinator answers within a block.",
  input: z.object({
    title: z.string().trim().min(1), front: z.string().trim().optional(), kind: z.enum(ITEM_KINDS).default("feature"),
    moves: z.string().trim().optional(), upkeep: z.string().trim().optional(), enables: z.string().trim().optional(),
    measure: z.string().trim().optional(), baseline: z.string().trim().optional(),
    predicted: z.string().trim().optional(), decidedBy: z.string().trim().optional(), stopIf: z.string().trim().optional(),
    scopeFiles: z.array(z.string().trim().min(1)).default([]), engineerKind: z.enum(["opencode", "claude"]).default("opencode"), engineerKindWhy: z.string().trim().optional(),
    why: z.string().trim().min(1), notCovered: z.string().trim().optional(),
  }).strict(),
  async run(ctx, i) {
    const { rt, actor } = ctx
    if (!!i.moves === !!i.upkeep) fail("State exactly one outcome line: moves (the measure it moves) or upkeep (with enables).")
    if (i.upkeep && !i.enables) fail("Upkeep must say what it enables (a goal or bet it unblocks, or the word none).")
    if (i.engineerKind === "claude" && !i.engineerKindWhy) fail("A Claude engineer is the expensive resource: say why this item needs one (engineerKindWhy).")
    if (i.moves && !i.predicted) fail("A bet names its prediction, or the words 'unknown: this is a measurement', and the rule that decides it.")
    if (rt.profile.fronts.length && i.front && !rt.profile.fronts.some((f) => f.id === i.front)) fail(`Unknown front ${i.front}. Fronts: ${rt.profile.fronts.map((f) => f.id).join(", ")}.`)
    const id = rt.ledger.newId("W", "items")
    const outcome = i.moves ? { moves: i.moves } : { upkeep: i.upkeep, enables: i.enables }
    const proposalText = block([i.measure ? `Measure: ${i.measure}${i.baseline ? `, baseline ${i.baseline}` : ""}` : undefined, i.stopIf ? `Stop if: ${i.stopIf}` : undefined, `Why now: ${i.why}`, i.notCovered ? `Not covered: ${i.notCovered}` : undefined])
    rt.ledger.append({ type: "item.proposed", actor, subject: id, payload: { id, title: i.title, kind: i.kind, front: i.front, outcome, predicted: i.predicted, decidedBy: i.decidedBy, engineerKind: i.engineerKind, engineerKindWhy: i.engineerKindWhy, scopeFiles: i.scopeFiles, proposalText } })
    const shorts = await toCoordinators(ctx, block([
      `PROPOSAL ${id}${i.front ? ` ${i.front}` : ""}: ${i.title}`,
      i.moves ? `Moves: ${i.moves}` : `Upkeep: ${i.upkeep}; Enables: ${i.enables}`,
      proposalText,
      i.predicted ? `Predicted: ${i.predicted}${i.decidedBy ? `; decided by ${i.decidedBy}` : ""}` : undefined,
      `Scope: ${i.scopeFiles.join(", ") || "—"}`,
      `Kind: ${i.engineerKind}${i.engineerKindWhy ? `: ${i.engineerKindWhy}` : ""}`,
    ]), id, true)
    return `Proposed ${id}; the coordinator was told (record ${shorts.join(", ") || "queued until one registers"}).`
  },
})

export const decide = tool({
  name: "decide",
  roles: pm,
  description: "Record a product decision (a priority, or the removal of a roadblock) and send it to the coordinator, who carries it out and answers done or cannot within a block.",
  input: z.object({
    text: z.string().trim().min(1), why: z.string().trim().min(1), conditions: z.string().trim().default(""),
    carriedBy: z.enum(["coordinator", "engineer"]).default("coordinator"), items: z.array(z.string()).default([]),
  }).strict(),
  async run(ctx, i) {
    const id = ctx.rt.ledger.newId("D", "decisions")
    ctx.rt.ledger.append({ type: "decision.recorded", actor: ctx.actor, subject: id, payload: { id, text: i.text, why: i.why, conditions: i.conditions, carriedBy: i.carriedBy, items: i.items } })
    const shorts = await toCoordinators(ctx, block([`DECISION ${id}: ${i.text}`, `Why: ${i.why}`, i.conditions ? `Conditions: ${i.conditions}` : undefined, `Carried out by: ${i.carriedBy}`]), id, true)
    return `Recorded ${id}; sent to the coordinator (record ${shorts.join(", ") || "queued"}). It answers done or cannot within a block.`
  },
})

export const prioritize = tool({
  name: "prioritize",
  roles: pm,
  description: "Set the order of work in a front. The board shows it as now / next / later. An upkeep item in the first slot draws a warning: it must say what it enables.",
  input: z.object({ front: z.string().trim().min(1), order: z.array(z.string().trim().min(1)).min(1) }).strict(),
  async run(ctx, i) {
    const { rt, actor } = ctx
    const items = i.order.map((q) => needItem(rt, q))
    rt.ledger.append({ type: "front.prioritized", actor, subject: i.front, payload: { front: i.front, order: items.map((x) => x.id) } })
    const warn = items[0] && !items[0].outcome.moves && !items[0].outcome.enables ? ` Warning: ${items[0].id} is upkeep with nothing it enables, in the first slot.` : ""
    await toCoordinators(ctx, `Priority of ${i.front} changed: ${items.map((x) => `${x.id} ${x.title}`).join(" > ")}`, undefined, false)
    return `${i.front} ordered.${warn}\n${boardText(computeBoard(rt.ledger, rt.profile, i.front))}`
  },
})

export const measure = tool({
  name: "measure",
  roles: pm,
  description: "Record a measurement of a product measure, with the committed record that holds it. When a repository is configured, a record that is not on main is kept only as a claim to check, not as a measurement.",
  input: z.object({
    name: z.string().trim().min(1), front: z.string().trim().optional(), value: z.string().trim().min(1), unit: z.string().trim().default(""),
    record: z.string().trim().min(1), commit: z.string().trim().optional(), sensitiveTo: z.string().trim().optional(), blindTo: z.string().trim().optional(),
  }).strict(),
  async run({ rt, actor }, i) {
    const id = rt.ledger.newId("M", "measures")
    const onMain = rt.github ? await rt.github.recordOnMain(i.record) : true
    rt.ledger.append({ type: onMain ? "measure.recorded" : "measure.claimed", actor, subject: id, payload: { id, ...i } })
    const n = rt.ledger.measures(i.name).length
    return onMain ? `Recorded ${i.name} = ${i.value} ${i.unit}; ${n} point(s) in its series.` : `${i.record} is not on main, so this is a claim to check, not a measurement. Commit the record and measure again.`
  },
})

export const validate = tool({
  name: "validate",
  roles: pm,
  description: "Mark an item validated: checked against something independent of the work, under a rule fixed beforehand (a real capture, a held-out judgement, the owner's acceptance). A test that passes is tested, not validated.",
  input: z.object({ item: z.string().trim().min(1), reference: z.string().trim().min(1), record: z.string().trim().min(1) }).strict(),
  run({ rt, actor }, i) {
    const item = needItem(rt, i.item)
    expectState(item, "merged", "measured")
    rt.ledger.append({ type: "item.validated", actor, subject: item.id, payload: { id: item.id, reference: i.reference, record: i.record } })
    const done = rt.ledger.items((x) => x.state === "validated").length
    return `${item.id} validated against ${i.reference}. Validated items: ${done} of ${rt.ledger.items((x) => ["merged", "measured", "validated"].includes(x.state)).length} built.`
  },
})

export const park = tool({
  name: "park",
  roles: pm,
  description: "Park a front that waits for something outside the team, with the reason and the event that unparks it. A parked front draws no stall alerts.",
  input: z.object({ front: z.string().trim().min(1), reason: z.string().trim().min(1), unparkOn: z.string().trim().min(1) }).strict(),
  run({ rt, actor }, i) {
    rt.ledger.append({ type: "front.parked", actor, subject: i.front, payload: i })
    return `${i.front} parked until ${i.unparkOn}.`
  },
})

export const unpark = tool({
  name: "unpark",
  roles: pm,
  description: "End the parking of a front, so its stalls are raised again from now on.",
  input: z.object({ front: z.string().trim().min(1) }).strict(),
  run({ rt, actor }, i) {
    if (!rt.ledger.parkedFronts()[i.front]) fail(`${i.front} is not parked.`)
    rt.ledger.append({ type: "front.unparked", actor, subject: i.front, payload: i })
    return `${i.front} unparked.`
  },
})

export const stall = tool({
  name: "stall",
  roles: pm,
  description: "Tell the coordinator that a goal or item has stalled: nothing merged, assigned or committed. The clock raises most stalls itself; use this for the ones only you can see.",
  input: z.object({ target: z.string().trim().min(1), since: z.string().trim().min(1), constraint: z.string().trim().min(1), proposal: z.string().trim().min(1) }).strict(),
  async run(ctx, i) {
    const shorts = await toCoordinators(ctx, `STALL ${i.target}: nothing moved since ${i.since}\nConstraint: ${i.constraint}\nProposal: ${i.proposal}`, undefined, true)
    return `Stall sent (record ${shorts.join(", ") || "queued"}).`
  },
})

// A summary line is read by a senior sponsor. No codes, ids, paths or symbols a non-specialist would not know.
const CODE_PATTERNS: Array<[RegExp, string]> = [
  [/#\d+/, "a pull-request number"],
  [/\b[A-Z]{2,}-\d+\b/, "a record code such as DEF-12"],
  [/\bD\d+\b/, "a decision code"],
  [/`/, "a code span"],
  [/\b[\w.-]+\/[\w./-]+\b/, "a file path"],
  [/\b[\w-]+\.(md|go|ts|json|py|yaml|yml)\b/i, "a file name"],
  [/\b[0-9a-f]{7,40}\b/, "a commit hash"],
]

export function codesIn(text: string): string[] {
  return CODE_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label)
}

export const summary = tool({
  name: "summary",
  roles: pm,
  description: "Write one line of the executive status: where a front stands, a risk, or a decision the sponsor must take. Plain words only; codes, ids, paths and hashes are refused. The status page is assembled from these lines.",
  input: z.object({ kind: z.enum(["front", "risk", "decision"]), key: z.string().trim().min(1), text: z.string().trim().min(1).max(600) }).strict(),
  run({ rt, actor }, i) {
    const codes = codesIn(i.text)
    if (codes.length) fail(`The status is read by a sponsor with nothing else open. Remove ${codes.join(", ")} and say it in plain words.`)
    rt.ledger.append({ type: "view.summary", actor, subject: i.key, payload: i })
    return `Recorded ${i.kind} line ${i.key}. coordination render writes it into the status page.`
  },
})

export const bundle = tool({
  name: "bundle",
  roles: pm,
  description: "Assemble the owner bundle from the ledger: the measures that moved, then the decisions that wait for the owner (escalations, safety matters), then the open stalls. Sent to nobody; you hand it to the owner.",
  input: z.object({ since: z.string().trim().optional() }).strict(),
  run({ rt }, i) {
    const since = i.since ?? rt.ledger.meta("last_bundle") ?? "0"
    const measures = rt.ledger.measures().filter((m) => m.at > since)
    const done = rt.ledger.items((it) => Boolean(it.result || it.stages.validated) && (it.stages.validated?.at ?? it.lastEventAt) > since)
    const waiting = [
      ...rt.ledger.incidents().filter((x) => x.forOwner).map((x) => `SAFETY ${String(x.text)}`),
      ...rt.ledger.openQuestions().filter((m) => m.escalated).map((m) => `Unanswered after two blocks: ${m.from.name} → ${m.to.name}: ${m.text.split("\n")[0]}`),
      ...rt.ledger.decisions().filter((d) => d.answer === "cannot").map((d) => `Cannot carry out: ${d.text} (${d.answerReason})`),
    ]
    const l = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- none")
    rt.ledger.setMeta("last_bundle", rt.now().toISOString())
    return [
      "1. Measures: what moved, what did not, and why",
      l(measures.map((m) => `${m.name} = ${m.value} ${m.unit} (${m.record})`)),
      l(done.map((it) => `${it.title}: ${it.result ? `${it.result.before} → ${it.result.after}, ${it.result.verdict}` : "validated"}`)),
      "",
      "2. Decisions needed from you",
      l(waiting),
    ].join("\n")
  },
})

export const pmTools: ToolSpec[] = [propose, decide, prioritize, measure, validate, park, unpark, stall, summary, bundle]
