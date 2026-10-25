import { randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { openDb, type Db } from "./adapter.ts"
import { dropProjections, migrate } from "./schema.ts"
import { project, type StoredEvent } from "./projections.ts"
import type { Actor, AgentDoc, DecisionDoc, HoldDoc, Item, MeasureDoc, MessageDoc } from "../domain/types.ts"

export type { StoredEvent } from "./projections.ts"

export interface AppendInput {
  type: string
  actor: Actor
  subject?: string
  payload?: Record<string, unknown>
  refs?: string[]
  /** Only for imports: the original time of the event. */
  at?: string
}

export interface EventFilter {
  type?: string
  subject?: string
  actorSession?: string
  actorName?: string
  since?: string
  limit?: number
  newestFirst?: boolean
}

export type Resolved<T> = { found: T } | { ambiguous: string[] } | { missing: true }

export class Ledger {
  readonly db: Db
  readonly scope: string
  /** The single source of event time. The runtime uses the same function, so clock and ledger never disagree. */
  readonly now: () => Date
  #lastMs = 0
  #lastSeq = 0

  private constructor(db: Db, scope: string, now: () => Date) {
    this.db = db
    this.scope = scope
    this.now = now
    migrate(db)
  }

  static async open(path: string, scope: string, options: { now?: () => Date } = {}): Promise<Ledger> {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    return new Ledger(await openDb(path), scope, options.now ?? (() => new Date()))
  }

  close(): void {
    this.db.close()
  }

  /** A short sortable id built from the clock: milliseconds since the epoch in base 36, unique in this table. */
  newId(prefix: string, table: string, column = "id", nowMs = this.now().getTime()): string {
    let ms = nowMs
    for (;;) {
      const id = `${prefix}${ms.toString(36)}`
      if (!this.db.get(`SELECT 1 AS x FROM ${table} WHERE ${column} = ?`, id)) return id
      ms += 1
    }
  }

  /** A random 16-hex message id: its first 8 characters are the citable short form. */
  newMessageId(): string {
    for (;;) {
      const id = randomBytes(8).toString("hex")
      if (!this.db.get("SELECT 1 AS x FROM messages WHERE id = ?", id)) return id
    }
  }

  #eventId(at: string): string {
    const ms = Date.parse(at)
    if (ms === this.#lastMs) this.#lastSeq += 1
    else {
      this.#lastMs = ms
      this.#lastSeq = 0
    }
    return `${ms}${String(this.#lastSeq).padStart(2, "0")}`
  }

  append(input: AppendInput): StoredEvent {
    return this.appendMany([input])[0] as StoredEvent
  }

  /** Appends events and projects them in one transaction. Nothing is half-written. */
  appendMany(inputs: AppendInput[]): StoredEvent[] {
    return this.db.transaction(() => {
      const stored: StoredEvent[] = []
      for (const input of inputs) {
        const at = input.at ?? this.now().toISOString()
        let id = this.#eventId(at)
        while (this.db.get("SELECT 1 AS x FROM events WHERE id = ?", id)) {
          this.#lastSeq += 1
          id = `${this.#lastMs}${String(this.#lastSeq).padStart(2, "0")}`
        }
        const payload = input.payload ?? {}
        const refs = input.refs ?? []
        this.db.run(
          "INSERT INTO events (id, at, scope, actor_session, actor_name, actor_role, type, subject, payload, refs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          id, at, this.scope, input.actor.session, input.actor.name, input.actor.role, input.type, input.subject ?? null,
          JSON.stringify(payload), JSON.stringify(refs),
        )
        const seq = (this.db.get<{ seq: number }>("SELECT seq FROM events WHERE id = ?", id) as { seq: number }).seq
        const event: StoredEvent = { seq, id, at, scope: this.scope, actor: input.actor, type: input.type, subject: input.subject, payload: payload as Record<string, any>, refs }
        project(this.db, event)
        stored.push(event)
      }
      return stored
    })
  }

  /** Recomputes every projection from the events. The events are not touched. */
  rebuild(): number {
    return this.db.transaction(() => {
      dropProjections(this.db)
      let count = 0
      for (const row of this.db.all<EventRow>("SELECT * FROM events ORDER BY seq")) {
        project(this.db, fromRow(row))
        count++
      }
      return count
    })
  }

  // ---- reads ---------------------------------------------------------------------------------------------------

  events(filter: EventFilter = {}): StoredEvent[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.type) {
      // A trailing * is a prefix; otherwise the type is matched exactly (LIKE would read _ as a wildcard).
      if (filter.type.endsWith("*")) { where.push("type LIKE ?"); params.push(`${filter.type.slice(0, -1)}%`) }
      else { where.push("type = ?"); params.push(filter.type) }
    }
    if (filter.subject) { where.push("subject = ?"); params.push(filter.subject) }
    if (filter.actorSession) { where.push("actor_session = ?"); params.push(filter.actorSession) }
    if (filter.actorName) { where.push("lower(actor_name) = lower(?)"); params.push(filter.actorName) }
    if (filter.since) { where.push("at >= ?"); params.push(filter.since) }
    const order = filter.newestFirst ? "DESC" : "ASC"
    const limit = filter.limit ? ` LIMIT ${Math.max(1, Math.floor(filter.limit))}` : ""
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq ${order}${limit}`
    return this.db.all<EventRow>(sql, ...params).map(fromRow)
  }

  lastEventId(): string {
    return this.db.get<{ id: string }>("SELECT id FROM events ORDER BY seq DESC LIMIT 1")?.id ?? "0"
  }

  eventCount(): number {
    return (this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events") as { n: number }).n
  }

  item(id: string): Item | undefined {
    const row = this.db.get<{ doc: string }>("SELECT doc FROM items WHERE id = ?", id)
    return row ? (JSON.parse(row.doc) as Item) : undefined
  }

  resolveItem(query: string): Resolved<Item> {
    const exact = this.item(query)
    if (exact) return { found: exact }
    const rows = this.db.all<{ id: string }>("SELECT id FROM items WHERE id LIKE ? ORDER BY id", `${query}%`)
    if (rows.length === 1) return { found: this.item((rows[0] as { id: string }).id) as Item }
    if (rows.length > 1) return { ambiguous: rows.map((row) => row.id) }
    return { missing: true }
  }

  items(filter: (item: Item) => boolean = () => true): Item[] {
    return this.db.all<{ doc: string }>("SELECT doc FROM items ORDER BY id").map((row) => JSON.parse(row.doc) as Item).filter(filter)
  }

  agent(sessionID: string): AgentDoc | undefined {
    const row = this.db.get<{ doc: string }>("SELECT doc FROM agents WHERE session_id = ?", sessionID)
    return row ? (JSON.parse(row.doc) as AgentDoc) : undefined
  }

  agents(filter: (agent: AgentDoc) => boolean = () => true): AgentDoc[] {
    return this.db.all<{ doc: string }>("SELECT doc FROM agents ORDER BY seen_at DESC").map((row) => JSON.parse(row.doc) as AgentDoc).filter(filter)
  }

  /** An agent answers to its name, its former name, its session id or its title, without regard to case. */
  findAgents(query: string): AgentDoc[] {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return this.agents((agent) => agent.status !== "gone" && [agent.name, agent.formerName, agent.sessionID].some((value) => value?.toLowerCase() === q))
  }

  usedNames(): Set<string> {
    return new Set(this.db.all<{ name: string }>("SELECT name FROM agents").map((row) => row.name))
  }

  message(id: string): MessageDoc | undefined {
    const row = this.db.get<{ doc: string }>("SELECT doc FROM messages WHERE id = ?", id)
    return row ? (JSON.parse(row.doc) as MessageDoc) : undefined
  }

  /** The full id or its first 8 characters. Never prunes, so an old id still resolves. */
  resolveMessage(query: string): Resolved<MessageDoc> {
    const exact = this.message(query)
    if (exact) return { found: exact }
    if (!/^[A-Za-z0-9-]{8,100}$/.test(query)) return { missing: true }
    const rows = this.db.all<{ id: string }>("SELECT id FROM messages WHERE id LIKE ? ORDER BY id", `${query}%`)
    if (rows.length === 1) return { found: this.message((rows[0] as { id: string }).id) as MessageDoc }
    if (rows.length > 1) return { ambiguous: rows.map((row) => row.id) }
    return { missing: true }
  }

  messages(filter: { toId?: string; fromId?: string; item?: string; contains?: string; fromName?: string; limit?: number } = {}): MessageDoc[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.toId) { where.push("to_id = ?"); params.push(filter.toId) }
    if (filter.fromId) { where.push("from_id = ?"); params.push(filter.fromId) }
    if (filter.item) { where.push("item = ?"); params.push(filter.item) }
    const sql = `SELECT doc FROM messages ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, id DESC`
    let docs = this.db.all<{ doc: string }>(sql, ...params).map((row) => JSON.parse(row.doc) as MessageDoc)
    const contains = filter.contains?.toLowerCase()
    const fromName = filter.fromName?.toLowerCase()
    if (contains) docs = docs.filter((m) => m.text.toLowerCase().includes(contains))
    if (fromName) docs = docs.filter((m) => m.from.name.toLowerCase().includes(fromName))
    return filter.limit ? docs.slice(0, filter.limit) : docs
  }

  /** Messages for these mailboxes (a session id, and `role:<role>` for a role nobody held yet) not yet delivered. */
  claimPending(mailboxes: string | string[], now: Date, reserveMs = 30_000): MessageDoc[] {
    const ids = Array.isArray(mailboxes) ? mailboxes : [mailboxes]
    const marks = ids.map(() => "?").join(", ")
    return this.db.transaction(() => {
      const rows = this.db.all<{ doc: string; id: string }>(
        `SELECT id, doc FROM messages WHERE to_id IN (${marks}) AND delivered = 0 AND (reserved_until IS NULL OR reserved_until < ?) ORDER BY at, id`,
        ...ids, now.toISOString(),
      )
      const until = new Date(now.getTime() + reserveMs).toISOString()
      for (const row of rows) this.db.run("UPDATE messages SET reserved_until = ? WHERE id = ?", until, row.id)
      return rows.map((row) => JSON.parse(row.doc) as MessageDoc)
    })
  }

  pendingCount(mailboxes: string[]): number {
    const marks = mailboxes.map(() => "?").join(", ")
    return (this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE to_id IN (${marks}) AND delivered = 0`, ...mailboxes) as { n: number }).n
  }

  messagesBetween(fromId: string, toId: string, sinceIso: string): MessageDoc[] {
    return this.db.all<{ doc: string }>("SELECT doc FROM messages WHERE from_id = ? AND to_id = ? AND at >= ? ORDER BY at", fromId, toId, sinceIso)
      .map((row) => JSON.parse(row.doc) as MessageDoc)
  }

  releaseReservation(id: string): void {
    this.db.run("UPDATE messages SET reserved_until = NULL WHERE id = ?", id)
  }

  undeliveredCount(): number {
    return (this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE delivered = 0") as { n: number }).n
  }

  openQuestions(): MessageDoc[] {
    return this.db.all<{ doc: string }>("SELECT doc FROM messages WHERE answered = 0 AND needs_answer_by IS NOT NULL ORDER BY needs_answer_by")
      .map((row) => JSON.parse(row.doc) as MessageDoc)
  }

  decision(id: string): DecisionDoc | undefined {
    const row = this.db.get<{ doc: string }>("SELECT doc FROM decisions WHERE id = ?", id)
    return row ? (JSON.parse(row.doc) as DecisionDoc) : undefined
  }

  decisions(): DecisionDoc[] {
    return this.db.all<{ doc: string }>("SELECT doc FROM decisions ORDER BY id").map((row) => JSON.parse(row.doc) as DecisionDoc)
  }

  holds(activeOnly = true): HoldDoc[] {
    const sql = activeOnly ? "SELECT doc FROM holds WHERE active = 1 ORDER BY id" : "SELECT doc FROM holds ORDER BY id"
    return this.db.all<{ doc: string }>(sql).map((row) => JSON.parse(row.doc) as HoldDoc)
  }

  measures(name?: string): MeasureDoc[] {
    const rows = name
      ? this.db.all<{ doc: string }>("SELECT doc FROM measures WHERE name = ? ORDER BY at, id", name)
      : this.db.all<{ doc: string }>("SELECT doc FROM measures ORDER BY at, id")
    return rows.map((row) => JSON.parse(row.doc) as MeasureDoc)
  }

  incidents(): Array<Record<string, unknown>> {
    return this.db.all<{ doc: string }>("SELECT doc FROM incidents ORDER BY id").map((row) => JSON.parse(row.doc))
  }

  ownerOrders(): Array<Record<string, unknown>> {
    return this.db.all<{ doc: string }>("SELECT doc FROM owner_orders ORDER BY id").map((row) => JSON.parse(row.doc))
  }

  summaries(): Array<{ kind: string; key: string; text: string; at: string }> {
    return this.db.all<{ doc: string }>("SELECT doc FROM summaries ORDER BY key").map((row) => JSON.parse(row.doc))
  }

  parkedFronts(): Record<string, { reason: string; unparkOn: string }> {
    const out: Record<string, { reason: string; unparkOn: string }> = {}
    for (const row of this.db.all<{ id: string; doc: string }>("SELECT id, doc FROM fronts")) out[row.id] = JSON.parse(row.doc)
    return out
  }

  meta(key: string): string | undefined {
    return this.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value
  }

  setMeta(key: string, value: string): void {
    this.db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value)
  }
}

interface EventRow {
  seq: number
  id: string
  at: string
  scope: string
  actor_session: string
  actor_name: string
  actor_role: string
  type: string
  subject: string | null
  payload: string
  refs: string
}

function fromRow(row: EventRow): StoredEvent {
  return {
    seq: row.seq, id: row.id, at: row.at, scope: row.scope,
    actor: { session: row.actor_session, name: row.actor_name, role: row.actor_role as Actor["role"] },
    type: row.type, subject: row.subject ?? undefined, payload: JSON.parse(row.payload), refs: JSON.parse(row.refs),
  }
}
