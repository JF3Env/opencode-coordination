import type { Item, ItemState, Stage } from "./types.ts"

// Allowed moves of the work-item life cycle (docs/uml/src/04-item-states.puml).
export const TRANSITIONS: Record<ItemState, readonly ItemState[]> = {
  proposed: ["accepted", "deferred", "rejected", "cancelled"],
  accepted: ["ready", "deferred", "cancelled"],
  deferred: ["accepted", "cancelled"],
  ready: ["assigned", "cancelled"],
  assigned: ["in_progress", "blocked", "ready", "cancelled"],
  in_progress: ["in_review", "blocked", "ready", "cancelled"],
  blocked: ["in_progress", "in_review", "ready", "cancelled"],
  in_review: ["in_progress", "merged", "blocked", "ready", "cancelled"],
  merged: ["measured", "validated"],
  measured: ["validated"],
  validated: [],
  rejected: [],
  cancelled: [],
}

export function canTransition(from: ItemState, to: ItemState): boolean {
  return TRANSITIONS[from].includes(to)
}

export const ACTIVE_STATES: readonly ItemState[] = ["assigned", "in_progress", "in_review", "blocked"]
export const OPEN_STATES: readonly ItemState[] = ["proposed", "accepted", "ready", "assigned", "in_progress", "in_review", "blocked", "deferred"]

export function isActive(item: Pick<Item, "state">): boolean {
  return ACTIVE_STATES.includes(item.state)
}

// Files overlap when one path equals, contains, or is contained by the other. A trailing /** or / covers a directory.
export function filesOverlap(left: readonly string[], right: readonly string[]): string[] {
  const norm = (value: string) => value.replace(/\/\*\*$/, "").replace(/\/+$/, "")
  const hits = new Set<string>()
  for (const a of left) {
    for (const b of right) {
      const x = norm(a)
      const y = norm(b)
      if (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) hits.add(a === b ? a : `${a} ~ ${b}`)
    }
  }
  return [...hits]
}

export function withStage(item: Item, stage: Stage, at: string, commit?: string): void {
  item.stages[stage] = commit ? { at, commit } : { at }
}
