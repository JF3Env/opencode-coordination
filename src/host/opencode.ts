import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"
import { bindBridge, type Bridge } from "../bridge/bridge.ts"
import { tick } from "../clock/clock.ts"
import { loadProfile } from "../config/profile.ts"
import { pull } from "../deliver/deliver.ts"
import { roleOf, roleSessionTitle, type TitleModel } from "../domain/roles.ts"
import type { Actor } from "../domain/types.ts"
import { Ledger } from "../ledger/ledger.ts"
import { buildPrompt } from "../prompt/prompt.ts"
import { renderPages, writePages } from "../render/render.ts"
import { registerSession, type HostControl, type Runtime } from "../runtime.ts"
import { ledgerPathFor, scopeOf } from "../scope.ts"
import { makeGitHub, syncPullRequests, type Gh } from "../github/sync.ts"
import { ALL_TOOLS, callTool } from "../tools/index.ts"
import { roleLabel } from "../tools/define.ts"
import { ToolFailure } from "../runtime.ts"

const exec = promisify(execFile)

// The part of the OpenCode plugin context this plugin uses. Typed loosely on purpose: the host owns the real types,
// and the plugin must keep loading when they grow.
interface HostSession {
  id?: string
  title?: string
  agent?: string
  model?: TitleModel
  parentID?: string
  location?: { directory?: string }
  permissions?: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>
}
interface HostContext {
  location: { directory: string }
  session: {
    get(input: { sessionID: string }): Promise<unknown>
    update?(input: { sessionID: string; title?: string; archived?: boolean }): Promise<unknown>
    create?(input: Record<string, unknown>): Promise<unknown>
    interrupt?(input: { sessionID: string; resume?: boolean }): Promise<unknown>
    remove?(input: { sessionID: string }): Promise<unknown>
    synthetic(input: { sessionID: string; text: string; delivery?: "steer" | "queue"; resume?: boolean }): Promise<unknown>
    hook(name: string, handler: (event: any) => Promise<void> | void): Promise<unknown>
  }
  event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<{ type: string; data?: any; location?: { directory?: string } }> }
  agent: { transform(fn: (editor: any) => void): Promise<{ dispose(): Promise<void> | void }> }
  tool: { transform(fn: (editor: any) => void): Promise<unknown> }
  plugin: { list(filter: unknown, options: { signal: AbortSignal }): Promise<{ data: Array<{ id: string; state: { status: string } }> }> }
}

// sessionView accepts the session itself or the API envelope { data }.
function sessionView(value: unknown): HostSession {
  if (!value || typeof value !== "object") return {}
  const record = value as HostSession & { data?: HostSession }
  const nested = record.data
  if (nested && typeof nested === "object" && ("id" in nested || "title" in nested || "location" in nested || "agent" in nested)) return nested
  return record
}

const ROLE_TITLE_EVENTS = new Set(["session.created", "session.next.agent.switched", "session.next.model.switched", "session.agent.selected", "session.model.selected"])

function eventSession(event: { data?: any }): string | undefined {
  const d = event.data
  return d?.sessionID || d?.info?.id || d?.properties?.sessionID || d?.properties?.info?.id
}

const ghRunner: Gh = async (args) => (await exec("gh", args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })).stdout

export interface PluginOptions {
  /** Bind the Claude Code socket. Default true; COORDINATION_BRIDGE=off also turns it off. */
  bridge?: boolean
}

export function createPlugin(options: PluginOptions = {}) {
  return {
    id: "coordination",
    async setup(ctx: HostContext) {
      const scope = await scopeOf(ctx.location.directory)
      const profile = loadProfile(ctx.location.directory)
      const ledger = await Ledger.open(ledgerPathFor(scope), scope)
      const sessions = ctx.session

      const host: HostControl = {
        async deliver(sessionID, text) {
          await sessions.synthetic({ sessionID, text, delivery: "steer", resume: true })
        },
        async liveSessions(candidates) {
          const live = new Set<string>()
          for (const id of candidates) {
            try {
              await sessions.get({ sessionID: id })
              live.add(id)
            } catch {
              // not found: the session is gone
            }
          }
          return live
        },
        async setTitle(sessionID, title) {
          await sessions.update?.({ sessionID, title })
        },
        async replaceSession(input) {
          if (!sessions.create) throw new Error("This host cannot start a replacement session.")
          const info = sessionView(await sessions.get({ sessionID: input.sessionID }))
          const model = info.model?.id && info.model.providerID ? { id: info.model.id, providerID: info.model.providerID, variant: info.model.variant } : undefined
          const title = roleSessionTitle("engineer", input.name, info.model) ?? `Eng. ${input.name}`
          await sessions.interrupt?.({ sessionID: input.sessionID, resume: false }).catch(() => undefined)
          const created = sessionView(await sessions.create({ title, agent: info.agent || input.agent, model, location: { directory: info.location?.directory || input.directory }, permissions: info.permissions }))
          if (!created.id) throw new Error("The replacement session was not created.")
          let removed = false
          try {
            if (!sessions.remove) throw new Error("no remove")
            await sessions.remove({ sessionID: input.sessionID })
            removed = true
          } catch {
            await sessions.update?.({ sessionID: input.sessionID, archived: true, title: `retired ${input.name}` }).catch(() => undefined)
          }
          return { sessionID: created.id, removed }
        },
      }

      const rt: Runtime = { ledger, profile, now: () => ledger.now(), host }
      rt.wake = (sessionID) => void pull(rt, sessionID)
      const github = profile.github.repo ? makeGitHub(profile.github.repo, ghRunner, profile.github.baseBranch) : undefined
      if (github) rt.github = github

      let bridge: Bridge | undefined
      if (options.bridge !== false && process.env.COORDINATION_BRIDGE !== "off") {
        try {
          bridge = await bindBridge(rt)
          rt.claude = bridge
        } catch (error) {
          console.error("coordination: Claude Code inbox not bound:", error instanceof Error ? error.message : error)
        }
      }

      // The host's own tool error shows the message to the model cleanly; fall back to ours when it is not importable.
      const toolErrorModule = "@opencode/plugin/promise/tool"
      let HostToolError: (new (input: { message: string }) => Error) | undefined
      try {
        HostToolError = ((await import(toolErrorModule)) as { Error: new (input: { message: string }) => Error }).Error
      } catch {
        HostToolError = undefined
      }
      const toToolError = (message: string): Error => (HostToolError ? new HostToolError({ message }) : new ToolFailure(message))

      // ---- sessions: registration, title, prompt -------------------------------------------------------------------
      const titleJobs = new Map<string, Promise<void>>()
      const refresh = async (sessionID: string, agent: string, directory: string, model?: TitleModel, parent?: string): Promise<ReturnType<typeof registerSession>> => {
        const me = registerSession(rt, { sessionID, agent, directory, model, parent })
        const wanted = roleSessionTitle(me.role, me.name, model)
        if (wanted) {
          try {
            const current = sessionView(await sessions.get({ sessionID })).title
            if (current !== wanted) await sessions.update?.({ sessionID, title: wanted })
          } catch {
            // Mail keeps working if the title write is refused.
          }
        }
        return me
      }
      const queueTitle = (sessionID: string) => {
        if (titleJobs.has(sessionID)) return
        const job = (async () => {
          try {
            const info = sessionView(await sessions.get({ sessionID }))
            if (info.agent && !info.parentID && roleOf(info.agent, profile.roles) !== "other") await refresh(sessionID, info.agent, info.location?.directory || ctx.location.directory, info.model, info.parentID)
          } catch {
            // a missing session is not a coordination failure
          }
        })().finally(() => titleJobs.delete(sessionID))
        titleJobs.set(sessionID, job)
      }

      const active = new Set<string>()
      await sessions.hook("context", async (event) => {
        active.add(event.sessionID)
        const info = sessionView(await sessions.get({ sessionID: event.sessionID }).catch(() => undefined))
        const directory = info.location?.directory || ctx.location.directory
        if ((await scopeOf(directory)) !== scope) return
        await refresh(event.sessionID, event.agent, directory, event.model, info.parentID)
        const text = buildPrompt(rt, event.sessionID, event.model)
        if (text) event.system.push({ type: "text", text })
        void pull(rt, event.sessionID)
      })
      await sessions.hook("title", async (event) => {
        const agent = rt.ledger.agent(event.sessionID)
        if (!agent || agent.role === "other") return
        const title = roleSessionTitle(agent.role, agent.name, event.model)
        if (title) event.result = title
      })

      // ---- tools ---------------------------------------------------------------------------------------------------
      await ctx.tool.transform((editor) => {
        editor.namespace({ name: "coordination", description: "Roles, work items, messages, progress and history. The ledger keeps the record; do not keep your own." })
        for (const spec of ALL_TOOLS) {
          editor.add({
            name: spec.name,
            description: `${spec.description} [${roleLabel(spec)}]`,
            input: z.toJSONSchema(spec.input, { io: "input" }),
            options: { namespace: "coordination", permission: "coordination", codemode: true },
            async execute(input: unknown, context: { sessionID: string; agent: string }) {
              const known = rt.ledger.agent(context.sessionID)
              if (!known || known.agent !== context.agent) {
                const info = sessionView(await sessions.get({ sessionID: context.sessionID }).catch(() => undefined))
                await refresh(context.sessionID, context.agent, info.location?.directory || ctx.location.directory, info.model, info.parentID)
              }
              // The role is the one the ledger bound to this session, never the agent id of the moment.
              const me = rt.ledger.agent(context.sessionID)
              const actor: Actor = { session: context.sessionID, name: me?.name ?? context.sessionID, role: me?.role ?? "other" }
              try {
                return { content: await callTool(rt, spec, actor, input) }
              } catch (error) {
                if (error instanceof ToolFailure) throw toToolError(error.message)
                throw error
              }
            },
          })
        }
      })

      const grant = (editor: any) => {
        for (const agent of editor.list()) {
          editor.update(agent.id, (draft: { permissions: unknown[] }) => draft.permissions.push({ action: "coordination", resource: "*", effect: "allow" }))
        }
      }
      let registration = await ctx.agent.transform(grant)

      // ---- events, delivery, clock ---------------------------------------------------------------------------------
      const controller = new AbortController()
      const events = (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) return
          const sessionID = eventSession(event)
          if (event.type === "session.status" && sessionID) {
            const status = event.data?.status?.type
            if (status === "busy" || status === "retry") {
              active.add(sessionID)
              void pull(rt, sessionID)
            } else active.delete(sessionID)
            const known = rt.ledger.agent(sessionID)
            const next = status === "busy" || status === "retry" ? "busy" : "idle"
            if (known && known.status !== next) rt.ledger.append({ type: "agent.status", actor: { session: sessionID, name: known.name, role: known.role }, payload: { sessionID, status: next } })
            continue
          }
          if (event.type === "session.idle" && sessionID) {
            active.delete(sessionID)
            void pull(rt, sessionID)
            continue
          }
          if (ROLE_TITLE_EVENTS.has(event.type) && sessionID) queueTitle(sessionID)
          if (event.type !== "agent.updated" || event.location?.directory !== ctx.location.directory) continue
          const plugins = await ctx.plugin.list(undefined, { signal: controller.signal })
          if (!plugins.data.some((p) => p.id === "opencode.config.agent" && p.state.status === "active")) continue
          await registration.dispose()
          if (controller.signal.aborted) return
          registration = await ctx.agent.transform(grant)
        }
      })().catch((error) => {
        if (!controller.signal.aborted) console.error("coordination: event loop failed", error)
      })

      const poll = setInterval(() => {
        for (const id of active) void pull(rt, id)
      }, 1000)
      const clock = setInterval(() => {
        void (async () => {
          try {
            await tick(rt)
            const due = Date.now() - Date.parse(rt.ledger.meta("last_sync") ?? "0") >= profile.github.syncMinutes * 60_000
            if (github && due) {
              rt.ledger.setMeta("last_sync", new Date().toISOString())
              await syncPullRequests(rt, github)
            }
            if (profile.render.auto) writePages(ctx.location.directory, renderPages(rt.ledger, profile))
          } catch (error) {
            console.error("coordination: clock tick failed", error instanceof Error ? error.message : error)
          }
        })()
      }, 60_000)
      // Sessions already known (a server restart) get their role title back.
      for (const a of rt.ledger.agents((x) => x.status !== "gone" && x.role !== "other")) queueTitle(a.sessionID)

      return async () => {
        clearInterval(poll)
        clearInterval(clock)
        controller.abort()
        // The host ends the stream on abort; do not wait on it forever if it does not.
        await Promise.race([events.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))])
        await Promise.resolve(registration.dispose()).catch(() => {})
        await bridge?.close()
        ledger.close()
      }
    },
  }
}
