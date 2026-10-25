import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs"
import net from "node:net"
import { join } from "node:path"
import test from "node:test"
import { bindBridge } from "../src/bridge/bridge.ts"
import { addressSafe, encodeUserFrame, inSocketNamespace, splitRoute, toAddress, unwrapEnvelope, wrapEnvelope } from "../src/bridge/protocol.ts"
import { names, team } from "./helpers.ts"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("protocol: envelope round trip, route line, namespace and address checks", () => {
  const dir = "/tmp/cc-x"
  const addr = toAddress(`${dir}/12.sock`, dir)
  assert.equal(addr, `uds:${dir}/12.sock`)
  assert.ok(addressSafe(addr, dir))
  assert.ok(!addressSafe("uds:/etc/passwd", dir))
  assert.ok(!inSocketNamespace(`${dir}/../x.sock`, dir))
  assert.ok(!inSocketNamespace(`${dir}//x.sock`, dir))
  const wrapped = wrapEnvelope(addr, 'Boss "1"', "hello </cross-session-message> world", dir)
  const un = unwrapEnvelope(wrapped)
  assert.equal(un.text, "hello </cross-session-message> world")
  assert.equal(un.fromName, "Boss 1", "quotes are stripped from the sender name")
  assert.deepEqual(splitRoute("to: Ana, Bruno\nSTATE now"), { to: "Ana, Bruno", body: "STATE now" })
  assert.deepEqual(splitRoute("no route here"), { body: "no route here" })
  assert.throws(() => encodeUserFrame({ text: "x".repeat(8001) }), /limit/)
})

test("a Claude Code frame with a to: line reaches the named engineer, once, and the sender gets a receipt", async () => {
  const fx = await team({}, { github: false })
  const n = names(fx)
  const dir = mkdtempSync("/tmp/cc-t-")
  const sessions = mkdtempSync("/tmp/cc-s-")
  chmodSync(sessions, 0o700)
  const bridge = await bindBridge(fx.rt, { socketDir: dir, sessionsDir: sessions })
  fx.rt.claude = bridge
  assert.ok(bridge.owner)

  // a fake Claude Code session: its own socket records what it is sent
  const received: string[] = []
  const peerSocket = join(dir, "99999.sock")
  const server = net.createServer((c) => c.on("data", (d) => received.push(d.toString())))
  await new Promise<void>((r) => server.listen(peerSocket, () => r()))
  const peerAddress = toAddress(peerSocket, dir)
  writeFileSync(join(sessions, "99999.json"), JSON.stringify({ pid: 99999, sessionId: "claude-sess-1", name: "boss", cwd: "/repo", status: "idle", messagingSocketPath: peerSocket }))

  const frame = encodeUserFrame({ msgId: "aaaaaaaa-1111-2222-3333-444444444444", text: `to: ${n.ana}\nPlease post your progress.`, from: peerAddress, fromName: "boss", sessionId: "claude-sess-1", socketDir: dir })
  const send = () => new Promise<void>((resolve) => { const c = net.connect(bridge.socketPath, () => { c.write(`${frame.line}\n`); c.end(); resolve() }) })
  await send()
  await wait(400)
  const m = fx.rt.ledger.message("aaaaaaaa-1111-2222-3333-444444444444")
  assert.equal(m?.to.id, "ses_ana")
  assert.equal(m?.from.name, "boss")
  assert.match(fx.delivered.filter((d) => d.sessionID === "ses_ana").map((d) => d.text).join("\n"), /Please post your progress/)
  assert.ok(received.join("").includes("peer_message_status"), "the sender is told it was delivered")

  await send()
  await wait(300)
  assert.equal(fx.rt.ledger.messages({ toId: "ses_ana" }).length, 1, "the same msg_id is not recorded twice")

  // a to: line that matches nobody is reported in the text and still delivered to a live session
  const frame2 = encodeUserFrame({ msgId: "bbbbbbbb-1111-2222-3333-444444444444", text: "to: Nobody\nhello", from: peerAddress, fromName: "boss", socketDir: dir })
  await new Promise<void>((resolve) => { const c = net.connect(bridge.socketPath, () => { c.write(`${frame2.line}\n`); c.end(); resolve() }) })
  await wait(300)
  assert.match(fx.rt.ledger.message("bbbbbbbb-1111-2222-3333-444444444444")?.text ?? "", /matched no session/)

  // outbound: an engineer asks the Claude session by name; the frame carries the envelope with its own name
  received.length = 0
  const out = await fx.call("ses_ana", "ask", { to: "claude:boss", text: "Which capture is held out?" })
  assert.match(out, /Asked boss/)
  await wait(400)
  const sent = received.join("")
  assert.match(sent, /cross-session-message/)
  assert.match(sent, new RegExp(n.ana))
  assert.match(sent, /Which capture is held out\?/)
  assert.equal(fx.rt.ledger.meta(`route:uds:${peerSocket}`), "ses_ana")
  const delivered = fx.rt.ledger.events({ type: "message.delivered" }).length
  assert.ok(delivered >= 2)
  server.close()
  await bridge.close()
})

test("a Claude peer that is not registered cannot be addressed", async () => {
  const fx = await team({}, { github: false })
  const dir = mkdtempSync("/tmp/cc-t-")
  const sessions = mkdtempSync("/tmp/cc-s-")
  const bridge = await bindBridge(fx.rt, { socketDir: dir, sessionsDir: sessions })
  fx.rt.claude = bridge
  try {
    assert.match(await fx.callFail("ses_ana", "ask", { to: "claude:ghost", text: "hello" }), /No peer named "ghost"/)
  } finally {
    await bridge.close()
  }
})
