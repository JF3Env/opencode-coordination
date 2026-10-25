import type { Runtime } from "../runtime.ts"
import { blockMs } from "../runtime.ts"
import { currentItem, freeEngineers } from "./board.ts"
import type { Item } from "../domain/types.ts"
import { isActive } from "../domain/items.ts"

export interface StateDigest {
  at: string
  since: string
  merged: Item[]
  inFlight: Array<{ engineer: string; item: Item }>
  blocked: Item[]
  free: string[]
  ownerPending: string[]
  openQuestions: number
  stalled: Item[]
}

export function computeState(rt: Runtime, since?: string): StateDigest {
  const at = rt.now().toISOString()
  const from = since ?? new Date(rt.now().getTime() - blockMs(rt)).toISOString()
  const items = rt.ledger.items()
  const merged = items.filter((i) => (i.stages.implemented?.at ?? "") > from)
  const inFlight = rt.ledger.agents((a) => a.role === "engineer" && a.status !== "gone").flatMap((a) => {
    const item = currentItem(rt.ledger, a.sessionID)
    return item ? [{ engineer: a.name, item }] : []
  })
  const blocked = items.filter((i) => i.state === "blocked")
  const limit = rt.now().getTime() - 2 * blockMs(rt)
  const stalled = items.filter((i) => isActive(i) && i.state !== "blocked" && Date.parse(i.lastEventAt) < limit)
  const ownerPending = rt.ledger.incidents().filter((i) => i.forOwner).map((i) => String(i.text)).concat(
    rt.ledger.openQuestions().filter((m) => m.escalated && m.from.id !== "system").map((m) => `escalated: ${m.text.split("\n")[0]}`),
  )
  return { at, since: from, merged, inFlight, blocked, free: freeEngineers(rt.ledger).map((a) => a.name), ownerPending, openQuestions: rt.ledger.openQuestions().length, stalled }
}

const outcomeLine = (item: Item) => (item.outcome.moves ? `Moves: ${item.outcome.moves}` : `Upkeep: ${item.outcome.upkeep ?? "—"}`)

export function stateText(s: StateDigest): string {
  const list = (items: string[]) => (items.length ? items.map((x) => `  - ${x}`).join("\n") : "  —")
  return [
    `STATE ${s.at}`,
    `Merged since ${s.since}:\n${list(s.merged.map((i) => `${i.id} ${i.title} (${outcomeLine(i)})`))}`,
    `In flight:\n${list(s.inFlight.map((f) => `${f.engineer}: ${f.item.id} ${f.item.title} [${f.item.state}]${f.item.pr ? ` PR #${f.item.pr}` : ""}`))}`,
    `Blocked:\n${list(s.blocked.map((i) => `${i.id} ${i.title}: ${i.blockedOn ?? "?"}`))}`,
    `Stalled (no event for two blocks):\n${list(s.stalled.map((i) => `${i.id} ${i.title} (${i.assigneeName ?? "unassigned"})`))}`,
    `Free engineers: ${s.free.join(", ") || "none"}`,
    `Open questions with a deadline: ${s.openQuestions}`,
    `Owner decisions pending:\n${list(s.ownerPending)}`,
  ].join("\n")
}
