import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import net from "node:net"
import path from "node:path"
import { createInterface } from "node:readline"
import { SYSTEM_ACTOR } from "../domain/system.ts"
import type { Actor, Party } from "../domain/types.ts"
import { dispatch } from "../deliver/deliver.ts"
import { partyOf, post, type ClaudeLink, type ClaudePeer, type Runtime } from "../runtime.ts"
import {
  BRIDGE_NAME, DEFAULT_SOCKET_DIR, MAX_FRAME_BYTES, addressSafe, encodeReceipt, encodeUserFrame, inSocketNamespace, keySuffix, newId,
  parseAddress, peerToken, processStartToken, socketPathForPid, splitRoute, toAddress, unwrapEnvelope,
} from "./protocol.ts"

export interface BridgeOptions {
  socketDir?: string
  sessionsDir?: string
  pid?: number
}

export interface Bridge extends ClaudeLink {
  pid: number
  socketPath: string
  owner: boolean
  close(): Promise<void>
}

async function privateDir(dir: string): Promise<void> {
  const info = await lstat(dir)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${dir} is not a private directory`)
  if ((info.mode & 0o077) !== 0) throw new Error(`${dir} is group or world accessible`)
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`${dir} is not owned by this user`)
}

async function probe(socketPath: string, socketDir: string, timeoutMs = 250): Promise<boolean> {
  if (!inSocketNamespace(socketPath, socketDir)) return false
  return new Promise((resolve) => {
    const socket = net.connect(socketPath)
    const timer = setTimeout(() => { socket.destroy(); resolve(false) }, timeoutMs)
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true) })
    socket.once("error", () => { clearTimeout(timer); resolve(false) })
  })
}

async function writePrivate(file: string, body: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  const handle = await open(tmp, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY, 0o600)
  try {
    await handle.writeFile(body)
  } finally {
    await handle.close()
  }
  await chmod(tmp, 0o600)
  await rename(tmp, file)
}

async function readNoFollow(file: string, max: number): Promise<string | undefined> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > max) return undefined
      return await handle.readFile({ encoding: "utf8" })
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

async function sendFrame(socketPath: string, lines: string[], socketDir: string): Promise<"accepted" | "uncertain"> {
  if (!inSocketNamespace(socketPath, socketDir)) throw new Error("refusing to connect outside the inbox namespace")
  const payload = Buffer.from(`${lines.join("\n")}\n`)
  if (payload.length >= MAX_FRAME_BYTES) throw new Error("frame exceeds the 1 MiB line cap")
  const socket = net.connect(socketPath)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out connecting to ${socketPath}`)), 5000)
    socket.once("connect", () => { clearTimeout(timer); resolve() })
    socket.once("error", (error) => { clearTimeout(timer); reject(error) })
  }).catch((error) => { socket.destroy(); throw error })
  socket.write(payload)
  await new Promise((resolve) => setTimeout(resolve, 150))
  socket.end()
  const closed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 2000)
    socket.once("close", () => { clearTimeout(timer); resolve(true) })
    socket.once("error", () => { clearTimeout(timer); resolve(false) })
  })
  return closed ? "accepted" : "uncertain"
}

async function lookupToken(socketPath: string, sessionsDir: string, socketDir: string): Promise<string> {
  const suffix = keySuffix(socketPath, socketDir)
  let names: string[] = []
  try {
    names = await readdir(sessionsDir)
  } catch {
    return ""
  }
  let best = ""
  let rank = -1
  for (const name of names) {
    if (!name.endsWith(suffix)) continue
    const match = /^(\d+)\.[0-9a-f]{64}\.key$/.exec(name)
    if (!match) continue
    const owner = Number(match[1])
    const raw = await readNoFollow(path.join(sessionsDir, name), 4096)
    if (!raw) continue
    let parsed: { peerToken?: string; procStart?: string }
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (!parsed.peerToken || !/^[0-9a-f]{32}$/.test(parsed.peerToken)) continue
    let score = 0
    try {
      process.kill(owner, 0)
      score = 1
      if (parsed.procStart && parsed.procStart === (await processStartToken(owner))) score = 2
    } catch {
      score = 0
    }
    if (score > rank) {
      best = parsed.peerToken
      rank = score
    }
  }
  return best
}

export async function listClaudePeers(sessionsDir: string, socketDir: string, selfPid: number): Promise<ClaudePeer[]> {
  let names: string[]
  try {
    names = await readdir(sessionsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const peers: ClaudePeer[] = []
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name)
    if (!match) continue
    const pid = Number(match[1])
    if (pid === selfPid) continue
    const raw = await readNoFollow(path.join(sessionsDir, name), 256 * 1024)
    if (!raw) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      continue
    }
    const socketPath = typeof parsed.messagingSocketPath === "string" ? parsed.messagingSocketPath : ""
    if (!socketPath || !inSocketNamespace(socketPath, socketDir)) continue
    peers.push({
      pid, sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : "", name: typeof parsed.name === "string" ? parsed.name : `pid-${pid}`,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "", status: typeof parsed.status === "string" ? parsed.status : "", socketPath,
      reachable: await probe(socketPath, socketDir),
    })
  }
  return peers.sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid)
}

/**
 * Binds the socket Claude Code addresses as the peer "opencode" and turns every inbound frame into a ledger message.
 * One process per machine owns the socket; the others still send. A message names its recipient with a first line
 * "to: <name>" (several names allowed); without one it follows the route of the last message sent to that sender.
 */
export async function bindBridge(rt: Runtime, options: BridgeOptions = {}): Promise<Bridge> {
  const socketDir = options.socketDir ?? process.env.COORDINATION_SOCKET_DIR ?? DEFAULT_SOCKET_DIR
  const sessionsDir = options.sessionsDir ?? path.join(homedir(), ".claude", "sessions")
  const pid = options.pid ?? process.pid
  const socketPath = socketPathForPid(pid, socketDir)
  const address = toAddress(socketPath, socketDir)
  const sessionId = rt.ledger.meta("bridge_session") ?? newId()
  rt.ledger.setMeta("bridge_session", sessionId)
  await mkdir(socketDir, { recursive: true, mode: 0o700 })
  await privateDir(socketDir)
  const link: ClaudeLink = {
    address,
    listPeers: () => listClaudePeers(sessionsDir, socketDir, pid),
    async send(peer, text, fromName, msgId) {
      if (!peer.reachable) throw new Error(`${peer.name} has no reachable inbox`)
      if (!peer.sessionId) throw new Error(`${peer.name} has no session id; refusing to send to a socket that might have been reused`)
      const token = await lookupToken(peer.socketPath, sessionsDir, socketDir)
      const frame = encodeUserFrame({ msgId, text, from: address, fromName, sessionId: peer.sessionId, socketDir })
      const lines = token ? [JSON.stringify({ type: "auth", token }), frame.line] : [frame.line]
      return sendFrame(peer.socketPath, lines, socketDir)
    },
  }
  if (await probe(socketPath, socketDir)) return { ...link, pid, socketPath, owner: false, close: async () => {} }
  await rm(socketPath, { force: true })
  const token = peerToken()
  const server = net.createServer((connection) => {
    connection.setTimeout(30_000)
    const lines = createInterface({ input: connection, crlfDelay: Infinity })
    lines.on("line", (line) => {
      if (Buffer.byteLength(line) >= MAX_FRAME_BYTES) return void connection.destroy()
      void handleLine(rt, line, address, socketDir).catch((error) => console.error("coordination: inbound frame failed", error instanceof Error ? error.message : "unknown"))
    })
    connection.on("timeout", () => connection.destroy())
    connection.on("error", () => {})
  })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => resolve()) })
  await chmod(socketPath, 0o600)
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 })
  await privateDir(sessionsDir)
  const procStart = await processStartToken(pid).catch(() => "")
  const now = Date.now()
  await writePrivate(path.join(sessionsDir, `${pid}.json`), `${JSON.stringify({
    pid, pidDomain: process.platform, sessionId, name: BRIDGE_NAME, nameSource: "explicit", cwd: process.cwd(), kind: "interactive", status: "idle",
    entrypoint: "cli", messagingSocketPath: socketPath, peerProtocol: 1, peerFeatures: ["reply_across_default_dirs"], procStart, startedAt: now, updatedAt: now,
    statusUpdatedAt: now, version: "opencode-coordination",
  }, null, 2)}\n`)
  await writePrivate(path.join(sessionsDir, `${pid}${keySuffix(socketPath, socketDir)}`), `${JSON.stringify({ peerToken: token, procStart })}\n`)
  rt.ledger.append({ type: "bridge.bound", actor: SYSTEM_ACTOR, payload: { pid, socketPath } })
  return {
    ...link, pid, socketPath, owner: true,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(socketPath, { force: true })
      await rm(path.join(sessionsDir, `${pid}.json`), { force: true })
      await rm(path.join(sessionsDir, `${pid}${keySuffix(socketPath, socketDir)}`), { force: true }).catch(() => {})
    },
  }
}

async function handleLine(rt: Runtime, line: string, selfAddress: string, socketDir: string): Promise<void> {
  if (!line.trim()) return
  let frame: Record<string, unknown>
  try {
    frame = JSON.parse(line) as Record<string, unknown>
  } catch {
    return
  }
  if (frame.type === "auth") return
  if (frame.type === "control" && frame.action === "peer_message_status") {
    const orig = typeof frame.orig_msg_id === "string" ? frame.orig_msg_id : ""
    if (orig && rt.ledger.message(orig) && frame.status === "delivered") rt.ledger.append({ type: "message.delivered", actor: SYSTEM_ACTOR, payload: { id: orig } })
    return
  }
  if (frame.type === "control" && frame.action === "coordination_wake") {
    const sessionID = typeof frame.session === "string" ? frame.session : ""
    if (sessionID) rt.wake?.(sessionID)
    return
  }
  if (frame.type !== "user") return
  const message = frame.message as { content?: unknown } | undefined
  if (!message || typeof message.content !== "string" || !message.content.trim()) return
  const fromAddress = typeof frame.from === "string" && addressSafe(frame.from, socketDir) ? frame.from : undefined
  if (fromAddress === selfAddress) return
  const unwrapped = unwrapEnvelope(message.content)
  const routed = splitRoute(unwrapped.text)
  const msgId = typeof frame.msg_id === "string" ? frame.msg_id : newId()
  if (rt.ledger.message(msgId)) return
  const delivered = await receive(rt, { msgId, text: routed.body, to: routed.to, fromName: unwrapped.fromName, fromAddress, sessionId: typeof frame.session_id === "string" ? frame.session_id : undefined })
  if (fromAddress && delivered) {
    const receipt = encodeReceipt({ msgId: newId(), origMsgId: msgId, status: "delivered", from: selfAddress, reason: "accepted by opencode-coordination" })
    await sendFrame(parseAddress(fromAddress), [receipt], socketDir).catch(() => {})
  }
}

export interface Inbound {
  msgId: string
  text: string
  to?: string
  fromName?: string
  fromAddress?: string
  sessionId?: string
}

/** Records an inbound Claude Code message once per target and delivers it. Returns whether anyone was addressed. */
export async function receive(rt: Runtime, m: Inbound): Promise<boolean> {
  const from: Party = { kind: "claude", id: m.sessionId || m.fromAddress || m.msgId, name: m.fromName || "claude", address: m.fromAddress }
  const actor: Actor = { session: from.id, name: from.name, role: "other" }
  const live = rt.ledger.agents((a) => a.status !== "gone" && a.kind === "opencode" && a.role !== "other")
  const wanted = m.to ? m.to.split(",").map((s) => s.trim()).filter(Boolean) : []
  const targets: string[] = []
  const unmatched: string[] = []
  for (const name of wanted) {
    // A sender may run the to: line into the text ("to: Bruno. From 1c: ..."): fall back to the first word.
    const head = name.match(/^[^\s.,:;]+/)?.[0] ?? ""
    const hit = rt.ledger.findAgents(name)[0] ?? (head && head !== name ? rt.ledger.findAgents(head)[0] : undefined)
    if (hit) {
      if (!targets.includes(hit.sessionID)) targets.push(hit.sessionID)
    } else unmatched.push(name)
  }
  if (!wanted.length) {
    const routed = m.fromAddress ? rt.ledger.meta(`route:${m.fromAddress}`) : undefined
    const fallback = routed && rt.ledger.agent(routed)?.status !== "gone" ? routed : live[0]?.sessionID
    if (fallback) targets.push(fallback)
  } else if (!targets.length && live[0]) targets.push(live[0].sessionID)
  const note = unmatched.length ? `[coordination: the to: line named ${unmatched.join(", ")}, which matched no session. Known names: ${live.map((a) => a.name).join(", ") || "none"}.]\n\n` : ""
  let index = 0
  for (const target of targets) {
    const agent = rt.ledger.agent(target)
    const to: Party = agent ? partyOf(agent) : { kind: "opencode", id: target, name: target }
    const id = index === 0 ? m.msgId : `${m.msgId}-${index}`
    index++
    rt.ledger.append({ type: "message.sent", actor, payload: { id, kind: "note", from, to, text: note + m.text, transport: "claude" }, refs: [id.slice(0, 8)] })
    await dispatch(rt, rt.ledger.message(id)!)
  }
  if (!targets.length) {
    const to: Party = { kind: "system", id: "unrouted", name: "unrouted" }
    post(rt, { from, to, kind: "note", text: note + m.text, actor, transport: "claude" })
  }
  return targets.length > 0
}
