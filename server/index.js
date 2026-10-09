// Torii Call — single-process server:
//   * serves the static client from public/
//   * hosts the WebSocket signaling relay for WebRTC mesh calls
//
// No external signaling provider, no accounts, no media inspection. The server
// only relays SDP/ICE between peers that share a room id; media flows peer-to-peer.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const PORT = Number(process.env.PORT || process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_ROOM_SIZE = Number(process.env.MAX_ROOM_SIZE || 8);
// Optional URL prefix the reverse proxy mounts us under (e.g. "/call").
const BASE_PATH = (process.env.BASE_PATH || "").replace(/\/+$/, "");

function stripBase(p) {
  if (BASE_PATH && (p === BASE_PATH || p.startsWith(BASE_PATH + "/"))) {
    return p.slice(BASE_PATH.length) || "/";
  }
  return p;
}

// ---- ICE servers exposed to clients (STUN always; TURN when configured) ----
function iceServers() {
  const servers = [{ urls: ["stun:stun.l.google.com:19302"] }];
  if (process.env.TURN_URL) {
    servers.push({
      urls: [process.env.TURN_URL],
      username: process.env.TURN_USER || "",
      credential: process.env.TURN_PASS || "",
    });
  }
  return servers;
}

// ---- tiny static file server -------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let urlPath = stripBase(decodeURIComponent((req.url || "/").split("?")[0]));
  if (urlPath === "/" || urlPath === "") urlPath = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  });
}

// ---- room state --------------------------------------------------------------
// rooms: roomId -> { peers: Map<peerId, { id, name, ws }> }
const rooms = new Map();

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function leaveRoom(roomId, peerId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const peer = room.peers.get(peerId);
  if (!peer) return;
  room.peers.delete(peerId);
  for (const other of room.peers.values()) {
    send(other.ws, { type: "peer-left", peerId });
  }
  if (room.peers.size === 0) rooms.delete(roomId);
}

const httpServer = http.createServer((req, res) => {
  const p = stripBase(new URL(req.url, "http://localhost").pathname);
  if (p === "/ice-servers") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ iceServers: iceServers() }));
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const urlPath = stripBase(new URL(req.url, "http://localhost").pathname);
  if (urlPath === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  let peerId = randomId();
  let currentRoom = null;
  let currentName = "guest";

  ws.send(JSON.stringify({ type: "hello", peerId }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      send(ws, { type: "error", message: "invalid json" });
      return;
    }

    switch (msg.type) {
      case "join": {
        const roomId = String(msg.roomId || "").slice(0, 64);
        const name = String(msg.name || "guest").slice(0, 40);
        const pubkey = String(msg.pubkey || "").slice(0, 64);
        if (!roomId) return send(ws, { type: "error", message: "roomId required" });

        currentRoom = roomId;
        currentName = name;
        let room = rooms.get(roomId);
        if (!room) {
          room = { peers: new Map() };
          rooms.set(roomId, room);
        }
        if (room.peers.size >= MAX_ROOM_SIZE) {
          return send(ws, { type: "error", message: "room is full" });
        }

        const existing = [...room.peers.values()].map((p) => ({ id: p.id, name: p.name, pubkey: p.pubkey }));
        room.peers.set(peerId, { id: peerId, name, pubkey, ws });

        // Tell the joiner who is already here.
        send(ws, { type: "joined", roomId, selfId: peerId, peers: existing });
        // Tell everyone else a new peer arrived.
        for (const other of room.peers.values()) {
          if (other.id !== peerId) {
            send(other.ws, { type: "peer-joined", peer: { id: peerId, name, pubkey } });
          }
        }
        break;
      }

      case "signal": {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        const target = room.peers.get(msg.to);
        if (!target) return;
        send(target.ws, { type: "signal", from: peerId, data: msg.data });
        break;
      }

      case "rename": {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room || !room.peers.has(peerId)) return;
        currentName = String(msg.name || "guest").slice(0, 40);
        room.peers.get(peerId).name = currentName;
        break;
      }

      case "chat": {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        for (const other of room.peers.values()) {
          if (other.id !== peerId) {
            send(other.ws, { type: "chat", from: peerId, name: currentName, text: String(msg.text || "").slice(0, 1000) });
          }
        }
        break;
      }

      default:
        send(ws, { type: "error", message: "unknown message type" });
    }
  });

  ws.on("close", () => {
    if (currentRoom) leaveRoom(currentRoom, peerId);
  });
  ws.on("error", () => {
    if (currentRoom) leaveRoom(currentRoom, peerId);
  });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`Torii Call listening on http://${HOST}:${PORT}`);
  console.log(`ICE: ${iceServers().length} server(s) configured`);
});
