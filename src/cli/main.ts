#!/usr/bin/env node
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { PROFILE_FILE, declaredRole, loadProfile } from "../config/profile.ts"
import { inboundText } from "../deliver/deliver.ts"
import { SYSTEM_ACTOR } from "../domain/system.ts"
import type { Actor, Role } from "../domain/types.ts"
import { importAgentMail } from "../ledger/import.ts"
import { Ledger } from "../ledger/ledger.ts"
import { renderPages, stalePages, writePages } from "../render/render.ts"
import { ToolFailure, mailboxes, type Runtime } from "../runtime.ts"
import { ledgerPathFor, scopeOf } from "../scope.ts"
import { ALL_TOOLS, callTool, toolByName } from "../tools/index.ts"
import { wakeViaBridge } from "./wake.ts"

const HELP = `coordination — roles, work items, messages and history on one ledger

Usage: coordination <command> [options]

Read:
  status                      scope, ledger path, event and agent counts
  board [front]               the work board
  item <id>                   one item with its timeline
  record <id>                 one message exactly as stored (8-character short id works)
  history [--item id] [--agent name] [--type prefix] [--since iso] [--limit n]
  tools                       every tool with the roles that may use it
Act as a Claude Code or script session (identity is declared, never an OpenCode session):
  call <tool> [json] --as <name> [--role coordinator|product-manager|engineer]
                              the role is the one the profile's cli block grants the name; --role only checks it
  inbox --as <name>           print and mark delivered the messages waiting for you
Project pages:
  render [--check]            write the generated pages; with --check, exit 1 if any is stale
Ledger:
  export [--since iso]        every event as JSON lines on stdout
  import-agent-mail [dir]     import the records of the earlier agent-mail plugin (default ~/.local/share/opencode/agent-mail)
  rebuild                     recompute every projection from the events

Options: --dir <path> (default: the current directory; its repository is the scope)
`

interface Args {
  command: string
  positional: string[]
  flags: Map<string, string>
}

function parse(argv: string[]): Args {
  const [command = "help", ...rest] = argv
  const positional: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string
    if (token.startsWith("--")) {
      const next = rest[i + 1]
      if (next === undefined || next.startsWith("--")) flags.set(token.slice(2), "true")
      else {
        flags.set(token.slice(2), next)
        i++
      }
    } else positional.push(token)
  }
  return { command, positional, flags }
}

async function open(args: Args): Promise<Runtime> {
  const dir = resolve(args.flags.get("dir") ?? process.cwd())
  const scope = await scopeOf(dir)
  const ledger = await Ledger.open(ledgerPathFor(scope), scope)
  const rt: Runtime = { ledger, profile: loadProfile(dir), now: () => ledger.now() }
  rt.wake = (sessionID) => wakeViaBridge(ledger, sessionID)
  return rt
}

/**
 * The CLI acts as a declared session of kind cli. It never acts as a session the host authenticates, and it holds only
 * the role the profile's cli block grants its name; a --role that disagrees is refused.
 */
function declaredActor(rt: Runtime, name: string, requested?: Role): Actor {
  const known = rt.ledger.findAgents(name)[0]
  if (known) {
    if (known.kind === "opencode") throw new ToolFailure(`${known.name} is an OpenCode session; the CLI cannot act as it. Use a name of your own.`)
    if (requested && requested !== known.role) throw new ToolFailure(`${known.name} is ${known.role} in this ledger; a declared role does not change.`)
    return { session: known.sessionID, name: known.name, role: known.role }
  }
  const role = declaredRole(rt.profile, name)
  if (requested && requested !== role) throw new ToolFailure(`${name} is not listed under cli.${requested} in ${PROFILE_FILE}, so it cannot act as ${requested}. It acts as ${role}.`)
  const session = `cli:${name}`
  const actor: Actor = { session, name, role }
  rt.ledger.appendMany([
    { type: "agent.seen", actor, payload: { sessionID: session, role, agent: role, directory: process.cwd(), status: "busy", kind: "cli" } },
    { type: "agent.named", actor, payload: { sessionID: session, name } },
  ])
  return actor
}

export async function run(argv: string[], out: (text: string) => void = (t) => process.stdout.write(`${t}\n`)): Promise<number> {
  const args = parse(argv)
  if (["help", "--help", "-h"].includes(args.command)) {
    out(HELP)
    return 0
  }
  const rt = await open(args)
  try {
    switch (args.command) {
      case "status": {
        out(`scope: ${rt.ledger.scope}\nevents: ${rt.ledger.eventCount()}\nagents: ${rt.ledger.agents().filter((a) => a.status !== "gone").length} live, ${rt.ledger.agents().length} known\nitems: ${rt.ledger.items().length}\nundelivered messages: ${rt.ledger.undeliveredCount()}`)
        return 0
      }
      case "tools": {
        for (const t of ALL_TOOLS) out(`${t.name.padEnd(18)} ${t.roles === "any" ? "any" : t.roles.join(", ")}`)
        return 0
      }
      case "board":
      case "item":
      case "record":
      case "history": {
        const reader: Actor = { session: "cli:reader", name: "reader", role: "other" }
        const input: Record<string, unknown> =
          args.command === "board" ? { front: args.positional[0] } :
          args.command === "item" ? { id: args.positional[0] } :
          args.command === "record" ? { id: args.positional[0] } :
          Object.fromEntries([...args.flags].filter(([k]) => ["item", "agent", "type", "since", "limit"].includes(k)).map(([k, v]) => [k, k === "limit" ? Number(v) : v]))
        const spec = toolByName(args.command)
        if (!spec) return 2
        out(await callTool(rt, spec, reader, input))
        return 0
      }
      case "call": {
        const [toolName, json] = args.positional
        const spec = toolName ? toolByName(toolName) : undefined
        if (!spec) throw new ToolFailure(`No tool ${toolName ?? ""}. coordination tools lists them.`)
        const as = args.flags.get("as")
        if (!as) throw new ToolFailure("call needs --as <name>: who is acting.")
        const actor = declaredActor(rt, as, args.flags.get("role") as Role | undefined)
        out(await callTool(rt, spec, actor, json ? JSON.parse(json) : {}))
        await new Promise((r) => setTimeout(r, 200))
        return 0
      }
      case "inbox": {
        const as = args.flags.get("as")
        if (!as) throw new ToolFailure("inbox needs --as <name>.")
        const actor = declaredActor(rt, as, args.flags.get("role") as Role | undefined)
        const pending = rt.ledger.claimPending(mailboxes(rt, actor.session), rt.now())
        if (!pending.length) out("No message is waiting.")
        for (const m of pending) {
          out(inboundText(m, m.item ? rt.ledger.item(m.item)?.title : undefined))
          out("")
          rt.ledger.append({ type: "message.delivered", actor: SYSTEM_ACTOR, subject: m.item, payload: { id: m.id, sessionID: actor.session } })
        }
        return 0
      }
      case "render": {
        const dir = resolve(args.flags.get("dir") ?? process.cwd())
        const pages = renderPages(rt.ledger, rt.profile)
        if (args.flags.has("check")) {
          const stale = stalePages(dir, pages)
          if (stale.length) {
            out(`stale or hand-edited: ${stale.join(", ")}. Run coordination render and commit the result.`)
            return 1
          }
          out("generated pages are current")
          return 0
        }
        const changed = writePages(dir, pages)
        rt.ledger.append({ type: "view.rendered", actor: SYSTEM_ACTOR, payload: { paths: pages.map((p) => p.path), changed } })
        out(changed.length ? `wrote ${changed.join(", ")}` : "nothing changed")
        return 0
      }
      case "export": {
        for (const e of rt.ledger.events({ since: args.flags.get("since") })) out(JSON.stringify(e))
        return 0
      }
      case "import-agent-mail": {
        const root = args.positional[0] ?? join(process.env.HOME ?? "", ".local", "share", "opencode", "agent-mail")
        const r = importAgentMail(rt.ledger, root)
        out(`read ${r.read}, imported ${r.imported}, skipped ${r.skipped}, invalid ${r.invalid}`)
        return r.invalid ? 1 : 0
      }
      case "rebuild": {
        out(`replayed ${rt.ledger.rebuild()} events`)
        return 0
      }
      default:
        out(`Unknown command ${args.command}.\n\n${HELP}`)
        return 2
    }
  } catch (error) {
    if (error instanceof ToolFailure) {
      out(error.message)
      return 1
    }
    throw error
  } finally {
    rt.ledger.close()
  }
}

if ((process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) || process.argv[1]?.endsWith("/coordination")) {
  run(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
