import type { Actor, MessageDoc } from "../domain/types.ts"
import { SYSTEM_ACTOR } from "../domain/system.ts"
import { dispatch } from "../deliver/deliver.ts"
import { fail, partyOf, post, postToRole, type Runtime } from "../runtime.ts"
import { freeEngineers } from "../views/board.ts"

export const GO_HORSE_IDLE_MS = 15 * 60_000

export const GO_HORSE_QUESTIONS = [
  "Qual fluxo funcional será exercitado agora? Acione o coordenador para iniciar a execução e registrar a evidência.",
  "Qual funcionalidade prioritária ainda não funciona? Faça o coordenador atribuir o próximo passo e obter o início do trabalho.",
  "Qual falha impede o fluxo principal? Mobilize um engenheiro para reproduzi-la e iniciar a correção autorizada.",
  "Qual avanço funcional pode ser produzido agora? Faça a equipe executar o próximo passo e registrar o resultado.",
  "Qual entrega precisa de teste funcional ou integração? Faça o coordenador atribuir a execução e cobrar seu início.",
  "Qual bloqueio será tratado agora? Acione o responsável e inicie trabalho independente autorizado; não encerre com apenas uma justificativa.",
  "Qual entrega pode sair da fila de revisão agora? Faça o coordenador realizar a revisão ou concluir a integração autorizada.",
  "Qual engenheiro está sem trabalho útil? Faça o coordenador atribuir uma tarefa executável e obter a confirmação de início.",
  "Como iniciar a próxima entrega em paralelo agora? Faça o coordenador dividir o escopo e acionar os engenheiros disponíveis.",
  "Qual resultado funcional verificável será produzido a seguir? Mobilize o responsável agora e registre o início da execução.",
] as const

export function goHorseMode(rt: Runtime) {
  return rt.ledger.events({ type: "go_horse.mode", newestFirst: true, limit: 1 })[0]
}

export function setGoHorse(rt: Runtime, actor: Actor, enabled: boolean): void {
  if (Boolean(goHorseMode(rt)?.payload.enabled) === enabled) return
  rt.ledger.db.transaction(() => {
    rt.ledger.append({ type: "go_horse.mode", actor, payload: { enabled } })
    if (!enabled) {
      for (const m of rt.ledger.messages({ fromId: "go-horse" }).filter((m) => !m.answeredBy && !m.cancelled)) {
        rt.ledger.append({ type: "message.cancelled", actor, payload: { id: m.id, reason: "GO HORSE disabled" } })
      }
    }
  })
}

/** The timer wakes an existing idle session. It never creates agents or assigns work. */
export async function tickGoHorse(rt: Runtime): Promise<void> {
  const mode = goHorseMode(rt)
  if (!mode?.payload.enabled) return
  const now = rt.now().getTime()
  for (const pm of rt.ledger.agents((a) => a.role === "product-manager" && a.status === "idle" && a.kind === "opencode")) {
    if (rt.host?.liveSessions && !(await rt.host.liveSessions([pm.sessionID])).has(pm.sessionID)) continue
    // Keep the selection and the post in one transaction: two plugin instances share this ledger.
    const messages = rt.ledger.db.transaction(() => {
      if (goHorseMode(rt)?.id !== mode.id) return
      const current = rt.ledger.agent(pm.sessionID)
      if (!current || current.status !== "idle") return
      const last = rt.ledger.events({ type: "go_horse.prompted", subject: pm.sessionID, newestFirst: true, limit: 1 })[0]
      const pending = rt.ledger.openQuestions().find((m) => m.from.id === "go-horse" && m.to.id === pm.sessionID)
      if (pending && !pending.delivered) return [pending]
      const latestRetry = pending ? rt.ledger.events({ type: "go_horse.retried", subject: pm.sessionID, newestFirst: true, limit: 1 })[0] : undefined
      const retry = latestRetry?.payload.question === pending?.id ? latestRetry : undefined
      const copy = retry ? rt.ledger.message(String(retry.payload.id)) : undefined
      if (copy && !copy.delivered && !copy.cancelled) return [copy]
      const since = Math.max(Date.parse(current.seenAt), Date.parse(mode.at), last ? Date.parse(last.at) : 0, retry ? Date.parse(retry.at) : 0)
      if (now - since < GO_HORSE_IDLE_MS) return
      if (pending) {
        const text = `GO HORSE: record ${pending.short} still requires concrete work. Status messages and waiting do not close this cycle. Consult the coordinator with a work item. Require assignment and an engineer claim, or a completed review or merge. Resolve blockers or start independent authorized work. Respect holds and approvals.\n${pending.text}`
        const reminder = post(rt, { from: pending.from, to: pending.to, kind: "note", text, inReplyTo: pending.id, actor: SYSTEM_ACTOR, transport: "system" })
        rt.ledger.append({ type: "go_horse.retried", actor: SYSTEM_ACTOR, subject: pm.sessionID, payload: { id: reminder.id, question: pending.id } })
        const coordinators = postToRole(rt, "coordinator", {
          from: pending.from, kind: "note", text: `GO HORSE: help ${pm.name} execute the action required by record ${pending.short}. Check the queue, start safe work with available engineers, or perform the pending review. A blocker report alone does not finish the cycle. Respect holds and approvals.`,
          actor: SYSTEM_ACTOR, transport: "system",
          inReplyTo: pending.id,
        })
        return [reminder, ...coordinators]
      }
      const index = last ? (Number(last.payload.index) + 1) % GO_HORSE_QUESTIONS.length : 0
      const free = freeEngineers(rt.ledger).map((a) => a.name)
      const ready = rt.ledger.items((i) => i.state === "ready").map((i) => i.id)
      const message = post(rt, {
        from: { kind: "system", id: "go-horse", name: "coordination" }, to: partyOf(pm), kind: "ask",
        text: [
          `GO HORSE ${index + 1}/${GO_HORSE_QUESTIONS.length}: ${GO_HORSE_QUESTIONS[index]}`,
          "Read coordination_record for this question. Read the board and check functional evidence; do not infer success from activity.",
          "Use coordination_ask with an item to consult the coordinator. Propose a useful authorized item first if none exists.",
          "The coordinator must use coordination_assign and obtain coordination_claim from an engineer, or perform a review or merge on that item.",
          "After the coordinator answers and the item advances, use coordination_answer on this question with the action and evidence ids.",
          "Status messages, progress lines, promises and blocker reports do not close this cycle. Resolve blockers or start independent authorized work.",
          "Do not wait or poll. Respect holds, parked fronts, file overlap, permissions and owner approvals. Do not invent work to keep agents busy.",
          `Engineers without an active item: ${free.join(", ") || "none"}. Ready items (not assignment approval): ${ready.join(", ") || "none"}.`,
        ].join("\n"), needsAnswer: true, actor: SYSTEM_ACTOR, transport: "system",
      })
      rt.ledger.append({ type: "go_horse.prompted", actor: SYSTEM_ACTOR, subject: pm.sessionID, payload: { id: message.id, index } })
      return [message]
    })
    for (const message of messages ?? []) await dispatch(rt, message)
  }
}

/** Only a linked work-item action after this wake-up can close it; conversation is not work evidence. */
export function checkGoHorseAnswer(rt: Runtime, message: MessageDoc): void {
  if (!goHorseMode(rt)?.payload.enabled || message.from.id !== "go-horse") return
  const wake = rt.ledger.events({ type: "go_horse.prompted", subject: message.to.id }).find((e) => e.payload.id === message.id)
  if (!wake) fail("GO HORSE: the wake-up record is missing. Report a coordination incident.")
  const sentAfterWake = new Set(rt.ledger.events({ type: "message.sent", actorSession: message.to.id, since: message.at })
    .filter((e) => e.seq > wake.seq).map((e) => String(e.payload.id)))
  const followUps = rt.ledger.messages({ fromId: message.to.id }).filter((m) =>
    m.kind === "ask" && sentAfterWake.has(m.id) && !m.cancelled && m.answeredBy &&
    (m.to.id === "role:coordinator" || rt.ledger.agent(m.to.id)?.role === "coordinator"))
  if (!followUps.length) fail("GO HORSE: use coordination_ask to consult the coordinator first. Close this question after its answer arrives.")
  const advanced = followUps.some((followUp) => {
    if (!followUp.item) return false
    const item = rt.ledger.item(followUp.item)
    if (!item || !["in_progress", "in_review", "merged", "measured", "validated"].includes(item.state)) return false
    const events = rt.ledger.events({ subject: item.id, since: message.at }).filter((e) => e.seq > wake.seq)
    const coordinator = events.filter((e) => e.actor.session === followUp.answeredBy && e.actor.role === "coordinator")
    if (coordinator.some((e) => e.type === "item.verdict" || e.type === "item.merged")) return true
    return coordinator.some((e) => e.type === "item.assigned" || e.type === "item.unblocked") &&
      events.some((e) => e.actor.role === "engineer" && ["item.claimed", "item.in_review", "item.measured"].includes(e.type))
  })
  if (!advanced) fail("GO HORSE: concrete work is required on the item in your coordinator question. Require assignment and an engineer claim, or a review or merge after this wake-up. Status, progress lines and blockers do not count.")
}
