# Torii Call

Private, invite-link group video calls. Self-hosted, privacy-first.

Open a link, talk. No account, no third-party signaling, no media leaving your
infrastructure. Media is forced through your own TURN relay so peers never
learn each other's IP addresses, and participants are identified by Nostr
npubs (NIP-07) rather than accounts.

## Status: v0 (working demo)

- **Media** — WebRTC mesh, forced through your coturn relay (`iceTransportPolicy: relay`) so IPs stay hidden.
- **Identity** — Nostr npub via NIP-07 (`window.nostr`), with a guest fallback.
- **Signaling** — self-hosted Node WebSocket relay (no media inspection).
- **Rooms** — invite-link bound (`#r:<id>`); the link is the ticket.

### Roadmap (the documented sovereign architecture)

| Slice | What it adds | Status |
|---|---|---|
| MediaSoup SFU | Selective forwarding; scales past ~6; hides IPs (same privacy as TURN relay, far more efficient) | planned |
| Nostr relay signaling | Rooms/invites as signed NIP-59 events `(ownerNpub, dTag)`; no central signaling | planned |
| FIPS transport | Sovereign node-to-node reachability beneath signaling/media | planned |

The full design is in `video-chat-napplet-design.md` (Torii project). This repo
is the working front slice of that design — TURN-relay privacy + npub identity
now, SFU/Nostr/fIPS layered on next.

## Run locally

```bash
npm install
npm start            # http://localhost:3000
```

Open it twice (or in two browsers), share the invite link, and talk.

## Deploy to your VPS (one line)

```bash
git clone https://github.com/ChiefmonkeyArt/torii-call.git && cd torii-call && sudo ./install.sh
```

This installs the app to `/apps/torii-call/`, runs the signaling server as a
reboot-safe systemd service, and mounts it at **`/call/`** behind nginx. It also
drops the Torii-Base nginx fragment and registers the launcher tile
(`torii register call`), so a "Torii Call" panel appears next to Flock Map / Quest
automatically.

Add coturn for the TURN relay (IP-hiding privacy hardening) by uncommenting and
setting `TURN_URL`/`TURN_USER`/`TURN_PASS` in `deploy/torii-call.service`, then
`systemctl daemon-reload && systemctl restart torii-call`. Until then it runs
STUN-only (calls work on most networks, but peers on strict NAT may need TURN).

## Layout

- `server/index.js` — HTTP static + WebSocket signaling (single process).
- `public/` — the client (`index.html`, `app.js`, `style.css`).
- `coturn/` — TURN relay config (IP-hiding privacy).
- `deploy/` — systemd unit + nginx fragment (`call.conf` → `/call/`).
- `install.sh` — the one-line VPS installer.
- `tools/test.mjs` — signaling smoke test.
