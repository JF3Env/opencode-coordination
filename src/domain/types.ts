export type Role = "coordinator" | "product-manager" | "engineer" | "other"

export const ITEM_STATES = [
  "proposed", "accepted", "ready", "assigned", "in_progress", "in_review", "merged", "measured", "validated",
  "blocked", "deferred", "rejected", "cancelled",
] as const
export type ItemState = (typeof ITEM_STATES)[number]

export const ITEM_KINDS = ["feature", "fix", "measure", "review", "upkeep", "process", "breakdown"] as const
export type ItemKind = (typeof ITEM_KINDS)[number]

export type Stage = "planned" | "specified" | "implemented" | "tested" | "validated"

export interface Party {
  kind: "opencode" | "claude" | "cli" | "system"
  id: string
  name: string
  address?: string
}

export interface Actor {
  session: string
  name: string
  role: Role
}

export interface Outcome {
  moves?: string
  upkeep?: string
  enables?: string
}

export interface Result {
  before: string
  after: string
  record: string
  verdict: "met" | "missed" | "inconclusive"
}

export interface Item {
  id: string
  title: string
  kind: ItemKind
  front?: string
  outcome: Outcome
  predicted?: string
  decidedBy?: string
  state: ItemState
  previousState?: ItemState
  assignee?: string
  assigneeName?: string
  engineerKind: "opencode" | "claude"
  engineerKindWhy?: string
  branch?: string
  worktree?: string
  pr?: number
  headSha?: string
  containsMain?: boolean
  scopeFiles: string[]
  identifiers: string[]
  constraints?: string
  doneWhen?: string
  parent?: string
  estimate?: [number, number]
  priority?: number
  result?: Result
  stages: Partial<Record<Stage, { at: string; commit?: string }>>
  blockedOn?: string
  unblockOn?: string
  lastEventAt: string
  lastProgressAt?: string
  progress?: string
  createdAt: string
  proposedBy?: string
  notes: Array<{ at: string; by: string; text: string }>
  /** commentAt is the GitHub time of the steward comment the verdict was read from, when it came from one. */
  verdict?: { at: string; verdict: "approved" | "changes"; findings: string; commentAt?: string }
}

export interface AgentDoc {
  sessionID: string
  name: string
  formerName?: string
  role: Role
  agent: string
  model?: string
  directory: string
  status: "busy" | "idle" | "gone"
  seenAt: string
  currentItem?: string
  available?: boolean
  availableAt?: string
  kind: "opencode" | "claude" | "cli"
}

export type MessageKind = "ask" | "answer" | "note" | "owner_order" | "safety" | "incident" | "broadcast" | "rendered"

export interface MessageDoc {
  id: string
  short: string
  kind: MessageKind
  from: Party
  to: Party
  item?: string
  text: string
  at: string
  needsAnswerBy?: string
  answeredBy?: string
  reminded: number
  escalated: boolean
  delivered: boolean
  transport: "opencode" | "claude" | "cli" | "imported" | "system"
  inReplyTo?: string
}

export interface HoldDoc {
  id: string
  kind: "hold" | "freeze"
  paths: string[]
  prs: number[]
  reason: string
  liftOn: string
  declaredAt: string
  liftedAt?: string
  by: string
}

export interface DecisionDoc {
  id: string
  text: string
  why: string
  conditions: string
  carriedBy: Role
  at: string
  by: string
  answer?: "done" | "cannot" | "accepted" | "in_progress"
  answerReason?: string
  items: string[]
}

export interface MeasureDoc {
  id: string
  name: string
  front?: string
  value: string
  unit: string
  record: string
  commit?: string
  at: string
  measuredBy: string
  sensitiveTo?: string
  blindTo?: string
  claimed?: boolean
}
