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

The repo is private, so clone with a deploy key or a read token first:

```bash
git clone https://github.com/ChiefmonkeyArt/torii-call.git && cd torii-call && sudo ./install.sh
# or, on a host without an SSH key:  GH_TOKEN=ghp_xxx sudo -E ./install.sh
```

This installs the app to `/apps/torii-call/`, runs the signaling server as a
systemd service, and exposes it at `/call/` behind nginx. Add coturn for the
TURN relay (privacy hardening) by setting `TURN_URL`/`TURN_USER`/`TURN_PASS`
in `deploy/torii-call.service`, then restart the service.

### Launcher panel on chiefmonkey.art

To surface Torii Call as a tile next to Flock Map / Quest, register it in the
Torii launcher the same way as the other apps: drop `deploy/nginx-torii-call.conf`
into the host's nginx fragments, then add `{"id":"torii-call","title":"Torii Call","path":"/call/"}`
to the launcher registry and reload. (Same fragment-before-registration rule as the other tiles.)

## Layout

- `server/index.js` — HTTP static + WebSocket signaling (single process).
- `public/` — the client (`index.html`, `app.js`, `style.css`).
- `coturn/` — TURN relay config (IP-hiding privacy).
- `deploy/` — systemd unit + nginx fragment.
- `install.sh` — the one-line VPS installer.
- `tools/test.mjs` — signaling smoke test.
