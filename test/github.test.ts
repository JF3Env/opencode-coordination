import assert from "node:assert/strict"
import test from "node:test"
import { makeGitHub, syncPullRequests, type Gh } from "../src/github/sync.ts"
import { itemIdFrom, names, team } from "./helpers.ts"

function fakeGh(prs: unknown[], extra: Record<string, string> = {}): Gh {
  return async (args) => {
    const joined = args.join(" ")
    if (args[0] === "pr" && args[1] === "view") {
      const hit = (prs as Array<{ number: number }>).find((p) => String(p.number) === args[2])
      if (!hit) throw new Error("no pull requests found")
      return JSON.stringify(hit)
    }
    if (args[0] === "pr" && args[1] === "list") {
      const head = args.indexOf("--head")
      return JSON.stringify(head < 0 ? prs : (prs as Array<{ headRefName: string }>).filter((p) => p.headRefName === args[head + 1]))
    }
    if (joined.includes("/compare/")) return extra.compare ?? "ahead"
    if (joined.includes("/contents/")) {
      if (joined.includes("missing")) throw new Error("404")
      return "sha"
    }
    throw new Error(`unexpected gh ${joined}`)
  }
}

async function claimed() {
  const fx = await team({ github: { repo: "o/r", agentLine: true } }, { github: false })
  const n = names(fx)
  const id = itemIdFrom(await fx.call("ses_pm", "propose", { title: "T", moves: "G1 x", predicted: "up", why: "w", scopeFiles: ["a/**"] }))
  await fx.call("ses_co", "accept", { item: id })
  await fx.call("ses_co", "refine", { item: id, scopeFiles: ["a/**"], doneWhen: "d" })
  await fx.call("ses_co", "assign", { item: id, engineer: n.ana })
  await fx.call("ses_ana", "claim", { item: id, branch: "feat/t", worktree: "/w", files: ["a/**"] })
  return { fx, id, n }
}

test("sync links a pull request to its item by branch, and flags a description without the outcome or agent line once", async () => {
  const { fx, id } = await claimed()
  const pr = { number: 7, isDraft: true, headRefName: "feat/t", headRefOid: "aaa1111", mergedAt: null, mergeCommit: null, closedAt: null, body: "just a body", comments: [] }
  const link = makeGitHub("o/r", fakeGh([pr]))
  const first = await syncPullRequests(fx.rt, link)
  assert.deepEqual(first.linked, [id])
  assert.deepEqual(first.incomplete, [7])
  assert.equal(fx.rt.ledger.item(id)?.pr, 7)
  assert.equal(fx.rt.ledger.item(id)?.containsMain, true)
  assert.equal(fx.rt.ledger.item(id)?.headSha, "aaa1111")
  assert.match(fx.delivered.filter((d) => d.sessionID === "ses_ana").map((d) => d.text).join("\n"), /lacks an outcome line.*Agent:/)
  assert.deepEqual((await syncPullRequests(fx.rt, link)).incomplete, [], "the note is sent once")
})

test("sync records the merge, the commit, and tells the others that main moved", async () => {
  const { fx, id } = await claimed()
  const pr = { number: 7, isDraft: false, headRefName: "feat/t", headRefOid: "aaa1111", mergedAt: "2026-10-25T11:00:00Z", mergeCommit: { oid: "bbb2222cc" }, closedAt: "2026-10-25T11:00:00Z", body: "Moves: G1 x", comments: [] }
  const out = await syncPullRequests(fx.rt, makeGitHub("o/r", fakeGh([pr])))
  assert.deepEqual(out.merged, [id])
  const item = fx.rt.ledger.item(id)
  assert.equal(item?.state, "merged")
  assert.equal(item?.stages.implemented?.commit, "bbb2222cc")
  assert.ok(fx.delivered.some((d) => d.sessionID === "ses_bru" && /main moved/.test(d.text)))
  assert.equal((await syncPullRequests(fx.rt, makeGitHub("o/r", fakeGh([pr])))).merged.length, 0, "merging is recorded once")
})

test("sync turns a closed, unmerged pull request into a ready item and tells the coordinator", async () => {
  const { fx, id } = await claimed()
  const pr = { number: 7, isDraft: true, headRefName: "feat/t", headRefOid: "aaa1111", mergedAt: null, mergeCommit: null, closedAt: "2026-10-25T11:00:00Z", body: "", comments: [] }
  assert.deepEqual((await syncPullRequests(fx.rt, makeGitHub("o/r", fakeGh([pr])))).closed, [id])
  assert.equal(fx.rt.ledger.item(id)?.state, "ready")
  assert.match(fx.delivered.filter((d) => d.sessionID === "ses_co").map((d) => d.text).join("\n"), /closed without merging/)
})

test("sync reads the steward's comment as the verdict, newest only", async () => {
  const { fx, id } = await claimed()
  fx.rt.ledger.append({ type: "item.in_review", actor: { session: "ses_ana", name: "x", role: "engineer" }, subject: id, payload: { id } })
  const pr = {
    number: 7, isDraft: false, headRefName: "feat/t", headRefOid: "aaa1111", mergedAt: null, mergeCommit: null, closedAt: null, body: "Moves: G1\nAgent: " + names(fx).ana,
    comments: [{ body: "STEWARD: CHANGES REQUESTED\nold", createdAt: "2099-01-01T00:00:00Z" }, { body: "STEWARD: APPROVED\nall good", createdAt: "2099-01-02T00:00:00Z" }, { body: "thanks", createdAt: "2099-01-03T00:00:00Z" }],
  }
  const out = await syncPullRequests(fx.rt, makeGitHub("o/r", fakeGh([pr])))
  assert.deepEqual(out.verdicts, [id])
  assert.equal(fx.rt.ledger.item(id)?.verdict?.verdict, "approved")
})

test("a GitHub failure is recorded and leaves every item as it was", async () => {
  const { fx, id } = await claimed()
  const failing: Gh = async () => { throw new Error("rate limited") }
  const out = await syncPullRequests(fx.rt, makeGitHub("o/r", failing))
  assert.equal(out.failed, "rate limited")
  assert.equal(fx.rt.ledger.item(id)?.state, "in_progress")
  assert.equal(fx.rt.ledger.events({ type: "pr.sync_failed" }).length, 1)
})

test("measure keeps a record that is not on main as a claim, not a measurement", async () => {
  const fx = await team({}, { github: true })
  const out = await fx.callFail("ses_pm", "measure", { name: "z0", value: "3.55", unit: "sigma", record: "docs/evidence/x.md" }).catch(() => "")
  void out
  assert.equal(fx.rt.ledger.measures().filter((m) => !m.claimed).length, 0)
  const msg = await fx.call("ses_pm", "measure", { name: "z0", value: "3.55", unit: "sigma", record: "docs/evidence/x.md" })
  assert.match(msg, /not on main/)
  assert.equal(fx.rt.ledger.measures()[0]?.claimed, true)
  fx.recordsOnMain.add("docs/evidence/x.md")
  assert.match(await fx.call("ses_pm", "measure", { name: "z0", value: "3.60", unit: "sigma", record: "docs/evidence/x.md" }), /Recorded z0 = 3.60/)
})

test("ready finds the pull request by its number even when it is not among the recent ones", async () => {
  const { fx, id } = await claimed()
  const old = { number: 3, isDraft: false, headRefName: "feat/t", headRefOid: "ccc3333", mergedAt: null, mergeCommit: null, closedAt: null, body: "Moves: G1 x", comments: [] }
  const gh: Gh = async (args) => {
    if (args[0] === "pr" && args[1] === "view" && args[2] === "3") return JSON.stringify(old)
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(args.includes("--head") ? [old] : [])
    if (args.join(" ").includes("/compare/release...")) return "ahead"
    throw new Error(`unexpected gh ${args.join(" ")}`)
  }
  fx.rt.github = makeGitHub("o/r", gh, "release")
  assert.equal((await fx.rt.github.prForItem(undefined, 3))?.number, 3)
  assert.equal((await fx.rt.github.prForItem("feat/t", undefined))?.containsMain, true, "contains the configured base branch")
  await fx.call("ses_ana", "ready", { item: id, pr: 3, checks: [{ name: "t", result: "ok" }], result: "r" })
  assert.equal(fx.rt.ledger.item(id)?.pr, 3)
})

test("a steward comment that requests changes sends the item back to work and tells the engineer", async () => {
  const { fx, id } = await claimed()
  fx.rt.ledger.append({ type: "item.in_review", actor: { session: "ses_ana", name: "x", role: "engineer" }, subject: id, payload: { id } })
  const pr = {
    number: 7, isDraft: false, headRefName: "feat/t", headRefOid: "aaa1111", mergedAt: null, mergeCommit: null, closedAt: null, body: "Moves: G1\nAgent: " + names(fx).ana,
    comments: [{ body: "STEWARD: CHANGES REQUESTED\n1. add the check", createdAt: "2099-01-01T00:00:00Z" }],
  }
  const out = await syncPullRequests(fx.rt, makeGitHub("o/r", fakeGh([pr])))
  assert.deepEqual(out.verdicts, [id])
  assert.equal(fx.rt.ledger.item(id)?.state, "in_progress")
  assert.match(fx.delivered.filter((d) => d.sessionID === "ses_ana").map((d) => d.text).join("\n"), /CHANGES REQUESTED[\s\S]*add the check/)
  assert.deepEqual((await syncPullRequests(fx.rt, makeGitHub("o/r", fakeGh([pr])))).verdicts, [], "read once")
})

test("a merge of an item that was assigned but never claimed is still recorded", async () => {
  const fx = await team({ github: { repo: "o/r" } }, { github: false })
  const n = names(fx)
  const id = itemIdFrom(await fx.call("ses_pm", "propose", { title: "T", moves: "G1 x", predicted: "up", why: "w", scopeFiles: ["a/**"] }))
  await fx.call("ses_co", "accept", { item: id })
  await fx.call("ses_co", "refine", { item: id, scopeFiles: ["a/**"], doneWhen: "d" })
  await fx.call("ses_co", "assign", { item: id, engineer: n.ana })
  fx.rt.ledger.append({ type: "item.pr_linked", actor: { session: "ses_co", name: "c", role: "coordinator" }, subject: id, payload: { id, pr: 9 } })
  const pr = { number: 9, isDraft: false, headRefName: "feat/x", headRefOid: "aaa1111", mergedAt: "2026-10-25T11:00:00Z", mergeCommit: { oid: "bbb2222cc" }, closedAt: "2026-10-25T11:00:00Z", body: "Moves: G1 x", comments: [] }
  assert.deepEqual((await syncPullRequests(fx.rt, makeGitHub("o/r", fakeGh([pr])))).merged, [id])
  assert.equal(fx.rt.ledger.item(id)?.state, "merged")
})
