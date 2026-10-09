#!/usr/bin/env bash
# Torii Call — install onto the Torii host, mounted at /call/.
#
# Mirrors the Torii Base mount contract so a launcher tile appears:
#   1. Lay the app under /apps/torii-call/current
#   2. Start the Node signaling server as a reboot-safe systemd unit
#   3. Drop the nginx fragment at /opt/torii/nginx-fragments/call.conf
#   4. Register "call" via the torii CLI (fragment must already exist)
#
# Usage (from the repo root):
#   git clone https://github.com/ChiefmonkeyArt/torii-call.git && cd torii-call && sudo ./install.sh

set -euo pipefail

APP_NAME="call"
APP_DIR="/apps/torii-call"
RELEASE_DIR="${APP_DIR}/current"
PORT="${PORT:-3001}"
TORII_ROOT="${TORII_ROOT:-/opt/torii}"
VERSION="$(tr -d '[:space:]' < VERSION)"

echo "==> Torii Call installer (${VERSION})"

# 1. Node toolchain
if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# 2. Lay down the app source
mkdir -p "${APP_DIR}"
REPO_URL="https://github.com/ChiefmonkeyArt/torii-call.git"
if [ -n "${GH_TOKEN:-}" ]; then
  REPO_URL="https://${GH_TOKEN}@github.com/ChiefmonkeyArt/torii-call.git"
fi
if [ -d "${RELEASE_DIR}/.git" ]; then
  echo "==> Updating existing checkout"
  git -C "${RELEASE_DIR}" pull --ff-only origin main
else
  git clone --depth 1 "${REPO_URL}" "${RELEASE_DIR}"
fi
cd "${RELEASE_DIR}"
npm install --omit=dev

# 3. systemd service (reboot-safe)
install -o root -g root -m 0644 deploy/torii-call.service /etc/systemd/system/torii-call.service
systemctl daemon-reload
systemctl enable --now torii-call.service

# 4. nginx fragment — must exist BEFORE registering (Torii base enforces this)
install -o root -g root -m 0644 deploy/nginx-call.conf "${TORII_ROOT}/nginx-fragments/${APP_NAME}.conf"

# 5. Register the tile (fragment-first contract). Registering reloads nginx.
TORII=""
if command -v torii >/dev/null 2>&1; then
  TORII="torii"
elif [ -x "${TORII_ROOT}/bin/torii" ]; then
  TORII="${TORII_ROOT}/bin/torii"
fi
if [ -n "$TORII" ]; then
  "$TORII" register "$APP_NAME" --display "Torii Call" --desc "Private group video calls" --version "$VERSION"
else
  echo "==> (torii CLI not found — registering via sidecar directly)"
  curl -sS --fail-with-body -X POST "http://127.0.0.1:8780/torii/apps" \
    -H 'content-type: application/json' \
    -d "{\"name\":\"${APP_NAME}\",\"display_name\":\"Torii Call\",\"description\":\"Private group video calls\",\"version\":\"${VERSION}\"}"
fi

echo
echo "==> Torii Call live at https://chiefmonkey.art/call/"
echo "==> TURN relay (IP-hiding) is optional: set TURN_URL/User/Pass in /etc/systemd/system/torii-call.service"
echo "    after running coturn, then: systemctl daemon-reload && systemctl restart torii-call"
