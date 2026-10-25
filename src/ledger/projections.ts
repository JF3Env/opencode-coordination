import type { Db } from "./adapter.ts"
import type { Actor, AgentDoc, DecisionDoc, HoldDoc, Item, MeasureDoc, MessageDoc, Stage } from "../domain/types.ts"
import { withStage } from "../domain/items.ts"

export interface StoredEvent {
  seq: number
  id: string
  at: string
  scope: string
  actor: Actor
  type: string
  subject?: string
  payload: Record<string, any>
  refs: string[]
}

function read<T>(db: Db, table: string, key: string, id: string): T | undefined {
  const row = db.get<{ doc: string }>(`SELECT doc FROM ${table} WHERE ${key} = ?`, id)
  return row ? (JSON.parse(row.doc) as T) : undefined
}

function saveItem(db: Db, item: Item): void {
  db.run(
    "INSERT INTO items (id, state, assignee, front, doc) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, assignee = excluded.assignee, front = excluded.front, doc = excluded.doc",
    item.id, item.state, item.assignee ?? null, item.front ?? null, JSON.stringify(item),
  )
}

function saveAgent(db: Db, agent: AgentDoc): void {
  db.run(
    "INSERT INTO agents (session_id, name, role, status, seen_at, doc) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET name = excluded.name, role = excluded.role, status = excluded.status, seen_at = excluded.seen_at, doc = excluded.doc",
    agent.sessionID, agent.name, agent.role, agent.status, agent.seenAt, JSON.stringify(agent),
  )
}

function saveMessage(db: Db, message: MessageDoc, reservedUntil?: string | null): void {
  const existing = db.get<{ reserved_until: string | null }>("SELECT reserved_until FROM messages WHERE id = ?", message.id)
  db.run(
    `INSERT INTO messages (id, short, to_id, from_id, item, kind, at, delivered, reserved_until, needs_answer_by, answered, doc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET delivered = excluded.delivered, reserved_until = excluded.reserved_until,
       needs_answer_by = excluded.needs_answer_by, answered = excluded.answered, doc = excluded.doc`,
    message.id, message.short, message.to.id, message.from.id, message.item ?? null, message.kind, message.at,
    message.delivered ? 1 : 0, reservedUntil === undefined ? (existing?.reserved_until ?? null) : reservedUntil,
    message.needsAnswerBy ?? null, message.answeredBy ? 1 : 0, JSON.stringify(message),
  )
}

function mutateItem(db: Db, e: StoredEvent, fn: (item: Item) => void): void {
  const id = String(e.payload.id ?? e.subject ?? "")
  const item = read<Item>(db, "items", "id", id)
  if (!item) return
  item.lastEventAt = e.at
  fn(item)
  saveItem(db, item)
}

function setState(item: Item, state: Item["state"]): void {
  if (item.state !== state) item.previousState = item.state
  item.state = state
}

function stage(item: Item, name: Stage, e: StoredEvent, commit?: string): void {
  withStage(item, name, e.at, commit)
}

// project applies one event to the projection tables. It must be deterministic and must never read the clock or the
// network: rebuild() replays every event through it.
export function project(db: Db, e: StoredEvent): void {
  const p = e.payload
  switch (e.type) {
    case "agent.seen": {
      const existing = read<AgentDoc>(db, "agents", "session_id", p.sessionID)
      const doc: AgentDoc = {
        sessionID: p.sessionID,
        name: existing?.name ?? p.name ?? p.sessionID,
        formerName: existing?.formerName,
        role: p.role ?? existing?.role ?? "other",
        agent: p.agent ?? existing?.agent ?? "",
        model: p.model ?? existing?.model,
        directory: p.directory ?? existing?.directory ?? "",
        status: p.status ?? "busy",
        seenAt: e.at,
        available: existing?.available,
        availableAt: existing?.availableAt,
        kind: p.kind ?? existing?.kind ?? "opencode",
      }
      saveAgent(db, doc)
      return
    }
    case "agent.named": {
      const doc = read<AgentDoc>(db, "agents", "session_id", p.sessionID)
      if (!doc) return
      if (doc.name !== p.name) doc.formerName = p.formerName ?? doc.name
      doc.name = p.name
      saveAgent(db, doc)
      return
    }
    case "agent.status": {
      const doc = read<AgentDoc>(db, "agents", "session_id", p.sessionID)
      if (!doc) return
      doc.status = p.status
      doc.seenAt = e.at
      saveAgent(db, doc)
      return
    }
    case "agent.available": {
      const doc = read<AgentDoc>(db, "agents", "session_id", e.actor.session)
      if (!doc) return
      doc.available = true
      doc.availableAt = e.at
      saveAgent(db, doc)
      return
    }
    case "agent.gone": {
      const doc = read<AgentDoc>(db, "agents", "session_id", p.sessionID)
      if (!doc) return
      doc.status = "gone"
      doc.seenAt = e.at
      saveAgent(db, doc)
      return
    }
    case "agent.renamed": {
      const old = read<AgentDoc>(db, "agents", "session_id", p.fromID)
      if (!old) return
      const next: AgentDoc = { ...old, sessionID: p.toID, status: "busy", seenAt: e.at }
      saveAgent(db, next)
      saveAgent(db, { ...old, status: "gone", seenAt: e.at, name: `${old.name} (retired)` })
      for (const row of db.all<{ doc: string }>("SELECT doc FROM items WHERE assignee = ?", p.fromID)) {
        const item = JSON.parse(row.doc) as Item
        item.assignee = p.toID
        saveItem(db, item)
      }
      return
    }
    case "message.sent": {
      const message: MessageDoc = {
        id: p.id, short: p.id.slice(0, 8), kind: p.kind, from: p.from, to: p.to, item: p.item, text: p.text, at: e.at,
        needsAnswerBy: p.needsAnswerBy, reminded: 0, escalated: false, delivered: Boolean(p.delivered), transport: p.transport,
        inReplyTo: p.inReplyTo,
      }
      saveMessage(db, message)
      return
    }
    case "message.delivered": {
      const message = read<MessageDoc>(db, "messages", "id", p.id)
      if (!message) return
      message.delivered = true
      saveMessage(db, { ...message }, null)
      return
    }
    case "message.answered": {
      const message = read<MessageDoc>(db, "messages", "id", p.id)
      if (!message) return
      message.answeredBy = p.by ?? e.actor.session
      saveMessage(db, message)
      return
    }
    case "clock.reminder": {
      const message = read<MessageDoc>(db, "messages", "id", p.id)
      if (!message) return
      message.reminded += 1
      saveMessage(db, message)
      return
    }
    case "clock.escalated": {
      const message = read<MessageDoc>(db, "messages", "id", p.id)
      if (!message) return
      message.escalated = true
      saveMessage(db, message)
      return
    }
    case "item.proposed": {
      const item: Item = {
        id: p.id, title: p.title, kind: p.kind, front: p.front, outcome: p.outcome ?? {}, predicted: p.predicted,
        decidedBy: p.decidedBy, state: "proposed", engineerKind: p.engineerKind ?? "opencode", engineerKindWhy: p.engineerKindWhy,
        scopeFiles: p.scopeFiles ?? [], identifiers: p.identifiers ?? [], constraints: p.constraints, doneWhen: p.doneWhen,
        parent: p.parent, estimate: p.estimate, stages: {}, lastEventAt: e.at, createdAt: e.at, proposedBy: e.actor.name, notes: p.proposalText ? [{ at: e.at, by: e.actor.name, text: p.proposalText }] : [],
      }
      saveItem(db, item)
      return
    }
    case "item.accepted":
      return mutateItem(db, e, (item) => {
        setState(item, "accepted")
        stage(item, "planned", e)
        if (p.conditions) item.notes.push({ at: e.at, by: e.actor.name, text: `accepted: ${p.conditions}` })
      })
    case "item.deferred":
    case "item.rejected":
    case "item.cancelled":
      return mutateItem(db, e, (item) => {
        setState(item, e.type.slice(5) as Item["state"])
        if (p.reason) item.notes.push({ at: e.at, by: e.actor.name, text: `${e.type.slice(5)}: ${p.reason}` })
      })
    case "item.refined":
      return mutateItem(db, e, (item) => {
        setState(item, "ready")
        if (p.scopeFiles) item.scopeFiles = p.scopeFiles
        if (p.doneWhen) item.doneWhen = p.doneWhen
        if (p.estimate) item.estimate = p.estimate
        if (p.constraints) item.constraints = p.constraints
        if (p.identifiers) item.identifiers = p.identifiers
      })
    case "item.assigned":
      mutateItem(db, e, (item) => {
        setState(item, "assigned")
        item.assignee = p.assignee
        item.assigneeName = p.assigneeName
        item.blockedOn = undefined
        item.unblockOn = undefined
      })
      // An engineer with work is no longer available: the clock counts idleness from the next availability.
      const assignee = p.assignee ? read<AgentDoc>(db, "agents", "session_id", p.assignee) : undefined
      if (assignee?.available) saveAgent(db, { ...assignee, available: false, availableAt: undefined })
      return
    case "item.claimed":
      return mutateItem(db, e, (item) => {
        setState(item, "in_progress")
        item.branch = p.branch
        item.worktree = p.worktree
        if (p.files?.length) item.scopeFiles = p.files
        item.lastProgressAt = e.at
        stage(item, "specified", e)
      })
    case "item.progress":
      return mutateItem(db, e, (item) => {
        item.progress = p.line
        item.lastProgressAt = e.at
      })
    case "item.note":
      return mutateItem(db, e, (item) => {
        item.notes.push({ at: e.at, by: e.actor.name, text: p.text })
      })
    case "item.pr_linked":
      return mutateItem(db, e, (item) => {
        item.pr = p.pr
      })
    case "item.in_review":
      return mutateItem(db, e, (item) => {
        setState(item, "in_review")
        stage(item, "tested", e)
        item.lastProgressAt = e.at
        if (typeof p.pr === "number") item.pr = p.pr
      })
    case "item.verdict":
      return mutateItem(db, e, (item) => {
        item.verdict = { at: e.at, verdict: p.verdict, findings: p.findings ?? "", ...(p.commentAt ? { commentAt: p.commentAt } : {}) }
      })
    case "item.returned":
      return mutateItem(db, e, (item) => {
        setState(item, "in_progress")
        item.lastProgressAt = e.at
      })
    case "item.merged":
      return mutateItem(db, e, (item) => {
        setState(item, "merged")
        stage(item, "implemented", e, p.commit)
      })
    case "item.measured":
      return mutateItem(db, e, (item) => {
        setState(item, "measured")
        item.result = p.result
      })
    case "item.validated":
      return mutateItem(db, e, (item) => {
        setState(item, "validated")
        stage(item, "validated", e)
        if (p.reference) item.notes.push({ at: e.at, by: e.actor.name, text: `validated against ${p.reference} (${p.record ?? "no record"})` })
      })
    case "item.blocked":
      return mutateItem(db, e, (item) => {
        setState(item, "blocked")
        item.blockedOn = p.on
        item.unblockOn = p.unblockOn
      })
    case "item.unblocked":
      return mutateItem(db, e, (item) => {
        const back = item.previousState && item.previousState !== "blocked" ? item.previousState : "in_progress"
        setState(item, back)
        item.blockedOn = undefined
        item.unblockOn = undefined
      })
    case "item.handed_over":
    case "item.orphaned":
    case "item.pr_closed":
      return mutateItem(db, e, (item) => {
        setState(item, "ready")
        item.assignee = undefined
        item.assigneeName = undefined
        if (p.leftToDo) item.notes.push({ at: e.at, by: e.actor.name, text: `left to do: ${p.leftToDo}` })
      })
    case "pr.synced":
      return mutateItem(db, { ...e, payload: { id: p.item } } as StoredEvent, (item) => {
        item.pr = p.pr
        item.headSha = p.head
        item.containsMain = p.containsMain
      })
    case "decision.recorded": {
      const doc: DecisionDoc = { id: p.id, text: p.text, why: p.why, conditions: p.conditions, carriedBy: p.carriedBy, at: e.at, by: e.actor.name, items: p.items ?? [] }
      db.run("INSERT OR REPLACE INTO decisions (id, doc) VALUES (?, ?)", doc.id, JSON.stringify(doc))
      return
    }
    case "decision.answered": {
      const doc = read<DecisionDoc>(db, "decisions", "id", p.id)
      if (!doc) return
      doc.answer = p.answer
      doc.answerReason = p.reason
      if (p.items) doc.items = [...new Set([...doc.items, ...p.items])]
      db.run("UPDATE decisions SET doc = ? WHERE id = ?", JSON.stringify(doc), doc.id)
      return
    }
    case "hold.declared": {
      const doc: HoldDoc = { id: p.id, kind: p.kind, paths: p.paths ?? [], prs: p.prs ?? [], reason: p.reason, liftOn: p.liftOn ?? "", declaredAt: e.at, by: e.actor.name }
      db.run("INSERT OR REPLACE INTO holds (id, active, doc) VALUES (?, 1, ?)", doc.id, JSON.stringify(doc))
      return
    }
    case "hold.lifted": {
      const doc = read<HoldDoc>(db, "holds", "id", p.id)
      if (!doc) return
      doc.liftedAt = e.at
      db.run("UPDATE holds SET active = 0, doc = ? WHERE id = ?", JSON.stringify(doc), doc.id)
      return
    }
    case "measure.recorded":
    case "measure.claimed": {
      const doc: MeasureDoc = {
        id: p.id, name: p.name, front: p.front, value: p.value, unit: p.unit, record: p.record, commit: p.commit, at: e.at,
        measuredBy: e.actor.name, sensitiveTo: p.sensitiveTo, blindTo: p.blindTo, claimed: e.type === "measure.claimed",
      }
      db.run("INSERT OR REPLACE INTO measures (id, name, front, at, doc) VALUES (?, ?, ?, ?, ?)", doc.id, doc.name, doc.front ?? null, doc.at, JSON.stringify(doc))
      return
    }
    case "incident.reported":
      db.run("INSERT OR REPLACE INTO incidents (id, doc) VALUES (?, ?)", p.id, JSON.stringify({ ...p, at: e.at, reportedBy: e.actor.name }))
      return
    case "owner.order":
      db.run("INSERT OR REPLACE INTO owner_orders (id, doc) VALUES (?, ?)", p.id, JSON.stringify({ ...p, at: e.at, receivedBy: e.actor.name }))
      return
    case "view.summary":
      db.run("INSERT OR REPLACE INTO summaries (key, doc) VALUES (?, ?)", `${p.kind}:${p.key}`, JSON.stringify({ ...p, at: e.at, by: e.actor.name }))
      return
    case "front.prioritized": {
      const order: string[] = p.order ?? []
      order.forEach((id, index) => {
        const item = read<Item>(db, "items", "id", id)
        if (!item) return
        item.priority = index + 1
        item.front = p.front
        saveItem(db, item)
      })
      return
    }
    case "front.parked":
      db.run("INSERT OR REPLACE INTO fronts (id, doc) VALUES (?, ?)", p.front, JSON.stringify({ parked: true, reason: p.reason, unparkOn: p.unparkOn, at: e.at }))
      return
    case "front.unparked":
      db.run("DELETE FROM fronts WHERE id = ?", p.front)
      return
    default:
      // Audit-only events (refusals, reminders sent, syncs, renders) have no projection.
      return
  }
}
