import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createPlugin } from "../src/host/opencode.ts"
import { ALL_TOOLS } from "../src/tools/index.ts"

interface Sess { id: string; title: string; agent: string; model: { id: string; providerID: string; variant?: string }; location: { directory: string }; parentID?: string }

async function host(profile?: Record<string, unknown>) {
  process.env.COORDINATION_HOME = mkdtempSync(join(tmpdir(), "coord-home-"))
  const dir = mkdtempSync(join(tmpdir(), "coord-proj-"))
  if (profile) {
    mkdirSync(join(dir, ".opencode"))
    writeFileSync(join(dir, ".opencode", "coordination.json"), JSON.stringify(profile))
  }
  const sessions = new Map<string, Sess>()
  const synthetic: Array<{ sessionID: string; text: string; delivery?: string; resume?: boolean }> = []
  const titles: string[] = []
  const hooks: Record<string, (event: any) => Promise<void> | void> = {}
  const tools = new Map<string, any>()
  const commands = new Map<string, any>()
  let receive: ((event: IteratorResult<any>) => void) | undefined
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
          next: () => new Promise<IteratorResult<any>>((resolve) => {
            receive = resolve
            signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true })
          }),
        }),
      }),
    },
    agent: { transform: async (fn: (e: any) => void) => { fn({ list: () => [{ id: "engineer" }], update: () => {} }); return { dispose() {} } } },
    tool: { transform: async (fn: (e: any) => void) => fn({ namespace: (n: unknown) => { namespace = n }, add: (t: any) => tools.set(t.name, t) }) },
    command: { transform: async (fn: (e: any) => void) => fn({ add: (command: any) => commands.set(command.name, command) }) },
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
  const emit = async (event: any) => {
    assert.ok(receive)
    receive({ done: false, value: event })
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return { ctx, sessions, synthetic, titles, hooks, tools, commands, emit, add, context, call, cleanup, namespace: () => namespace }
}

test("the plugin registers every tool in one namespace and cleans up", async () => {
  const h = await host()
  assert.equal(h.namespace().name, "coordination")
  assert.equal(h.tools.size, ALL_TOOLS.length)
  assert.deepEqual([...h.commands.keys()], ["enable-go-horse", "disable-go-horse"])
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

test("ordinary sessions keep their context and title, including after a manual coordination call", async (t) => {
  const h = await host()
  t.after(h.cleanup)
  for (const agent of ["build", "plan", "explore", "general", "custom", ""]) {
    const id = `ses_helper_${agent}`
    h.add(id, agent)
    assert.deepEqual((await h.context(id)).system, [], agent)
    assert.match((await h.call(id, "whoami", {})).content, /\(other\)/, agent)
    const event = { sessionID: id, agent, model: {}, system: [{ type: "text", text: "Original instructions" }] }
    await h.hooks.context?.(event)
    assert.deepEqual(event.system, [{ type: "text", text: "Original instructions" }], agent)
    assert.equal(h.sessions.get(id)?.title, "auto title", agent)
  }
})

test("only role sessions receive automatic replies; an ordinary session can read its inbox manually", async (t) => {
  const h = await host()
  t.after(h.cleanup)
  h.add("ses_co", "coordinator")
  h.add("ses_helper", "build")
  await h.context("ses_co")
  await h.context("ses_helper")
  const asked = await h.call("ses_helper", "ask", { to: "coordinator", text: "Which layout?" })
  const message = /record ([0-9a-f]{8})/.exec(asked.content)?.[1]
  assert.ok(message)
  await h.call("ses_co", "answer", { message, text: "Use the compact layout." })
  await h.emit({ type: "session.status", data: { sessionID: "ses_helper", status: { type: "busy" } } })
  await h.emit({ type: "session.idle", data: { sessionID: "ses_helper" } })
  assert.equal(h.synthetic.filter((m) => m.sessionID === "ses_helper").length, 0)
  const inbox = (await h.call("ses_helper", "received", {})).content
  assert.match(inbox, /Use the compact layout\./)
  assert.match(inbox, /not yet delivered/)
  assert.deepEqual((await h.context("ses_helper")).system, [])
})

test("switching to an ordinary agent pauses automatic coordination without changing the bound role", async (t) => {
  const h = await host()
  t.after(h.cleanup)
  h.add("ses_co", "coordinator")
  h.add("ses_en", "engineer")
  await h.context("ses_co")
  const prompt = (await h.context("ses_en")).system.map((p) => p.text).join("\n")
  const name = /Your name is (\w+)/.exec(prompt)?.[1]
  assert.ok(name)
  ;(h.sessions.get("ses_en") as Sess).agent = "build"
  await h.call("ses_co", "ask", { to: name, text: "Which branch?" })
  assert.equal(h.synthetic.filter((m) => m.sessionID === "ses_en").length, 0)
  assert.deepEqual((await h.context("ses_en")).system, [])
  const title = { sessionID: "ses_en", model: {}, result: "generated title" }
  await h.hooks.title?.(title)
  assert.equal(title.result, "generated title")
  ;(h.sessions.get("ses_en") as Sess).agent = "engineer"
  assert.match((await h.context("ses_en")).system.map((p) => p.text).join("\n"), /your role is engineer/)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(h.synthetic.filter((m) => m.sessionID === "ses_en" && /Which branch\?/.test(m.text)).length, 1)
})

test("configured role aliases receive coordination prompts and automatic messages", async (t) => {
  const roles = { coordinator: ["coord"], "product-manager": ["pm"], engineer: ["eng"] } as const
  const h = await host({ roles })
  t.after(h.cleanup)
  for (const [role, [agent]] of Object.entries(roles)) {
    h.add(`ses_${role}`, agent)
    assert.match((await h.context(`ses_${role}`)).system.map((p) => p.text).join("\n"), new RegExp(`your role is ${role}`))
  }
  for (const role of Object.keys(roles)) {
    const sender = role === "coordinator" ? "product-manager" : "coordinator"
    await h.call(`ses_${sender}`, "ask", { to: role, text: `Question for ${role}` })
    assert.equal(h.synthetic.filter((m) => m.sessionID === `ses_${role}`).length, 1, role)
  }
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

test("the role is bound through the host: an agent switch and a subagent do not reach the coordinator's tools", async () => {
  const h = await host()
  try {
    h.add("ses_en", "engineer")
    h.add("ses_co", "coordinator")
    await h.context("ses_en")
    await h.context("ses_co")
    // the engineer session switches its agent to coordinator: the tools still see an engineer, and the title stays
    ;(h.sessions.get("ses_en") as Sess).agent = "coordinator"
    await assert.rejects(h.call("ses_en", "hold", { reason: "now I coordinate", liftOn: "never", paths: ["a"] }), /only by coordinator/)
    const prompt = (await h.context("ses_en")).system.map((p) => p.text).join("\n")
    assert.match(prompt, /your role is engineer/)
    assert.match(h.sessions.get("ses_en")?.title ?? "", /^Eng\. /)
    // a subagent of the coordinator that runs the coordinator agent is nobody in particular
    h.sessions.set("ses_sub", { ...(h.sessions.get("ses_co") as Sess), id: "ses_sub", title: "auto title", parentID: "ses_co" })
    const sub = await h.context("ses_sub")
    assert.deepEqual(sub.system, [], "a subagent receives no coordination prompt")
    await assert.rejects(h.call("ses_sub", "accept", { item: "x" }), /only by coordinator/)
    assert.equal(h.sessions.get("ses_sub")?.title, "auto title", "no managed title for a subagent")
  } finally {
    await h.cleanup()
  }
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

test("slash command and timer wake an idle PM through the host; disable stops further wake-ups", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date("2026-10-27T10:00:00Z") })
  const h = await host()
  t.after(async () => { await h.cleanup(); t.mock.timers.reset() })
  h.add("ses_pm", "product-manager")
  await h.context("ses_pm")
  await h.commands.get("enable-go-horse").execute({ sessionID: "ses_pm" })
  assert.ok(h.synthetic.some((m) => /GO HORSE enabled/.test(m.text)))
  await h.emit({ type: "session.idle", data: { sessionID: "ses_pm" } })
  t.mock.timers.tick(14 * 60_000)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(h.synthetic.filter((m) => /GO HORSE 1\/10/.test(m.text)).length, 0)
  t.mock.timers.tick(60_000)
  await new Promise<void>((resolve) => setImmediate(resolve))
  const wake = h.synthetic.find((m) => /GO HORSE 1\/10/.test(m.text))
  assert.ok(wake)
  assert.equal(wake.sessionID, "ses_pm")
  assert.equal(wake.delivery, "steer")
  assert.equal(wake.resume, true)
  await h.commands.get("disable-go-horse").execute({ sessionID: "ses_pm" })
  await h.emit({ type: "session.status", data: { sessionID: "ses_pm", status: { type: "idle" } } })
  t.mock.timers.tick(3 * 60 * 60_000)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(h.synthetic.filter((m) => /GO HORSE \d+\/10/.test(m.text)).length, 1)
})
