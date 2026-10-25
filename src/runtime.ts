import type { Ledger } from "./ledger/ledger.ts"
import type { Profile } from "./config/profile.ts"
import type { Actor, AgentDoc, MessageDoc, MessageKind, Party, Role } from "./domain/types.ts"
import { roleOf, type TitleModel } from "./domain/roles.ts"
import { NAME_POOL } from "./domain/names.ts"
import { SYSTEM_ACTOR } from "./domain/system.ts"

/** What the plugin needs from the host session API. Implemented by src/host/opencode.ts, faked in tests. */
export interface HostControl {
  /** Delivers text into a session as a steering message. */
  deliver(sessionID: string, text: string): Promise<void>
  /** Replaces an engineer session with an empty one that keeps name, role, model and directory; the caller then delivers the assignment. Absent on hosts that cannot. */
  replaceSession?(input: { sessionID: string; name: string; agent: string; directory: string }): Promise<{ sessionID: string; removed: boolean }>
  /** Which of these sessions the host still knows, for gone detection. Absent: gone detection is skipped. */
  liveSessions?(candidates: string[]): Promise<Set<string>>
  setTitle?(sessionID: string, title: string): Promise<void>
}

export interface ClaudePeer {
  pid: number
  sessionId: string
  name: string
  cwd: string
  status: string
  socketPath: string
  reachable: boolean
}

/** The Claude Code side: implemented by src/bridge/bridge.ts. */
export interface ClaudeLink {
  address: string
  listPeers(): Promise<ClaudePeer[]>
  send(peer: ClaudePeer, text: string, fromName: string, msgId: string): Promise<"accepted" | "uncertain">
}

export interface PrInfo {
  number: number
  isDraft: boolean
  head: string
  containsMain: boolean
  mergedAt?: string
  mergeCommit?: string
}

/** The GitHub side: implemented by src/github/sync.ts. */
export interface GitHubLink {
  prForItem(branch: string | undefined, pr: number | undefined): Promise<PrInfo | undefined>
  recordOnMain(path: string): Promise<boolean>
}

export interface Runtime {
  ledger: Ledger
  profile: Profile
  now(): Date
  host?: HostControl
  claude?: ClaudeLink
  github?: GitHubLink
  /** Wake the process that owns a session's inbox (CLI → plugin). */
  wake?(sessionID: string): void
}

export class ToolFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ToolFailure"
  }
}

export function fail(message: string): never {
  throw new ToolFailure(message)
}

export function blockMs(rt: Runtime): number {
  return rt.profile.blockMinutes * 60_000
}

export function partyOf(agent: AgentDoc): Party {
  return { kind: agent.kind, id: agent.sessionID, name: agent.name }
}

export function actorParty(actor: Actor, kind: Party["kind"] = "opencode"): Party {
  return { kind, id: actor.session, name: actor.name }
}

export interface Registration {
  sessionID: string
  agent: string
  directory: string
  model?: TitleModel
  kind?: "opencode" | "claude" | "cli"
  role?: Role
  status?: "busy" | "idle"
  /** The parent session of a subagent. A child session never holds a role, whatever agent it runs. */
  parent?: string
}

/**
 * Records that a session exists and gives it a stable human name the first time. Returns the agent as projected.
 * The role is bound to the agent the session started with: a later agent switch does not change it (the attempt is
 * recorded as agent.role_denied), and a subagent is always `other`.
 */
export function registerSession(rt: Runtime, input: Registration): AgentDoc {
  const existing = rt.ledger.agent(input.sessionID)
  const offered = input.parent ? "other" : input.role ?? roleOf(input.agent, rt.profile.roles)
  const pinned = existing && existing.role !== "other" && offered !== existing.role
  const role = pinned ? existing.role : offered
  const actor: Actor = { session: input.sessionID, name: existing?.name ?? input.sessionID, role }
  if (pinned && existing.agent !== input.agent) {
    rt.ledger.append({ type: "agent.role_denied", actor, payload: { sessionID: input.sessionID, agent: input.agent, offered, kept: existing.role } })
  }
  const model = input.model?.id ? (input.model.variant ? `${input.model.id}#${input.model.variant}` : input.model.id) : undefined
  const status = input.status ?? "busy"
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [{
    type: "agent.seen",
    payload: { sessionID: input.sessionID, role, agent: input.agent, model, directory: input.directory, status, kind: input.kind ?? "opencode" },
  }]
  const needsName = !existing || existing.name === existing.sessionID || existing.status === "gone"
  // A session that says the same thing within a minute adds nothing to the ledger: a turn is not an event.
  if (existing && !needsName && existing.role === role && existing.agent === input.agent && existing.directory === input.directory && existing.model === model && existing.status === status && rt.now().getTime() - Date.parse(existing.seenAt) < 60_000) return existing
  if (needsName && role !== "other") events.push({ type: "agent.named", payload: { sessionID: input.sessionID, name: claimName(rt, input.sessionID, existing?.name) } })
  rt.ledger.appendMany(events.map((event) => ({ ...event, actor })))
  return rt.ledger.agent(input.sessionID) as AgentDoc
}

// Pool names are claimed by role sessions only. Subagents and helper sessions keep their session id as name and never
// use up the pool. A name whose session has been gone longer than the profile says goes back to the pool. A session
// that comes back keeps its own name while nobody else holds it.
function claimName(rt: Runtime, sessionID: string, former?: string): string {
  const cutoff = rt.now().getTime() - rt.profile.names.releaseAfterHours * 3_600_000
  const held = new Set<string>()
  for (const agent of rt.ledger.agents()) {
    if (agent.sessionID === sessionID) continue
    const released = agent.status === "gone" && Date.parse(agent.seenAt) < cutoff
    if (!released) held.add(agent.name.replace(/ \(retired\)$/, ""))
  }
  const own = former?.replace(/ \(retired\)$/, "")
  if (own && own !== sessionID && !held.has(own)) return own
  const free = NAME_POOL.find((name) => !held.has(name))
  if (free) return free
  let n = held.size + 1
  while (held.has(`Agent${n}`)) n++
  return `Agent${n}`
}

export function actorFor(rt: Runtime, sessionID: string, fallbackAgent = ""): Actor {
  const agent = rt.ledger.agent(sessionID)
  return { session: sessionID, name: agent?.name ?? sessionID, role: agent?.role ?? roleOf(fallbackAgent, rt.profile.roles) }
}

export type Target = { kind: "agent"; agent: AgentDoc } | { kind: "claude"; peer: ClaudePeer } | { kind: "role"; role: Role }

/** The words that name a role: the canonical names, pm, and the profile's agent aliases. */
function roleWord(rt: Runtime, word: string): Role | undefined {
  const w = word.toLowerCase()
  if (w === "pm") return "product-manager"
  for (const role of ["coordinator", "product-manager", "engineer"] as const) {
    if (w === role || rt.profile.roles[role].some((alias) => alias.toLowerCase() === w)) return role
  }
  return undefined
}

/** Finds who a name means: a role word, an agent in this ledger, or a Claude Code peer. Ambiguity is an error. */
export async function resolveTarget(rt: Runtime, query: string, self?: string): Promise<Target> {
  const q = query.trim()
  const prefixed = /^(opencode|claude|role):(.*)$/i.exec(q)
  const scope = prefixed?.[1]?.toLowerCase()
  const name = (prefixed?.[2] ?? q).trim()
  if (scope === "role" || (!scope && roleWord(rt, name) && rt.ledger.findAgents(name).length === 0)) {
    const role = roleWord(rt, name)
    if (!role) fail(`Unknown role ${JSON.stringify(name)}.`)
    return { kind: "role", role }
  }
  const locals = scope === "claude" ? [] : rt.ledger.findAgents(name).filter((agent) => agent.sessionID !== self)
  const peers = scope === "opencode" || !rt.claude ? [] : (await rt.claude.listPeers()).filter((peer) => peer.name === name || peer.sessionId === name || String(peer.pid) === name || `pid:${peer.pid}` === name)
  const hits = locals.length + peers.length
  if (hits === 0) {
    const known = rt.ledger.agents((a) => a.status !== "gone" && a.sessionID !== self).map((a) => a.name).slice(0, 12)
    fail(`No peer named ${JSON.stringify(name)}. Call coordination_peers. Known names: ${known.join(", ") || "none yet"}.`)
  }
  if (hits > 1) {
    const choices = [...locals.map((a) => `opencode:${a.name} (${a.sessionID})`), ...peers.map((p) => `claude:${p.name} (pid:${p.pid})`)]
    fail(`More than one peer matches ${JSON.stringify(name)}. Use a prefix: ${choices.join("; ")}.`)
  }
  if (locals[0]) return { kind: "agent", agent: locals[0] }
  return { kind: "claude", peer: peers[0] as ClaudePeer }
}

export interface PostInput {
  from: Party
  to: Party
  kind: MessageKind
  text: string
  item?: string
  /** Set to arm the clock: the answer is due in one block. */
  needsAnswer?: boolean
  transport?: MessageDoc["transport"]
  inReplyTo?: string
  actor: Actor
}

export const MAX_TEXT = 8000

/** Records a message and returns it. Delivery happens when the recipient pulls, or right away for a Claude peer. */
export function post(rt: Runtime, input: PostInput): MessageDoc {
  if (!input.text.trim()) fail("A message needs text.")
  if (input.text.length > MAX_TEXT) fail(`The message is ${input.text.length} characters; the limit is ${MAX_TEXT}. Attach details with coordination_note and send the id.`)
  // The burst gate is for agents. The plugin's own follow-ups (resends, clock notes) are never refused by it.
  if (input.from.kind !== "system" && input.actor.session !== SYSTEM_ACTOR.session && input.kind !== "broadcast") {
    const now = rt.now().getTime()
    const recent = rt.ledger.messagesBetween(input.from.id, input.to.id, new Date(now - 60_000).toISOString())
    if (recent.some((m) => m.text === input.text && now - Date.parse(m.at) < 20_000)) fail("The same message was just sent to that peer. It was not sent again.")
    if (recent.length >= rt.profile.limits.burstPerMinute) fail("Too many messages to that peer in the last minute. Wait, or fold them into one later message.")
  }
  const id = rt.ledger.newMessageId()
  const needsAnswerBy = input.needsAnswer ? new Date(rt.now().getTime() + blockMs(rt)).toISOString() : undefined
  rt.ledger.append({
    type: "message.sent",
    actor: input.actor,
    subject: input.item,
    payload: {
      id, kind: input.kind, from: input.from, to: input.to, item: input.item, text: input.text, needsAnswerBy,
      transport: input.transport ?? (input.to.kind === "claude" ? "claude" : input.to.kind === "cli" ? "cli" : "opencode"), inReplyTo: input.inReplyTo,
    },
    refs: [id.slice(0, 8), ...(input.item ? [input.item] : [])],
  })
  return rt.ledger.message(id) as MessageDoc
}

/** Posts to every live agent holding a role; with none, to the role mailbox that the first holder will receive. */
export function postToRole(rt: Runtime, role: Role, input: Omit<PostInput, "to">, exclude?: string): MessageDoc[] {
  const holders = rt.ledger.agents((a) => a.role === role && a.status !== "gone" && a.sessionID !== exclude)
  const targets: Party[] = holders.length ? holders.map(partyOf) : [{ kind: "system", id: `role:${role}`, name: role }]
  return targets.map((to) => post(rt, { ...input, to }))
}

export function markAnswered(rt: Runtime, ids: string[], by: Actor): void {
  for (const id of ids) rt.ledger.append({ type: "message.answered", actor: by, payload: { id, by: by.session } })
}

/** Closes the open messages about an item that were addressed to `recipient` (a session id or role mailbox). */
export function answerOpen(rt: Runtime, item: string, recipients: string[], by: Actor, kinds?: string[]): string[] {
  const open = rt.ledger.messages({ item }).filter((m) => !m.answeredBy && m.needsAnswerBy && recipients.includes(m.to.id) && (!kinds || kinds.includes(m.kind)))
  markAnswered(rt, open.map((m) => m.id), by)
  return open.map((m) => m.id)
}

export function mailboxes(rt: Runtime, sessionID: string): string[] {
  const role = rt.ledger.agent(sessionID)?.role
  return role && role !== "other" ? [sessionID, `role:${role}`] : [sessionID]
}
