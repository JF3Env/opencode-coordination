import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { importAgentMail } from "../src/ledger/import.ts"
import { Ledger } from "../src/ledger/ledger.ts"
import { buildPrompt } from "../src/prompt/prompt.ts"
import { renderPages, stalePages, writePages } from "../src/render/render.ts"
import { codesIn } from "../src/tools/pm.ts"
import { itemIdFrom, names, team } from "./helpers.ts"

async function worked() {
  const fx = await team({ fronts: [{ id: "G1", title: "A product like the real one" }] }, { github: false })
  const n = names(fx)
  const id = itemIdFrom(await fx.call("ses_pm", "propose", { title: "Write the product", front: "G1", moves: "G1.1 reach", predicted: "up", why: "w", scopeFiles: ["src/p/**"] }))
  await fx.call("ses_co", "accept", { item: id })
  await fx.call("ses_co", "refine", { item: id, scopeFiles: ["src/p/**"], doneWhen: "re-measured on main" })
  await fx.call("ses_co", "assign", { item: id, engineer: n.ana })
  await fx.call("ses_ana", "claim", { item: id, branch: "feat/p", worktree: "/w/p", files: ["src/p/**"] })
  return { fx, id, n }
}

test("pages are generated from the ledger, are stable, and a hand edit is reported as stale", async () => {
  const { fx, id } = await worked()
  const root = mkdtempSync(join(tmpdir(), "coord-render-"))
  const pages = renderPages(fx.rt.ledger, fx.rt.profile)
  assert.equal(writePages(root, pages).length, 5)
  assert.deepEqual(stalePages(root, renderPages(fx.rt.ledger, fx.rt.profile)), [])
  assert.deepEqual(writePages(root, renderPages(fx.rt.ledger, fx.rt.profile)), [], "a second render changes nothing")
  const active = readFileSync(join(root, fx.rt.profile.render.active), "utf8")
  assert.match(active, new RegExp(`\\| ${id} \\| Write the product \\| in_progress \\|`))
  assert.match(active, /feat\/p/)
  writeFileSync(join(root, fx.rt.profile.render.active), `${active}\nsomeone typed a row here\n`)
  assert.deepEqual(stalePages(root, renderPages(fx.rt.ledger, fx.rt.profile)), [fx.rt.profile.render.active])
  const snap = JSON.parse(readFileSync(join(root, fx.rt.profile.render.snapshot), "utf8"))
  assert.equal(snap.items[0].id, id)
  const roadmap = readFileSync(join(root, fx.rt.profile.render.roadmap), "utf8")
  assert.match(roadmap, /## G1 — A product like the real one/)
  assert.match(roadmap, /Write the product \| in_progress \| 2026-10-25 \| 2026-10-25 \| — \| — \| — \|/)
})

test("the status page is plain words only: a summary with a code, a path or a hash is refused", async () => {
  const fx = await team({ fronts: [{ id: "G1", title: "A product like the real one" }] }, { github: false })
  assert.match(await fx.callFail("ses_pm", "summary", { kind: "front", key: "G1", text: "Fixed in #214 and DEF-12, see docs/x.md" }), /pull-request number/)
  assert.deepEqual(codesIn("commit 1a2b3c4d5e"), ["a commit hash"])
  assert.deepEqual(codesIn("The simulated image now matches the real one in brightness."), [])
  await fx.call("ses_pm", "summary", { kind: "front", key: "G1", text: "The simulated image now matches the real capture in brightness; texture is next." })
  await fx.call("ses_pm", "summary", { kind: "decision", key: "d1", text: "Approve a run that uses most of the computer's memory." })
  const status = renderPages(fx.rt.ledger, fx.rt.profile).find((p) => p.path === fx.rt.profile.render.status)?.content ?? ""
  assert.match(status, /A product like the real one: The simulated image now matches/)
  assert.match(status, /Approve a run that uses most of the computer's memory/)
  assert.equal(codesIn(status.replace(/<!--.*?-->/s, "")).length, 0, "the generated page contains no code")
})

test("the role prompt carries the item, the waiting questions and the tools of the role only", async () => {
  const { fx, id, n } = await worked()
  await fx.call("ses_co", "ask", { to: n.ana, text: "Which branch name do you use?", item: id })
  const prompt = buildPrompt(fx.rt, "ses_ana", { id: "grok-4.7", variant: "xhigh" })
  assert.match(prompt, new RegExp(`Your name is ${n.ana} and your role is engineer`))
  assert.match(prompt, /Eng\. .* grok-4\.7#xhigh/)
  assert.match(prompt, new RegExp(`Your item: ${id} \\[in_progress\\] Write the product`))
  assert.match(prompt, /Waiting for your answer/)
  assert.match(prompt, /coordination_claim/)
  assert.doesNotMatch(prompt, /coordination_assign|coordination_propose/)
  assert.match(buildPrompt(fx.rt, "ses_co"), /coordination_assign/)
  assert.match(buildPrompt(fx.rt, "ses_pm"), /coordination_propose/)
  assert.ok(prompt.split("\n").length < 30)
})

test("legacy agent-mail records import once, with their ids and times, and are never redelivered", async () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-"))
  mkdirSync(join(root, "records"))
  const rec = (id: string, at: string) => ({ id, at, threadId: "t", from: { kind: "claude", id: "c1", name: "boss" }, to: { kind: "opencode", id: "ses_x", name: "Ana" }, text: `text ${id}`, transport: "claude", direction: "in", status: "recorded" })
  writeFileSync(join(root, "records", "a.json"), JSON.stringify(rec("11111111-aaaa", "2026-10-23T10:00:00.000Z")))
  writeFileSync(join(root, "records", "b.json"), JSON.stringify(rec("22222222-bbbb", "2026-10-23T09:00:00.000Z")))
  writeFileSync(join(root, "records", "bad.json"), "{not json")
  const ledger = await Ledger.open(":memory:", "/repo/.git")
  assert.deepEqual(importAgentMail(ledger, root), { read: 3, imported: 2, skipped: 0, invalid: 1 })
  assert.deepEqual(importAgentMail(ledger, root), { read: 3, imported: 0, skipped: 2, invalid: 1 })
  const m = ledger.message("22222222-bbbb")
  assert.equal(m?.at, "2026-10-23T09:00:00.000Z")
  assert.equal(m?.transport, "imported")
  assert.equal(ledger.claimPending("ses_x", new Date()).length, 0)
  const resolved = ledger.resolveMessage("11111111")
  assert.ok("found" in resolved)
  assert.equal(ledger.events({ type: "message.sent" })[0]?.actor.name, "agent-mail")
})

test("the whole real agent-mail store imports without loss when it is present (read only)", { skip: !process.env.AGENT_MAIL_STORE }, async () => {
  const ledger = await Ledger.open(":memory:", "/repo/.git")
  const result = importAgentMail(ledger, process.env.AGENT_MAIL_STORE as string)
  assert.equal(result.invalid, 0)
  assert.equal(result.imported + result.skipped, result.read)
  assert.equal(ledger.messages().length, result.imported)
})

test("a status line may say and/or, 24/7 or a plain figure: only real codes, paths and hashes are refused", async () => {
  assert.deepEqual(codesIn("The service now answers 24/7 and/or within a second; it handled 1200000 requests."), [])
  assert.deepEqual(codesIn("See src/product/writer.go"), ["a file path", "a file name"])
  assert.deepEqual(codesIn("Fixed by commit 9f1c2a7"), ["a commit hash"])
})
