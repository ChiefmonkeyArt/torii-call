// Torii Call — mesh WebRTC client.
// Media flows peer-to-peer; this client only uses the /ws signaling server to
// exchange SDP/ICE inside a room. No account, no third-party signaling.

(() => {
  "use strict";

  // Derive the mount base from this script's own URL, so the app works at
  // root (/) or under a subpath (/call/).
  let BASE = "/";
  try {
    const cs = document.currentScript;
    if (cs && cs.src) BASE = new URL(".", cs.src).pathname;
  } catch {}

  const landing = document.getElementById("landing");
  const callView = document.getElementById("call");
  const grid = document.getElementById("grid");
  const countEl = document.getElementById("count");

  const nameInput = document.getElementById("name");
  const startBtn = document.getElementById("start");

  let ws = null;
  let selfId = null;
  let roomId = null;
  let myName = "guest";
  let pubkey = null;         // Nostr npub (NIP-07), or null for guests
  let localStream = null;
  let iceServers = [{ urls: ["stun:stun.l.google.com:19302"] }];
  let forceRelay = false;    // true when TURN present → media only via our relay (IPs hidden)

  // peerId -> { pc, tile, video, name }
  const peers = new Map();

  // ---- small helpers ---------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
  function setCount() {
    const remote = [...peers.keys()].filter((id) => id !== "me").length;
    countEl.textContent = `${1 + remote} in call`;
  }

  function makeId() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function shortNpub(pk) {
    if (!pk) return "guest";
    return pk.length > 16 ? pk.slice(0, 10) + "…" + pk.slice(-6) : pk;
  }

  async function resolvePubkey(timeoutMs = 2500) {
    try {
      if (window.nostr && typeof window.nostr.getPublicKey === "function") {
        pubkey = await Promise.race([
          window.nostr.getPublicKey(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("signer timeout")), timeoutMs)
          ),
        ]);
      }
    } catch {}
    return pubkey;
  }

  function roomFromHash() {
    const h = location.hash.replace(/^#?/, "");
    if (!h) return null;
    // Accept either a bare id or "r:<id>".
    return h.startsWith("r:") ? h.slice(2) : h;
  }

  function ensureRoom() {
    let id = roomFromHash();
    if (!id) {
      id = makeId();
      location.hash = "r:" + id;
    }
    return id;
  }

  // ---- peer tile management --------------------------------------------------
  function createTile(peerId, name, mirror) {
    const tile = document.createElement("div");
    tile.className = "tile" + (mirror ? " mirror" : "");
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = name;
    tile.append(video, label);
    grid.appendChild(tile);
    peers.set(peerId, { pc: null, tile, video, name });
    setCount();
    return tile;
  }

  function removePeer(peerId) {
    const p = peers.get(peerId);
    if (!p) return;
    if (p.pc) { try { p.pc.close(); } catch {} }
    p.tile.remove();
    peers.delete(peerId);
    setCount();
  }

  function getOrCreatePeer(peerId, name) {
    if (peers.has(peerId)) return peers.get(peerId);
    createTile(peerId, name || "peer", false);
    return peers.get(peerId);
  }

  function attachRemoteTrack(peerId, stream) {
    const p = peers.get(peerId);
    if (!p) return;
    p.video.srcObject = stream;
  }

  function newPeerConnection(peerId) {
    const p = peers.get(peerId);
    if (!p) return null;
    const pc = new RTCPeerConnection({
      iceServers,
      // Privacy-first: when our TURN relay is present, force all media through it
      // so peers never exchange IPs directly (same property a SFU provides).
      iceTransportPolicy: forceRelay ? "relay" : "all",
    });
    p.pc = pc;

    if (localStream) {
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        send({ type: "signal", to: peerId, data: { kind: "ice", candidate: e.candidate } });
      }
    };
    pc.ontrack = (e) => attachRemoteTrack(peerId, e.streams[0]);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        // mark tile with a subtle note (no teardown of others)
      }
    };
    return pc;
  }

  async function offerTo(peerId) {
    const pc = newPeerConnection(peerId);
    if (!pc) return;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ type: "signal", to: peerId, data: { kind: "offer", sdp: pc.localDescription } });
    } catch (e) { console.error("offer failed", e); }
  }

  async function handleSignal(from, data) {
    const p = getOrCreatePeer(from, "peer");
    if (data.kind === "offer") {
      let pc = p.pc || newPeerConnection(from);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: "signal", to: from, data: { kind: "answer", sdp: pc.localDescription } });
      } catch (e) { console.error("answer failed", e); }
    } else if (data.kind === "answer") {
      const pc = p.pc;
      if (pc) {
        try { await pc.setRemoteDescription(new RTCSessionDescription(data.sdp)); } catch (e) { console.error(e); }
      }
    } else if (data.kind === "ice") {
      const pc = p.pc;
      if (pc) {
        try { await pc.addIceCandidate(data.candidate); } catch (e) { console.error(e); }
      }
    }
  }

  // ---- media -----------------------------------------------------------------
  async function ensureMedia() {
    if (localStream) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    // Add local self-preview tile.
    createTile("me", `${myName} (you)`, true);
    peers.get("me").video.srcObject = localStream;
    setCount();
    return localStream;
  }

  // ---- signaling wire-up -----------------------------------------------------
  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}${BASE}ws`);

    ws.onopen = () => {
      send({ type: "join", roomId, name: myName, pubkey });
    };

    ws.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      switch (msg.type) {
        case "hello":
          selfId = msg.peerId;
          break;
        case "joined": {
          selfId = msg.selfId;
          const existing = msg.peers || [];
          try {
            await ensureMedia();
          } catch (e) {
            showError("Camera/microphone access is required: " + e.name);
            break;
          }
          // As the newcomer, offer to everyone already here.
          existing.forEach((p) => offerTo(p.id));
          break;
        }
        case "peer-joined": {
          // Wait for their offer (newcomer initiates in this design).
          getOrCreatePeer(msg.peer.id, msg.peer.name);
          break;
        }
        case "peer-left":
          if (msg.peerId !== "me") removePeer(msg.peerId);
          break;
        case "signal":
          handleSignal(msg.from, msg.data);
          break;
        case "chat":
          addMessage(msg.name, msg.text);
          break;
        case "error":
          showError(msg.message || "error");
          break;
      }
    };

    ws.onclose = () => {
      // If we didn't leave on purpose, rejoin silently is not attempted in MVP.
    };
    ws.onerror = () => {};
  }

  // ---- chat ------------------------------------------------------------------
  function addMessage(name, text) {
    const box = document.getElementById("messages");
    const div = document.createElement("div");
    div.className = "m";
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = name + ": ";
    div.append(n, document.createTextNode(text));
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  // ---- start / leave ---------------------------------------------------------
  async function start() {
    const typed = (nameInput.value || "").trim();
    roomId = ensureRoom();

    // Switch the view immediately — never let identity or media resolution
    // freeze the UI (a stuck NIP-07 signer used to hang the whole click here).
    landing.hidden = true;
    callView.hidden = false;
    setCount();

    // Resolve npub with a timeout so a broken/unlocked signer falls back to guest.
    await resolvePubkey(2500);
    myName = typed || (pubkey ? shortNpub(pubkey) : "guest");

    // Media is initialized (and the offer made) in the "joined" handler, so
    // there is exactly one media path and one error path.
    connect();
  }

  function showError(msg) {
    const hint = document.getElementById("device-hint");
    if (!callView.hidden) {
      const div = document.createElement("div");
      div.textContent = msg;
      div.style.cssText = "color:#e05252;font-size:13px;padding:8px 18px;";
      document.querySelector(".topbar").after(div);
      return;
    }
    hint.textContent = msg;
    hint.style.color = "#e05252";
  }

  function leave() {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    peers.forEach((p) => { if (p.pc) { try { p.pc.close(); } catch {} } });
    peers.clear();
    grid.innerHTML = "";
    if (ws) { try { ws.close(); } catch {} }
    location.hash = "";
    callView.hidden = true;
    landing.hidden = false;
    setCount();
  }

  function toggleTrack(kind) {
    if (!localStream) return;
    const t = localStream.getTracks().find((tr) => tr.kind === kind);
    if (!t) return;
    t.enabled = !t.enabled;
    const btn = kind === "audio" ? $("toggle-mic") : $("toggle-cam");
    btn.classList.toggle("active", t.enabled);
  }

  // ---- wiring ----------------------------------------------------------------
  startBtn.addEventListener("click", start);
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") start(); });
  $("leave").addEventListener("click", leave);
  $("toggle-mic").addEventListener("click", () => toggleTrack("audio"));
  $("toggle-cam").addEventListener("click", () => toggleTrack("video"));
  $("copy-link").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); } catch {
      window.prompt("Copy this link:", location.href);
    }
  });

  $("chat-toggle").addEventListener("click", () => {
    const c = $("chat");
    c.hidden = !c.hidden;
  });
  $("chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("chat-input");
    const text = input.value.trim();
    if (!text) return;
    send({ type: "chat", text });
    addMessage(myName + " (you)", text);
    input.value = "";
  });

  // fetch ICE servers from the same origin (TURN creds stay server-side)
  fetch(BASE + "ice-servers")
    .then((r) => r.json())
    .then((j) => {
      if (j.iceServers) iceServers = j.iceServers;
      // Any TURN server means we can keep media on our own relay.
      forceRelay = iceServers.some((s) =>
        (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => String(u).startsWith("turn:"))
      );
    })
    .catch(() => {});

  // Auto-join if a room id is already in the URL (invite link).
  if (roomFromHash()) {
    landing.hidden = false;
    // Show a joined state: prompt for name then join.
    startBtn.textContent = "Join call";
  }
})();
