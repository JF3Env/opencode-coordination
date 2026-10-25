import net from "node:net"
import type { Ledger } from "../ledger/ledger.ts"
import { DEFAULT_SOCKET_DIR, inSocketNamespace } from "../bridge/protocol.ts"

/** Tells the process that owns the Claude Code socket to deliver pending messages to a session now. Best effort. */
export function wakeViaBridge(ledger: Ledger, sessionID: string, socketDir = process.env.COORDINATION_SOCKET_DIR ?? DEFAULT_SOCKET_DIR): void {
  const bound = ledger.events({ type: "bridge.bound", limit: 1, newestFirst: true })[0]
  const socketPath = typeof bound?.payload.socketPath === "string" ? bound.payload.socketPath : ""
  if (!socketPath || !inSocketNamespace(socketPath, socketDir)) return
  const socket = net.connect(socketPath)
  socket.setTimeout(500, () => socket.destroy())
  socket.once("connect", () => socket.end(`${JSON.stringify({ type: "control", action: "coordination_wake", session: sessionID })}\n`))
  socket.once("error", () => {})
}
