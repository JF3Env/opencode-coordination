import type { HoldDoc, Item } from "../domain/types.ts"
import { filesOverlap } from "../domain/items.ts"
import { fail, type Runtime } from "../runtime.ts"
import type { ToolCtx } from "./define.ts"

export function needItem(rt: Runtime, query: string): Item {
  const found = rt.ledger.resolveItem(query)
  if ("found" in found) return found.found
  if ("ambiguous" in found) fail(`${found.ambiguous.length} items begin with ${query}: ${found.ambiguous.join(", ")}.`)
  return fail(`No item ${JSON.stringify(query)}. coordination_board lists them.`)
}

export function needMine(ctx: ToolCtx, query: string): Item {
  const item = needItem(ctx.rt, query)
  if (item.assignee !== ctx.actor.session) fail(`${item.id} is not assigned to you${item.assigneeName ? ` (it is ${item.assigneeName}'s)` : ""}.`)
  return item
}

export function expectState(item: Item, ...states: Item["state"][]): void {
  if (!states.includes(item.state)) fail(`${item.id} is ${item.state}; this needs it to be ${states.join(" or ")}.`)
}

/** The active holds and freezes that cover an item: a freeze covers everything. */
export function holdsCovering(rt: Runtime, item: Item, exempt: boolean): HoldDoc[] {
  return rt.ledger.holds().filter((hold) => {
    if (hold.kind === "freeze") return !exempt
    if (item.pr && hold.prs.includes(item.pr)) return true
    return hold.paths.length > 0 && filesOverlap(hold.paths, item.scopeFiles).length > 0
  })
}

export function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function fmtOutcome(item: Pick<Item, "outcome">): string {
  const o = item.outcome
  if (o.moves) return `Moves: ${o.moves}`
  return `Upkeep: ${o.upkeep ?? "—"}${o.enables ? `; Enables: ${o.enables}` : ""}`
}

export function block(lines: Array<string | undefined>): string {
  return lines.filter((l): l is string => Boolean(l)).join("\n")
}
