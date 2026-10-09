// Signaling smoke test: boot the server, join two clients to one room, and
// verify the relay (join roster, signal forwarding, chat, peer-left).
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = 3137;
let server = null;

// A client with a buffered message queue, so messages that arrive before we
// ask for them (e.g. "hello") are not lost.
function makeClient() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const queue = [];
  const waiters = [];
  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const i = waiters.findIndex((w) => w.type === m.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else queue.push(m);
  });
  const waitType = (type, timeout = 4000) => {
    const qi = queue.findIndex((m) => m.type === type);
    if (qi >= 0) return Promise.resolve(queue.splice(qi, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeout);
      waiters.push({ type, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  };
  return new Promise((resolve, reject) => {
    ws.on("error", reject);
    ws.on("open", () => resolve({ ws, waitType }));
  });
}

const assert = (cond, msg) => { if (!cond) throw new Error("ASSERT FAIL: " + msg); };

async function main() {
  server = spawn("node", ["server/index.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("server did not start")), 5000);
    server.stdout.on("data", (d) => { if (String(d).includes("listening")) { clearTimeout(t); res(); } });
    server.stderr.on("data", (d) => { if (String(d).includes("EADDRINUSE")) { clearTimeout(t); rej(new Error("port busy")); } });
  });

  const a = await makeClient();
  const b = await makeClient();

  await a.waitType("hello");
  await b.waitType("hello");

  a.ws.send(JSON.stringify({ type: "join", roomId: "room-test", name: "alice" }));
  const aJoined = await a.waitType("joined");
  assert(aJoined.roomId === "room-test", "a joined correct room");
  assert(aJoined.peers.length === 0, "a sees empty roster initially");

  b.ws.send(JSON.stringify({ type: "join", roomId: "room-test", name: "bob" }));
  const bJoined = await b.waitType("joined");
  assert(bJoined.peers.length === 1 && bJoined.peers[0].name === "alice", "b sees alice in roster");

  const aPeerJoined = await a.waitType("peer-joined");
  assert(aPeerJoined.peer.name === "bob", "a sees bob join");

  const bobId = bJoined.selfId;
  const aliceId = aJoined.selfId;
  b.ws.send(JSON.stringify({ type: "signal", to: aliceId, data: { kind: "offer", sdp: { type: "offer", sdp: "v=0" } } }));
  const aSignal = await a.waitType("signal");
  assert(aSignal.from === bobId && aSignal.data.kind === "offer", "offer relayed a<-b");

  b.ws.send(JSON.stringify({ type: "chat", text: "hi" }));
  const aChat = await a.waitType("chat");
  assert(aChat.text === "hi" && aChat.name === "bob", "chat relayed a<-b");

  b.ws.close();
  const aLeft = await a.waitType("peer-left");
  assert(aLeft.peerId === bobId, "peer-left relayed on disconnect");

  console.log("ALL SIGNALING TESTS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
}).finally(() => {
  if (server) server.kill();
});
