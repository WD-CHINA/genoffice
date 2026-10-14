#!/bin/sh
set -eu
cd "$(dirname "$0")"
npm ci --omit=dev
npx pm2 startOrReload ecosystem.config.cjs --update-env
npx pm2 save
npx pm2 status genoffice-viewer
port="${VIEWER_PORT:-11000}"
echo
echo "Viewer is supervised by PM2 (1 fork process)."
echo "Open http://127.0.0.1:${port}/api/health"
echo "Enable restart after reboot once: npx pm2 startup"
