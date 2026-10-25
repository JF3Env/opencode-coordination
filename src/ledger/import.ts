import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Ledger } from "./ledger.ts"
import { IMPORT_ACTOR } from "../domain/system.ts"
import type { Party } from "../domain/types.ts"

interface LegacyRecord {
  id: string
  at: string
  from: Party
  to: Party
  text: string
  transport?: string
  status?: string
}

export interface ImportResult {
  read: number
  imported: number
  skipped: number
  invalid: number
}

/** Imports the records of the earlier agent-mail plugin as history. Idempotent: an id already present is skipped. */
export function importAgentMail(ledger: Ledger, root: string): ImportResult {
  const dir = join(root, "records")
  const out: ImportResult = { read: 0, imported: 0, skipped: 0, invalid: 0 }
  if (!existsSync(dir)) return out
  const records: LegacyRecord[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue
    out.read++
    try {
      const r = JSON.parse(readFileSync(join(dir, name), "utf8")) as LegacyRecord
      if (!r.id || !r.at || !r.from?.id || !r.to?.id || typeof r.text !== "string") throw new Error("incomplete")
      records.push(r)
    } catch {
      out.invalid++
    }
  }
  records.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1))
  const fresh = records.filter((r) => {
    if (ledger.message(r.id)) {
      out.skipped++
      return false
    }
    return true
  })
  for (let i = 0; i < fresh.length; i += 500) {
    ledger.appendMany(fresh.slice(i, i + 500).map((r) => ({
      type: "message.sent",
      actor: IMPORT_ACTOR,
      at: r.at,
      payload: { id: r.id, kind: "note", from: r.from, to: r.to, text: r.text, transport: "imported", delivered: true, legacyStatus: r.status },
      refs: [r.id.slice(0, 8)],
    })))
  }
  out.imported = fresh.length
  return out
}
