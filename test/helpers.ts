import { Ledger } from "../src/ledger/ledger.ts"
import { defaultProfile, parseProfile, type Profile } from "../src/config/profile.ts"
import { callTool, toolByName } from "../src/tools/index.ts"
import { actorFor, registerSession, type GitHubLink, type HostControl, type PrInfo, type Runtime } from "../src/runtime.ts"

export interface Fixture {
  rt: Runtime
  clock: { now: Date; advance(ms: number): void }
  delivered: Array<{ sessionID: string; text: string }>
  hostCalls: string[]
  prs: Map<string, PrInfo>
  recordsOnMain: Set<string>
  call(session: string, tool: string, input?: unknown): Promise<string>
  callFail(session: string, tool: string, input?: unknown): Promise<string>
  register(session: string, agent: string, extra?: { directory?: string }): void
  sessions: Set<string>
}

export async function fixture(profile: Partial<Profile> | Record<string, unknown> = {}, opts: { github?: boolean; replace?: boolean } = {}): Promise<Fixture> {
  const clock = {
    now: new Date("2026-10-25T10:00:00.000Z"),
    advance(ms: number) { this.now = new Date(this.now.getTime() + ms) },
  }
  const delivered: Fixture["delivered"] = []
  const hostCalls: string[] = []
  const sessions = new Set<string>()
  const prs = new Map<string, PrInfo>()
  const recordsOnMain = new Set<string>()
  let replaced = 0
  const host: HostControl = {
    async deliver(sessionID, text) { delivered.push({ sessionID, text }) },
    async liveSessions(candidates) { return new Set(candidates.filter((id) => sessions.has(id))) },
    async replaceSession(input) {
      replaced++
      const sessionID = `${input.sessionID}-new${replaced}`
      hostCalls.push(`replace ${input.sessionID} -> ${sessionID}`)
      sessions.add(sessionID)
      return { sessionID, removed: true }
    },
  }
  const github: GitHubLink = {
    async prForItem(branch, pr) {
      return [...prs.values()].find((p) => p.number === pr || (branch && prs.get(branch) === p))
    },
    async recordOnMain(path) { return recordsOnMain.has(path) },
  }
  const ledger = await Ledger.open(":memory:", "/repo/.git", { now: () => clock.now })
  const rt: Runtime = { ledger, profile: parseProfile({ ...defaultProfile(), ...profile }), now: () => clock.now, host, github: opts.github === false ? undefined : github }
  const fx: Fixture = {
    rt, clock, delivered, hostCalls, prs, recordsOnMain, sessions,
    register(session, agent, extra) {
      sessions.add(session)
      registerSession(rt, { sessionID: session, agent, directory: extra?.directory ?? "/repo" })
    },
    async call(session, tool, input) {
      const spec = toolByName(tool)
      if (!spec) throw new Error(`no tool ${tool}`)
      clock.advance(1000)
      return callTool(rt, spec, actorFor(rt, session), input)
    },
    async callFail(session, tool, input) {
      try {
        await fx.call(session, tool, input)
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      throw new Error(`${tool} was expected to fail but succeeded`)
    },
  }
  return fx
}

/** Registers the usual cast: a coordinator, a product manager and two engineers. */
export async function team(profile: Record<string, unknown> = {}, opts: { github?: boolean } = {}) {
  const fx = await fixture(profile, opts)
  fx.register("ses_co", "coordinator")
  fx.register("ses_pm", "product-manager")
  fx.register("ses_ana", "engineer")
  fx.register("ses_bru", "engineer")
  return fx
}

export function names(fx: Fixture) {
  const n = (s: string) => fx.rt.ledger.agent(s)?.name as string
  return { co: n("ses_co"), pm: n("ses_pm"), ana: n("ses_ana"), bru: n("ses_bru") }
}

export function itemIdFrom(text: string): string {
  const m = /\b(W[0-9a-z]+)\b/.exec(text)
  if (!m) throw new Error(`no item id in: ${text}`)
  return m[1] as string
}
