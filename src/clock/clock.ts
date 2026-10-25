import { SYSTEM_ACTOR } from "../domain/system.ts"
import { isActive } from "../domain/items.ts"
import type { MessageDoc, Party } from "../domain/types.ts"
import { blockMs, partyOf, post, postToRole, type Runtime } from "../runtime.ts"
import { dispatch } from "../deliver/deliver.ts"
import { computeState, stateText } from "../views/state.ts"
import { freeEngineers } from "../views/board.ts"

export interface TickResult {
  reminded: string[]
  escalated: string[]
  unclaimed: string[]
  stalled: string[]
  quiet: string[]
  idle: string[]
  gone: string[]
  digest: boolean
}

const SYSTEM_PARTY: Party = { kind: "system", id: "system", name: "coordination" }

function note(rt: Runtime, to: Party | undefined, text: string, item?: string): Promise<void> {
  if (!to) return Promise.resolve()
  const m = post(rt, { from: SYSTEM_PARTY, to, kind: "note", text, item, actor: SYSTEM_ACTOR, transport: "system" })
  return dispatch(rt, m)
}

async function toRole(rt: Runtime, role: "coordinator" | "product-manager", text: string, item?: string): Promise<void> {
  for (const m of postToRole(rt, role, { from: SYSTEM_PARTY, kind: "note", text, item, actor: SYSTEM_ACTOR, transport: "system" })) await dispatch(rt, m)
}

// Every minute: the follow-ups nobody has to remember (docs/uml/src/13-act-clock-tick.puml). Pure in `rt.now()`.
export async function tick(rt: Runtime): Promise<TickResult> {
  const now = rt.now().getTime()
  const block = blockMs(rt)
  const out: TickResult = { reminded: [], escalated: [], unclaimed: [], stalled: [], quiet: [], idle: [], gone: [], digest: false }

  // Unanswered messages: one block → resend; two blocks → escalate.
  for (const m of rt.ledger.openQuestions()) {
    const due = Date.parse(m.needsAnswerBy as string)
    if (now < due) continue
    if (m.reminded === 0) {
      rt.ledger.append({ type: "clock.reminder", actor: SYSTEM_ACTOR, subject: m.item, payload: { id: m.id } })
      await resend(rt, m)
      out.reminded.push(m.short)
    } else if (!m.escalated && now >= due + block) {
      rt.ledger.append({ type: "clock.escalated", actor: SYSTEM_ACTOR, subject: m.item, payload: { id: m.id } })
      await escalate(rt, m)
      out.escalated.push(m.short)
    }
  }

  const parked = rt.ledger.parkedFronts()
  for (const item of rt.ledger.items()) {
    const last = Date.parse(item.lastProgressAt ?? item.lastEventAt)
    const front = item.front ?? "(none)"
    if (item.state === "assigned" && now - Date.parse(item.lastEventAt) >= block && !unclaimedRecorded(rt, item.id, item.lastEventAt)) {
      rt.ledger.append({ type: "clock.unclaimed", actor: SYSTEM_ACTOR, subject: item.id, payload: { id: item.id } })
      await toRole(rt, "coordinator", `${item.id} ${item.title} was assigned to ${item.assigneeName ?? "?"} over a block ago and is not claimed. Reassign it or ask.`, item.id)
      out.unclaimed.push(item.id)
    }
    if (isActive(item) && item.state !== "blocked" && !parked[front] && now - Date.parse(item.lastEventAt) >= 2 * block && !recentEvent(rt, item.id, "clock.stall", now - 2 * block)) {
      rt.ledger.append({ type: "clock.stall", actor: SYSTEM_ACTOR, subject: item.id, payload: { id: item.id } })
      const text = `STALL ${item.id} ${item.title}: no event for two blocks (assignee ${item.assigneeName ?? "none"}, state ${item.state}).`
      await toRole(rt, "coordinator", text, item.id)
      await toRole(rt, "product-manager", text, item.id)
      out.stalled.push(item.id)
    } else if (item.state === "in_progress" && now - last >= block && !recentEvent(rt, item.id, "clock.quiet", now - block)) {
      rt.ledger.append({ type: "clock.quiet", actor: SYSTEM_ACTOR, subject: item.id, payload: { id: item.id } })
      const who = item.assignee ? rt.ledger.agent(item.assignee) : undefined
      await note(rt, who ? partyOf(who) : undefined, `${item.id} has shown no commit or progress line for a block. Post one line with coordination_progress, or push your work.`, item.id)
      out.quiet.push(item.id)
    }
  }

  // Idle engineers: no item for a block.
  for (const a of freeEngineers(rt.ledger)) {
    const since = Date.parse(a.availableAt ?? a.seenAt)
    if (a.status === "idle" || a.available) {
      if (now - since >= block && !recentEvent(rt, a.sessionID, "clock.idle", now - block)) {
        const nextReady = rt.ledger.items((i) => i.state === "ready").sort((x, y) => (x.priority ?? 1e9) - (y.priority ?? 1e9))[0]
        rt.ledger.append({ type: "clock.idle", actor: SYSTEM_ACTOR, subject: a.sessionID, payload: { name: a.name } })
        await toRole(rt, "coordinator", `${a.name} has had no work for a block.${nextReady ? ` Next ready item: ${nextReady.id} ${nextReady.title}.` : " Nothing is ready to assign."}`)
        out.idle.push(a.name)
      }
    }
  }

  // Sessions the host no longer lists, silent past the profile's limit, are gone; their items go back to the queue.
  if (rt.host?.liveSessions) {
    const silent = rt.profile.limits.goneAfterMinutes * 60_000
    const candidates = rt.ledger.agents((x) => x.status !== "gone" && x.kind === "opencode" && x.role !== "other" && now - Date.parse(x.seenAt) >= silent)
    const live = candidates.length ? await rt.host.liveSessions(candidates.map((a) => a.sessionID)) : new Set<string>()
    for (const a of candidates) {
      if (live.has(a.sessionID)) continue
      const items = rt.ledger.items((i) => i.assignee === a.sessionID && ["assigned", "in_progress", "blocked", "in_review"].includes(i.state))
      rt.ledger.appendMany([
        { type: "agent.gone", actor: SYSTEM_ACTOR, payload: { sessionID: a.sessionID, reason: "not listed by the host" } },
        ...items.map((i) => ({ type: "item.orphaned", actor: SYSTEM_ACTOR, subject: i.id, payload: { id: i.id, leftToDo: `${a.name} disappeared; branch ${i.branch ?? "none"}${i.pr ? `, PR #${i.pr}` : ""} stay as they are` } })),
      ])
      if (items.length) await toRole(rt, "coordinator", `${a.name} is gone. Orphaned: ${items.map((i) => `${i.id} ${i.title}${i.branch ? ` (branch ${i.branch}${i.pr ? `, PR #${i.pr}` : ""})` : ""}`).join("; ")}. Reassign them.`)
      out.gone.push(a.name)
    }
  }

  // Block boundary: the state digest to the product manager.
  const last = Date.parse(rt.ledger.meta("last_digest") ?? "0")
  if (now - last >= block) {
    out.digest = true
    const since = last ? new Date(last).toISOString() : undefined
    const text = stateText(computeState(rt, since))
    rt.ledger.setMeta("last_digest", new Date(now).toISOString())
    if (rt.ledger.agents((a) => a.role === "product-manager" && a.status !== "gone").length) await toRole(rt, "product-manager", text)
  }
  return out
}

function unclaimedRecorded(rt: Runtime, item: string, since: string): boolean {
  return rt.ledger.events({ type: "clock.unclaimed", subject: item, since, limit: 1 }).length > 0
}

function recentEvent(rt: Runtime, subject: string, type: string, sinceMs: number): boolean {
  return rt.ledger.events({ type, subject, since: new Date(sinceMs).toISOString(), limit: 1 }).length > 0
}

async function resend(rt: Runtime, m: MessageDoc): Promise<void> {
  const copy = post(rt, { from: m.from, to: m.to, kind: m.kind, text: `(resent) ${m.text}`, item: m.item, needsAnswer: false, actor: SYSTEM_ACTOR, transport: m.transport, inReplyTo: m.id })
  await dispatch(rt, copy)
  const sender = rt.ledger.agent(m.from.id)
  await note(rt, sender ? partyOf(sender) : undefined, `No answer yet to ${m.short} (${m.to.name}); it was sent again.`, m.item)
}

// Engineer → coordinator: copy the product manager. Product manager → coordinator: it goes into the owner bundle
// (the message stays open and escalated). Coordinator → engineer: the item is a stall candidate.
async function escalate(rt: Runtime, m: MessageDoc): Promise<void> {
  const from = rt.ledger.agent(m.from.id)
  const text = `ESCALATED: no answer after two blocks to ${m.short} from ${m.from.name} to ${m.to.name}${m.item ? ` (${m.item})` : ""}: ${m.text.split("\n")[0]}`
  if (from?.role === "engineer") await toRole(rt, "product-manager", text, m.item)
  else if (from?.role === "coordinator" && m.item) await toRole(rt, "product-manager", text, m.item)
}
