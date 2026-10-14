import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { app, root } from './paths.mjs'
const output = resolve(app, 'releases/genoffice-viewer')
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
await cp(resolve(app, 'dist'), output, {
  recursive: true,
  filter: (source) => !['.viewer-data', 'audit', 'metafile.json'].includes(basename(source)),
})
await cp(resolve(root, 'LICENSE'), resolve(output, 'LICENSE'))
await cp(
  resolve(root, 'packages/viewer-renderers/src/docs/renderer/fonts/LICENSE-OFL.txt'),
  resolve(output, 'FONT-LICENSE-OFL.txt'),
)
await writeFile(
  resolve(output, 'README.md'),
  `# GenOffice Web Viewer\n\nRequires Node >=22.12.0.\n\nProcess supervision (one PM2 fork process):\n\n\`\`\`sh\nsh pm2-start.sh\n\`\`\`\n\nThis installs nvm and Node 22 when missing, then installs runtime dependencies, starts the viewer, and saves the PM2 process list. PM2 is taken from PATH, or installed with \`npm i -g pm2\` when missing. Enable reboot restart once with \`pm2 startup\`.\n\nForeground start without PM2: \`npm ci --omit=dev && npm start\`.\n\nThe server listens on 0.0.0.0:11000 by default. Open http://127.0.0.1:11000 locally, or http://SERVER_LAN_IP:11000 from your LAN. Development frontend is http://127.0.0.1:11001. Set VIEWER_HOST=127.0.0.1 before starting to listen on localhost only. Supports read-only PPTX, PDF, DOCX previews and PPTX slideshow.\n\nSet VIEWER_CHROME_PATH for an installed Chrome/Chromium (Word HTML/MHT altChunk).\nSet VIEWER_FONT_DIR to a deployment font directory. Match browser/system fonts for consistent layout.\nSet VIEWER_PORT, VIEWER_HOST, VIEWER_DATA_DIR, VIEWER_ALLOWED_ORIGINS as needed.\nDo not scale this app above one process. Sessions live in memory.\nNo other GenOffice application, Electron, or AI service is needed at runtime.\n\nVisual parity for complex documents is still undergoing acceptance.\n`,
)
const front = JSON.parse(await readFile(resolve(app, 'dist/audit/frontend-modules.json'), 'utf8'))
const server = Object.keys(
  JSON.parse(await readFile(resolve(app, 'dist/server/metafile.json'), 'utf8')).inputs,
)
const names = [
  ...new Set(
    [...front, ...server]
      .map((path) => /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path)?.[1])
      .filter(Boolean),
  ),
  'playwright-core',
].sort()
const notices = []
for (const name of new Set(names)) {
  const dir = resolve(root, 'node_modules', name)
  const pkg = JSON.parse(await readFile(resolve(dir, 'package.json'), 'utf8'))
  notices.push({ name, version: pkg.version, license: pkg.license })
  const licenses = (await readdir(dir)).filter((path) =>
    /^(?:licen[cs]e|copying|notice)/i.test(path),
  )
  for (const file of licenses)
    await cp(resolve(dir, file), resolve(output, 'licenses', name.replace('/', '__'), file), {
      recursive: true,
    })
}
await writeFile(resolve(output, 'THIRD_PARTY_NOTICES.json'), JSON.stringify(notices, null, 2))
console.log(`Standalone release: ${output}`)
