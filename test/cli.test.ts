import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { run } from "../src/cli/main.ts"

function env() {
  process.env.COORDINATION_HOME = mkdtempSync(join(tmpdir(), "coord-cli-home-"))
  return mkdtempSync(join(tmpdir(), "coord-cli-proj-"))
}

async function cli(dir: string, ...argv: string[]) {
  const lines: string[] = []
  const code = await run([...argv, "--dir", dir], (t) => lines.push(t))
  return { code, text: lines.join("\n") }
}

test("the CLI acts as declared Claude Code sessions: propose, read the board, render, check, and the pages go stale on a hand edit", async () => {
  const dir = env()
  mkdirSync(join(dir, ".opencode"))
  writeFileSync(join(dir, ".opencode", "coordination.json"), JSON.stringify({ fronts: [{ id: "G1", title: "A product" }] }))
  const proposal = JSON.stringify({ title: "Write it", front: "G1", moves: "G1.1 reach", predicted: "up", why: "constraint", scopeFiles: ["src/**"] })
  const denied = await cli(dir, "call", "propose", proposal, "--as", "boss", "--role", "engineer")
  assert.equal(denied.code, 1)
  assert.match(denied.text, /only by product-manager/)
  const stillDenied = await cli(dir, "call", "propose", proposal, "--as", "boss", "--role", "product-manager")
  assert.equal(stillDenied.code, 1, "a declared role cannot be changed by a flag later")
  const ok = await cli(dir, "call", "propose", proposal, "--as", "boss2", "--role", "product-manager")
  assert.equal(ok.code, 0, ok.text)
  const id = /\b(W[0-9a-z]+)\b/.exec(ok.text)?.[1] as string
  assert.match((await cli(dir, "board")).text, new RegExp(`G1 — A product[\\s\\S]*Later:[\\s\\S]*${id} \\[proposed\\] Write it`))
  assert.match((await cli(dir, "item", id)).text, /item\.proposed by boss2/)
  assert.match((await cli(dir, "status")).text, /items: 1/)
  assert.equal((await cli(dir, "render", "--check")).code, 1, "nothing rendered yet: stale")
  assert.equal((await cli(dir, "render")).code, 0)
  assert.equal((await cli(dir, "render", "--check")).code, 0)
  writeFileSync(join(dir, "docs/coordination/ACTIVE.md"), `${readFileSync(join(dir, "docs/coordination/ACTIVE.md"), "utf8")}\nhand edit\n`)
  const stale = await cli(dir, "render", "--check")
  assert.equal(stale.code, 1)
  assert.match(stale.text, /docs\/coordination\/ACTIVE\.md/)
  const exported = (await cli(dir, "export")).text.split("\n").map((l) => JSON.parse(l))
  assert.ok(exported.some((e) => e.type === "item.proposed" && e.actor.name === "boss2"))
})

test("a message to a CLI session waits in its inbox and is printed once", async () => {
  const dir = env()
  await cli(dir, "call", "whoami", "{}", "--as", "pm1", "--role", "product-manager")
  await cli(dir, "call", "whoami", "{}", "--as", "co1", "--role", "coordinator")
  const asked = await cli(dir, "call", "ask", JSON.stringify({ to: "co1", text: "Which front first?" }), "--as", "pm1", "--role", "product-manager")
  assert.equal(asked.code, 0, asked.text)
  const inbox = await cli(dir, "inbox", "--as", "co1")
  assert.match(inbox.text, /QUESTION from pm1/)
  assert.match(inbox.text, /Which front first\?/)
  assert.match((await cli(dir, "inbox", "--as", "co1")).text, /No message is waiting/)
})

test("the CLI cannot act as an OpenCode session: identity there is the host's, not the caller's", async () => {
  const dir = env()
  // register an OpenCode session directly in the ledger of this scope
  const { Ledger } = await import("../src/ledger/ledger.ts")
  const { ledgerPathFor, scopeOf } = await import("../src/scope.ts")
  const scope = await scopeOf(dir)
  const l = await Ledger.open(ledgerPathFor(scope), scope)
  const actor = { session: "ses_x", name: "Ana", role: "engineer" as const }
  l.appendMany([
    { type: "agent.seen", actor, payload: { sessionID: "ses_x", role: "engineer", agent: "engineer", directory: dir, kind: "opencode" } },
    { type: "agent.named", actor, payload: { sessionID: "ses_x", name: "Ana" } },
  ])
  l.close()
  const r = await cli(dir, "call", "progress", JSON.stringify({ item: "x", line: "done" }), "--as", "Ana", "--role", "engineer")
  assert.equal(r.code, 1)
  assert.match(r.text, /OpenCode session; the CLI cannot act as it/)
})

test("the built binary runs under plain node", { skip: !existsSync(join(process.cwd(), "dist/cli/main.js")) && "run npm run build first" }, () => {
  const dir = env()
  const out = execFileSync("node", [join(process.cwd(), "dist/cli/main.js"), "status", "--dir", dir], { env: { ...process.env, COORDINATION_HOME: process.env.COORDINATION_HOME } }).toString()
  assert.match(out, /events: 0/)
})
