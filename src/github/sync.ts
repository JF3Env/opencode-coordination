import { SYSTEM_ACTOR } from "../domain/system.ts"
import type { Item } from "../domain/types.ts"
import type { GitHubLink, PrInfo, Runtime } from "../runtime.ts"
import { partyOf, post, postToRole } from "../runtime.ts"
import { dispatch } from "../deliver/deliver.ts"

/** Runs `gh` and returns its stdout. Injected so tests never touch the network. */
export type Gh = (args: string[]) => Promise<string>

interface GhPr {
  number: number
  isDraft: boolean
  headRefName: string
  headRefOid: string
  mergedAt: string | null
  mergeCommit: { oid: string } | null
  closedAt: string | null
  body: string
  comments?: Array<{ body: string; createdAt: string }>
}

const FIELDS = "number,isDraft,headRefName,headRefOid,mergedAt,mergeCommit,closedAt,body,comments"

export function makeGitHub(repo: string, gh: Gh): GitHubLink & { list(): Promise<GhPr[]>; containsMain(sha: string): Promise<boolean> } {
  const containsMain = async (sha: string): Promise<boolean> => {
    try {
      const status = (await gh(["api", `repos/${repo}/compare/main...${sha}`, "--jq", ".status"])).trim()
      return status === "ahead" || status === "identical"
    } catch {
      return false
    }
  }
  const list = async (): Promise<GhPr[]> => JSON.parse(await gh(["pr", "list", "--repo", repo, "--state", "all", "--limit", "100", "--json", FIELDS])) as GhPr[]
  return {
    list,
    containsMain,
    async prForItem(branch, pr) {
      const all = await list()
      const hit = all.find((p) => (pr !== undefined && p.number === pr) || (branch && p.headRefName === branch))
      if (!hit) return undefined
      const info: PrInfo = { number: hit.number, isDraft: hit.isDraft, head: hit.headRefOid, containsMain: await containsMain(hit.headRefOid) }
      if (hit.mergedAt) info.mergedAt = hit.mergedAt
      if (hit.mergeCommit) info.mergeCommit = hit.mergeCommit.oid
      return info
    },
    async recordOnMain(path) {
      try {
        await gh(["api", `repos/${repo}/contents/${encodeURIComponent(path).replaceAll("%2F", "/")}?ref=main`, "--jq", ".sha"])
        return true
      } catch {
        return false
      }
    },
  }
}

export interface SyncResult {
  linked: string[]
  merged: string[]
  closed: string[]
  verdicts: string[]
  unlinked: number[]
  incomplete: number[]
  failed?: string
}

// docs/uml/src/14-act-github-sync.puml
export async function syncPullRequests(rt: Runtime, link: ReturnType<typeof makeGitHub>): Promise<SyncResult> {
  const out: SyncResult = { linked: [], merged: [], closed: [], verdicts: [], unlinked: [], incomplete: [] }
  let prs: GhPr[]
  try {
    prs = await link.list()
  } catch (error) {
    rt.ledger.append({ type: "pr.sync_failed", actor: SYSTEM_ACTOR, payload: { error: error instanceof Error ? error.message : String(error) } })
    out.failed = error instanceof Error ? error.message : String(error)
    return out
  }
  const agentLine = rt.profile.github.agentLine
  for (const pr of prs) {
    const item: Item | undefined = rt.ledger.items((i) => i.pr === pr.number)[0] ?? rt.ledger.items((i) => i.branch === pr.headRefName && !["merged", "measured", "validated", "cancelled"].includes(i.state))[0]
    if (!item) {
      if (!pr.mergedAt && !pr.closedAt && !rt.ledger.events({ type: "pr.unlinked", subject: String(pr.number), limit: 1 }).length) {
        rt.ledger.append({ type: "pr.unlinked", actor: SYSTEM_ACTOR, subject: String(pr.number), payload: { pr: pr.number, branch: pr.headRefName } })
        out.unlinked.push(pr.number)
      }
      continue
    }
    if (item.pr === undefined) {
      rt.ledger.append({ type: "item.pr_linked", actor: SYSTEM_ACTOR, subject: item.id, payload: { id: item.id, pr: pr.number } })
      out.linked.push(item.id)
    }
    if (item.headSha !== pr.headRefOid && !pr.mergedAt && !pr.closedAt) {
      rt.ledger.append({ type: "pr.synced", actor: SYSTEM_ACTOR, subject: item.id, payload: { item: item.id, pr: pr.number, head: pr.headRefOid, containsMain: await link.containsMain(pr.headRefOid), isDraft: pr.isDraft } })
    }
    if (!pr.mergedAt && !pr.closedAt && ["in_progress", "in_review"].includes(item.state)) await checkDescription(rt, item, pr, agentLine, out)
    if (pr.mergedAt && !["merged", "measured", "validated"].includes(item.state)) {
      if (item.state === "in_progress" || item.state === "in_review" || item.state === "blocked") {
        if (item.state !== "in_review") rt.ledger.append({ type: "item.in_review", actor: SYSTEM_ACTOR, subject: item.id, payload: { id: item.id, pr: pr.number, viaSync: true } })
        rt.ledger.append({ type: "item.merged", actor: SYSTEM_ACTOR, subject: item.id, payload: { id: item.id, commit: pr.mergeCommit?.oid ?? pr.headRefOid } })
        await announceMain(rt, item, pr)
        out.merged.push(item.id)
      }
    } else if (pr.closedAt && !pr.mergedAt && ["assigned", "in_progress", "in_review", "blocked"].includes(item.state)) {
      rt.ledger.append({ type: "item.pr_closed", actor: SYSTEM_ACTOR, subject: item.id, payload: { id: item.id, leftToDo: `PR #${pr.number} was closed without merging` } })
      await postCoordinator(rt, `${item.id} ${item.title}: PR #${pr.number} was closed without merging; the item is ready again.`, item.id)
      out.closed.push(item.id)
    } else if (!pr.isDraft && item.state === "in_progress" && !pr.closedAt) {
      // The author marked the PR ready but has not called coordination_ready yet: visible to the clock, nothing to do.
    } else if (pr.isDraft && item.state === "in_review") {
      rt.ledger.append({ type: "item.returned", actor: SYSTEM_ACTOR, subject: item.id, payload: { id: item.id, viaSync: true } })
    }
    const steward = (pr.comments ?? []).filter((c) => /^STEWARD:/.test(c.body)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
    if (steward && steward.createdAt > (rt.ledger.item(item.id)?.verdict?.at ?? "")) {
      const approved = /^STEWARD: APPROVED/.test(steward.body)
      rt.ledger.append({ type: "item.verdict", actor: SYSTEM_ACTOR, subject: item.id, payload: { id: item.id, verdict: approved ? "approved" : "changes", findings: steward.body, fromComment: true } })
      out.verdicts.push(item.id)
    }
  }
  return out
}

async function checkDescription(rt: Runtime, item: Item, pr: GhPr, agentLine: boolean, out: SyncResult): Promise<void> {
  const problems: string[] = []
  if (!/^\s*(Moves|Upkeep):/m.test(pr.body)) problems.push('an outcome line ("Moves:" or "Upkeep:")')
  const assignee = item.assignee ? rt.ledger.agent(item.assignee) : undefined
  if (agentLine && assignee?.kind === "opencode" && !new RegExp(`^\\s*Agent:\\s*${assignee.name}\\b`, "m").test(pr.body)) problems.push(`the line "Agent: ${assignee.name}"`)
  if (!problems.length || rt.ledger.events({ type: "pr.description_incomplete", subject: item.id, limit: 1 }).length) return
  rt.ledger.append({ type: "pr.description_incomplete", actor: SYSTEM_ACTOR, subject: item.id, payload: { pr: pr.number, problems } })
  if (assignee) await dispatch(rt, post(rt, { from: { kind: "system", id: "system", name: "coordination" }, to: partyOf(assignee), kind: "note", text: `PR #${pr.number} description lacks ${problems.join(" and ")}. Fix it before you mark the PR ready.`, item: item.id, actor: SYSTEM_ACTOR, transport: "system" }))
  out.incomplete.push(pr.number)
}

async function announceMain(rt: Runtime, item: Item, pr: GhPr): Promise<void> {
  const text = `main moved: ${item.id} ${item.title} merged (PR #${pr.number}). Files: ${item.scopeFiles.join(", ") || "—"}.`
  for (const a of rt.ledger.agents((x) => x.status !== "gone" && x.role !== "other" && x.sessionID !== item.assignee)) {
    await dispatch(rt, post(rt, { from: { kind: "system", id: "system", name: "coordination" }, to: partyOf(a), kind: "broadcast", text, item: item.id, actor: SYSTEM_ACTOR, transport: "system" }))
  }
}

async function postCoordinator(rt: Runtime, text: string, item: string): Promise<void> {
  for (const m of postToRole(rt, "coordinator", { from: { kind: "system", id: "system", name: "coordination" }, kind: "note", text, item, actor: SYSTEM_ACTOR, transport: "system" })) await dispatch(rt, m)
}
