import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"

const roleNames = z.union([z.string(), z.array(z.string())]).transform((v) => (Array.isArray(v) ? v : [v]))

export const profileSchema = z.object({
  roles: z.object({
    coordinator: roleNames.default(["coordinator"]),
    "product-manager": roleNames.default(["product-manager", "pm"]),
    engineer: roleNames.default(["engineer"]),
  }).default({ coordinator: ["coordinator"], "product-manager": ["product-manager", "pm"], engineer: ["engineer"] }),
  /** Names a CLI or Claude Code identity may declare for a role (`coordination call --as <name>`). Any other name is `other`. */
  cli: z.object({
    coordinator: roleNames.default([]),
    "product-manager": roleNames.default([]),
    engineer: roleNames.default([]),
  }).default({ coordinator: [], "product-manager": [], engineer: [] }),
  blockMinutes: z.number().int().min(1).default(60),
  fronts: z.array(z.object({ id: z.string(), title: z.string() })).default([]),
  github: z.object({
    repo: z.string().optional(),
    baseBranch: z.string().min(1).default("main"),
    syncMinutes: z.number().int().min(1).default(3),
    agentLine: z.boolean().default(false),
  }).default({ baseBranch: "main", syncMinutes: 3, agentLine: false }),
  prompt: z.object({ rules: z.array(z.string()).default([]) }).default({ rules: [] }),
  render: z.object({
    active: z.string().default("docs/coordination/ACTIVE.md"),
    board: z.string().default("docs/coordination/BOARD.md"),
    roadmap: z.string().default("docs/coordination/ROADMAP.md"),
    status: z.string().default("docs/coordination/STATUS.md"),
    snapshot: z.string().default("docs/coordination/snapshot.json"),
    auto: z.boolean().default(false),
  }).default({ auto: false, active: "docs/coordination/ACTIVE.md", board: "docs/coordination/BOARD.md", roadmap: "docs/coordination/ROADMAP.md", status: "docs/coordination/STATUS.md", snapshot: "docs/coordination/snapshot.json" }),
  names: z.object({ releaseAfterHours: z.number().min(1).default(24) }).default({ releaseAfterHours: 24 }),
  limits: z.object({
    noteChars: z.number().int().default(2000),
    upkeepShare: z.number().min(0).max(1).default(0.34),
    openItemsPerEngineer: z.number().int().min(1).default(1),
    burstPerMinute: z.number().int().default(6),
    goneAfterMinutes: z.number().int().default(30),
  }).default({ noteChars: 2000, upkeepShare: 0.34, openItemsPerEngineer: 1, burstPerMinute: 6, goneAfterMinutes: 30 }),
  freezeExempt: z.array(z.string()).default([]),
}).strict()

export type Profile = z.infer<typeof profileSchema>

export const PROFILE_FILE = ".opencode/coordination.json"

/** The role the profile grants to a declared (CLI or Claude Code) identity; `other` when the name is not listed. */
export function declaredRole(profile: Profile, name: string): "coordinator" | "product-manager" | "engineer" | "other" {
  const n = name.trim().toLowerCase()
  for (const role of ["coordinator", "product-manager", "engineer"] as const) {
    if (profile.cli[role].some((x) => x.toLowerCase() === n)) return role
  }
  return "other"
}

export function defaultProfile(): Profile {
  return profileSchema.parse({})
}

export function parseProfile(raw: unknown): Profile {
  return profileSchema.parse(raw)
}

/** Reads <project>/.opencode/coordination.json. A missing file is the default profile; a bad file is an error. */
export function loadProfile(projectDir: string): Profile {
  const file = join(projectDir, PROFILE_FILE)
  if (!existsSync(file)) return defaultProfile()
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseProfile(raw)
}
