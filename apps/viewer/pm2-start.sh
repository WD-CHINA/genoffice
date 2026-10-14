#!/bin/sh
set -eu
cd "$(dirname "$0")"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
export NVM_NODEJS_ORG_MIRROR="${NVM_NODEJS_ORG_MIRROR:-https://npmmirror.com/mirrors/node}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to install nvm" >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "git is required to install nvm" >&2
  exit 1
fi

if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "Installing nvm from the Gitee mirror..."
  export NVM_SOURCE="${NVM_SOURCE:-https://gitee.com/mirrors/nvm.git}"
  installer=$(mktemp)
  curl -fsSL -o "$installer" https://gitee.com/mirrors/nvm/raw/v0.40.8/install.sh
  bash "$installer"
  rm -f "$installer"
fi

rc="$HOME/.bashrc"
touch "$rc"
if ! grep -q 'NVM_NODEJS_ORG_MIRROR' "$rc"; then
  echo 'export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node' >> "$rc"
fi

set +u
. "$NVM_DIR/nvm.sh"

node_ok=0
if command -v node >/dev/null 2>&1; then
  ver=$(node -p "process.versions.node")
  major=${ver%%.*}
  rest=${ver#*.}
  minor=${rest%%.*}
  if [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 12 ]; }; then
    node_ok=1
  fi
fi
if [ "$node_ok" -ne 1 ]; then
  echo "Installing Node 22 from the npmmirror..."
  nvm install 22
  nvm alias default 22
  nvm use 22
fi
set -u

hash -r 2>/dev/null || true
echo "Using Node $(node -v)"

npm ci --omit=dev
rm -rf node_modules/pm2
if [ ! -d node_modules/playwright-core ]; then
  echo "npm ci failed: node_modules/playwright-core is missing" >&2
  exit 1
fi
if ! command -v pm2 >/dev/null 2>&1; then
  echo "Installing pm2 globally..."
  npm i -g pm2 --registry https://registry.npmmirror.com
  hash -r 2>/dev/null || true
fi
if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 is not on PATH. Install it with: npm i -g pm2" >&2
  exit 1
fi
echo "Using $(pm2 -v) ($(command -v pm2))"
# Wipe stale PM2 state that still points at a removed local
# node_modules/pm2/lib/ProcessContainerFork.js.
old_pid=$(pm2 pid genoffice-viewer 2>/dev/null || true)
pm2 delete genoffice-viewer >/dev/null 2>&1 || true
if [ -n "${old_pid:-}" ] && [ "$old_pid" != "0" ]; then
  kill -9 "$old_pid" 2>/dev/null || true
fi
pm2 kill >/dev/null 2>&1 || true
rm -f "${HOME}/.pm2/dump.pm2"
sleep 1
pm2 start ecosystem.config.cjs --update-env
pm2 save
pm2 status genoffice-viewer
port="${VIEWER_PORT:-11000}"
echo
echo "Viewer is supervised by PM2 (1 fork process)."
echo "Open http://127.0.0.1:${port}/api/health"
echo "Enable restart after reboot once: pm2 startup"
