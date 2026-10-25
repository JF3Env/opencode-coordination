import type { Role } from "./types.ts"

// The role comes from the session's agent id, never from a name written in a message.
export function roleOf(agent: string | undefined, aliases?: Partial<Record<Exclude<Role, "other">, string[]>>): Role {
  const id = agent?.trim().toLowerCase()
  if (!id) return "other"
  const table: Record<Exclude<Role, "other">, string[]> = {
    coordinator: aliases?.coordinator ?? ["coordinator"],
    "product-manager": aliases?.["product-manager"] ?? ["product-manager", "pm"],
    engineer: aliases?.engineer ?? ["engineer"],
  }
  for (const role of Object.keys(table) as Array<Exclude<Role, "other">>) {
    if (table[role].some((alias) => alias.toLowerCase() === id)) return role
  }
  return "other"
}

export const ROLE_PREFIX: Record<Exclude<Role, "other">, string> = {
  engineer: "Eng.",
  coordinator: "Coord.",
  "product-manager": "PM",
}

export interface TitleModel {
  id?: string
  providerID?: string
  variant?: string
}

export function modelLabel(model?: TitleModel | null): string {
  const id = model?.id?.trim()
  if (!id) return ""
  const variant = model?.variant?.trim()
  return (variant ? `${id}#${variant}` : id).replace(/\s+/g, " ").slice(0, 60)
}

// Eng. Name Model, Coord. Name Model, PM Name Model. Other roles have no managed title.
export function roleSessionTitle(role: Role, name: string | undefined, model?: TitleModel | null): string | undefined {
  if (role === "other") return undefined
  const who = name?.trim().replace(/\s+/g, " ")
  if (!who) return undefined
  const label = modelLabel(model)
  const prefix = ROLE_PREFIX[role]
  return (label ? `${prefix} ${who} ${label}` : `${prefix} ${who}`).slice(0, 120)
}
