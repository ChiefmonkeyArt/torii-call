#!/usr/bin/env bash
# Torii Call — single-command install onto a Debian/Ubuntu host (the user's VPS).
#
# Installs the app to /apps/torii-call/current, runs the Node signaling server as
# a systemd service, and exposes it at /call/ behind nginx. Optional TURN (coturn)
# is installed but disabled unless you set TURN_URL/TURN_USER/TURN_PASS.
#
# Usage (single line, from the repo root):
#   git clone https://github.com/ChiefmonkeyArt/torii-call.git && cd torii-call && sudo ./install.sh
#
# The repo is PRIVATE. To clone it on the VPS, either use an SSH deploy key
# (git remote) or pass a read token:  GH_TOKEN=ghp_xxx sudo -E ./install.sh
#
# This mirrors the restricted, owner-operated deploy pattern used by the Torii
# apps: nothing is pushed here except what you invoke yourself.

set -euo pipefail

APP_DIR="/apps/torii-call"
RELEASE_DIR="${APP_DIR}/current"
PORT="${PORT:-3001}"

echo "==> Torii Call installer"

# 1. Node toolchain
if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# 2. Lay down the app
mkdir -p "${APP_DIR}"
REPO_URL="https://github.com/ChiefmonkeyArt/torii-call.git"
if [ -n "${GH_TOKEN:-}" ]; then
  REPO_URL="https://${GH_TOKEN}@github.com/ChiefmonkeyArt/torii-call.git"
fi
if [ -d "${RELEASE_DIR}/.git" ]; then
  git -C "${RELEASE_DIR}" pull --ff-only origin main
else
  git clone --depth 1 "${REPO_URL}" "${RELEASE_DIR}"
fi
cd "${RELEASE_DIR}"
npm install --omit=dev

# 3. systemd service + nginx fragment
install -o root -g root -m 0644 deploy/torii-call.service /etc/systemd/system/torii-call.service
systemctl daemon-reload

if command -v nginx >/dev/null 2>&1; then
  install -o root -g root -m 0644 deploy/nginx-torii-call.conf /etc/nginx/snippets/torii-call.conf 2>/dev/null \
    || install -o root -g root -m 0644 deploy/nginx-torii-call.conf /etc/nginx/conf.d/torii-call.conf
  echo "==> nginx fragment written. Include it in a server{} block, or symlink into conf.d."
  nginx -t && systemctl reload nginx || echo "==> (nginx not reloaded — check your server{} block)"
fi

systemctl enable --now torii-call.service

echo
echo "==> Torii Call is running at http://<your-host>${BASE_PATH:-/call}/"
echo "==> TIP: to enable TURN, set TURN_URL/TURN_USER/TURN_PASS in /etc/systemd/system/torii-call.service, then: systemctl daemon-reload && systemctl restart torii-call"
echo "==> Add a launcher panel on chiefmonkey.art by registering 'torii-call' + '/call/' in the Torii launcher registry."
