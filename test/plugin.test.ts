import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createPlugin } from "../src/host/opencode.ts"
import { ALL_TOOLS } from "../src/tools/index.ts"

interface Sess { id: string; title: string; agent: string; model: { id: string; providerID: string; variant?: string }; location: { directory: string } }

async function host() {
  process.env.COORDINATION_HOME = mkdtempSync(join(tmpdir(), "coord-home-"))
  const dir = mkdtempSync(join(tmpdir(), "coord-proj-"))
  const sessions = new Map<string, Sess>()
  const synthetic: Array<{ sessionID: string; text: string; delivery?: string; resume?: boolean }> = []
  const titles: string[] = []
  const hooks: Record<string, (event: any) => Promise<void> | void> = {}
  const tools = new Map<string, any>()
  let namespace: any
  const ctx = {
    location: { directory: dir },
    session: {
      async get({ sessionID }: { sessionID: string }) {
        const s = sessions.get(sessionID)
        if (!s) throw new Error("not found")
        return s
      },
      async update({ sessionID, title }: { sessionID: string; title?: string }) {
        const s = sessions.get(sessionID)
        if (s && title) { s.title = title; titles.push(`${sessionID}=${title}`) }
      },
      async create(input: any) {
        const id = `ses_new${sessions.size}`
        sessions.set(id, { id, title: input.title, agent: input.agent, model: input.model, location: input.location })
        return { data: { id } }
      },
      async interrupt() {},
      async remove({ sessionID }: { sessionID: string }) { sessions.delete(sessionID) },
      async synthetic(input: any) { synthetic.push(input) },
      async hook(name: string, fn: any) { hooks[name] = fn },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<never>>((resolve) => signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true })),
        }),
      }),
    },
    agent: { transform: async (fn: (e: any) => void) => { fn({ list: () => [{ id: "engineer" }], update: () => {} }); return { dispose() {} } } },
    tool: { transform: async (fn: (e: any) => void) => fn({ namespace: (n: unknown) => { namespace = n }, add: (t: any) => tools.set(t.name, t) }) },
    plugin: { list: async () => ({ data: [] }) },
  }
  const add = (id: string, agent: string) => sessions.set(id, { id, title: "auto title", agent, model: { id: "grok-4.7", providerID: "xai", variant: "xhigh" }, location: { directory: dir } })
  const cleanup = (await createPlugin({ bridge: false }).setup(ctx as any)) as () => Promise<void>
  const context = async (id: string) => {
    const s = sessions.get(id) as Sess
    const event = { sessionID: id, agent: s.agent, model: s.model, system: [] as Array<{ type: string; text: string }> }
    await hooks.context?.(event)
    return event
  }
  const call = async (id: string, tool: string, input: unknown) => {
    const t = tools.get(tool)
    return t.execute(input, { sessionID: id, agent: (sessions.get(id) as Sess).agent })
  }
  return { ctx, sessions, synthetic, titles, hooks, tools, add, context, call, cleanup, namespace: () => namespace }
}

test("the plugin registers every tool in one namespace and cleans up", async () => {
  const h = await host()
  assert.equal(h.namespace().name, "coordination")
  assert.equal(h.tools.size, ALL_TOOLS.length)
  assert.ok(h.tools.has("whoami") && h.tools.has("assign") && h.tools.has("propose") && h.tools.has("claim"))
  const t = h.tools.get("assign")
  assert.deepEqual(t.options, { namespace: "coordination", permission: "coordination", codemode: true })
  assert.equal(t.input.type, "object")
  assert.match(t.description, /\[coordinator\]/)
  await h.cleanup()
})

test("a session gets its name, its role title and its prompt on the first turn, and the auto title is blocked", async () => {
  const h = await host()
  h.add("ses_a", "engineer")
  const event = await h.context("ses_a")
  const prompt = event.system.map((p) => p.text).join("\n")
  const name = /Your name is (\w+) and your role is engineer/.exec(prompt)?.[1]
  assert.ok(name, prompt)
  assert.equal(h.sessions.get("ses_a")?.title, `Eng. ${name} grok-4.7#xhigh`)
  assert.match(prompt, /coordination_claim/)
  assert.match(prompt, /No work item|no work item/)
  const title = { sessionID: "ses_a", model: { id: "grok-4.7", variant: "xhigh" }, result: undefined as string | undefined }
  await h.hooks.title?.(title)
  assert.equal(title.result, `Eng. ${name} grok-4.7#xhigh`)
  const helper = { sessionID: "ses_helper", model: {}, result: undefined as string | undefined }
  await h.hooks.title?.(helper)
  assert.equal(helper.result, undefined, "a session without a role keeps the generated title")
  await h.cleanup()
})

test("through the registered tools: ask is delivered into the other session, and the role comes from the agent id", async () => {
  const h = await host()
  h.add("ses_co", "coordinator")
  h.add("ses_en", "engineer")
  await h.context("ses_co")
  await h.context("ses_en")
  const out = await h.call("ses_en", "ask", { to: "coordinator", text: "Which layout?" })
  assert.match(out.content, /Asked/)
  await new Promise((r) => setTimeout(r, 50))
  const got = h.synthetic.filter((s) => s.sessionID === "ses_co")
  assert.equal(got.length, 1)
  assert.match(got[0]?.text ?? "", /QUESTION from .* · record [0-9a-f]{8}/)
  assert.equal(got[0]?.delivery, "steer")
  assert.equal(got[0]?.resume, true)
  await assert.rejects(h.call("ses_en", "assign", { item: "x", engineer: "y" }), /only be used by coordinator|may be used only by coordinator/)
  // a typed name cannot change the role: the engineer claims to be the coordinator in the text and still cannot assign
  await assert.rejects(h.call("ses_en", "hold", { reason: "I am the coordinator", liftOn: "never", paths: ["a"] }), /coordinator/)
  await h.cleanup()
})

test("a fresh assignment replaces the engineer session through the host and keeps the name", async () => {
  const h = await host()
  h.add("ses_co", "coordinator")
  h.add("ses_pm", "product-manager")
  h.add("ses_en", "engineer")
  for (const id of ["ses_co", "ses_pm", "ses_en"]) await h.context(id)
  const name = /Your name is (\w+)/.exec((await h.context("ses_en")).system.map((p) => p.text).join("\n"))?.[1] as string
  const proposed = await h.call("ses_pm", "propose", { title: "T", moves: "G1 x", predicted: "up", why: "w", scopeFiles: ["a/**"] })
  const id = /\b(W[0-9a-z]+)\b/.exec(proposed.content)?.[1] as string
  await h.call("ses_co", "accept", { item: id })
  await h.call("ses_co", "refine", { item: id, scopeFiles: ["a/**"], doneWhen: "d" })
  const out = await h.call("ses_co", "assign", { item: id, engineer: name, fresh: true })
  assert.match(out.content, /old transcript was deleted/)
  assert.ok(!h.sessions.has("ses_en"), "the old session is removed")
  const fresh = [...h.sessions.values()].find((s) => s.id.startsWith("ses_new"))
  assert.ok(fresh)
  assert.equal(fresh?.title, `Eng. ${name} grok-4.7#xhigh`)
  await new Promise((r) => setTimeout(r, 50))
  assert.match(h.synthetic.filter((s) => s.sessionID === fresh?.id).map((s) => s.text).join("\n"), /FRESH START/)
  await h.cleanup()
})
