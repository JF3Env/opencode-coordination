import type { Ledger } from "../ledger/ledger.ts"
import type { Profile } from "../config/profile.ts"
import type { AgentDoc, Item, MeasureDoc } from "../domain/types.ts"
import { isActive } from "../domain/items.ts"

export interface FrontView {
  id: string
  title: string
  parked?: { reason: string; unparkOn: string }
  now: Item[]
  next: Item[]
  later: Item[]
  done: Item[]
  measures: MeasureDoc[]
}

export interface Board {
  fronts: FrontView[]
}

const byPriority = (a: Item, b: Item) => (a.priority ?? 1e9) - (b.priority ?? 1e9) || a.id.localeCompare(b.id)

export const NO_FRONT = "(none)"

/** What is moving now, what comes next, what waits: computed from items, never written by hand. */
export function computeBoard(ledger: Ledger, profile: Profile, only?: string): Board {
  const items = ledger.items()
  const parked = ledger.parkedFronts()
  const titles = new Map(profile.fronts.map((f) => [f.id, f.title]))
  const ids = new Set<string>(profile.fronts.map((f) => f.id))
  for (const item of items) ids.add(item.front ?? NO_FRONT)
  const latest = new Map<string, MeasureDoc>()
  for (const m of ledger.measures()) latest.set(m.name, m)
  const fronts: FrontView[] = [...ids].filter((id) => !only || id === only).map((id) => {
    const mine = items.filter((item) => (item.front ?? NO_FRONT) === id)
    return {
      id,
      title: titles.get(id) ?? "",
      parked: parked[id],
      now: mine.filter(isActive).sort(byPriority),
      next: mine.filter((i) => i.state === "ready").sort(byPriority),
      later: mine.filter((i) => ["proposed", "accepted", "deferred"].includes(i.state)).sort(byPriority),
      done: mine.filter((i) => ["merged", "measured", "validated"].includes(i.state)).sort(byPriority),
      measures: [...latest.values()].filter((m) => (m.front ?? NO_FRONT) === id),
    }
  })
  fronts.sort((a, b) => (a.id === NO_FRONT ? 1 : b.id === NO_FRONT ? -1 : a.id.localeCompare(b.id)))
  return { fronts }
}

export function currentItem(ledger: Ledger, sessionID: string): Item | undefined {
  return ledger.items((i) => i.assignee === sessionID && isActive(i)).sort(byPriority)[0]
}

export function freeEngineers(ledger: Ledger): AgentDoc[] {
  return ledger.agents((a) => a.role === "engineer" && a.status !== "gone" && !currentItem(ledger, a.sessionID))
}

const line = (item: Item) =>
  `${item.id} [${item.state}] ${item.title}${item.assigneeName ? ` — ${item.assigneeName}` : ""}${item.pr ? ` (PR #${item.pr})` : ""}${item.blockedOn ? ` BLOCKED on ${item.blockedOn}` : ""}`

export function boardText(board: Board): string {
  const out: string[] = []
  for (const f of board.fronts) {
    out.push(`${f.id}${f.title ? ` — ${f.title}` : ""}${f.parked ? ` (parked: ${f.parked.reason}; until ${f.parked.unparkOn})` : ""}`)
    const section = (name: string, items: Item[]) => out.push(`  ${name}: ${items.length ? "" : "—"}`, ...items.map((i) => `    ${line(i)}`))
    section("Now", f.now)
    section("Next", f.next)
    section("Later", f.later)
    if (f.measures.length) out.push("  Measures:", ...f.measures.map((m) => `    ${m.name} = ${m.value} ${m.unit} (${m.record}${m.claimed ? ", claim: record not on main" : ""})`))
    out.push("")
  }
  return out.join("\n").trimEnd() || "No work items yet."
}
