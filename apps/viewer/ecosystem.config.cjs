function pick(name, fallback) {
  const value = process.env[name]
  return value == null || value === '' ? fallback : value
}

const optional = [
  'VIEWER_DATA_DIR',
  'VIEWER_ALLOWED_ORIGINS',
  'VIEWER_CHROME_PATH',
  'VIEWER_FONT_DIR',
  'VIEWER_URL_ALLOW_PRIVATE_NETWORK',
  'VIEWER_MAX_UPLOAD_BYTES',
  'VIEWER_SESSION_TTL_MS',
  'VIEWER_URL_TIMEOUT_MS',
]

const env = {
  VIEWER_HOST: pick('VIEWER_HOST', '0.0.0.0'),
  VIEWER_PORT: pick('VIEWER_PORT', '11000'),
  // Cap V8 heap so a huge PPTX fails with a JS OOM instead of taking down the host.
  NODE_OPTIONS: pick('NODE_OPTIONS', '--max-old-space-size=768'),
}
for (const name of optional) if (process.env[name]) env[name] = process.env[name]

module.exports = {
  apps: [
    {
      name: 'genoffice-viewer',
      cwd: __dirname,
      script: 'server/index.mjs',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      min_uptime: '5s',
      restart_delay: 3000,
      kill_timeout: 10000,
      // Restart before the Linux OOM killer takes the whole machine.
      max_memory_restart: pick('VIEWER_MAX_MEMORY', '800M'),
      env,
    },
  ],
}
