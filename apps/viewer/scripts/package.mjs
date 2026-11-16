import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { app, root } from './paths.mjs'
import { bundledPackages } from './package-dependencies.mjs'

const GZIP_EXT = new Set([
  '.js',
  '.mjs',
  '.css',
  '.html',
  '.json',
  '.svg',
  '.wasm',
  '.ttf',
  '.otf',
  '.bcmap',
  '.pfb',
])

async function gzipTree(dir) {
  let saved = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      saved += await gzipTree(path)
      continue
    }
    if (!GZIP_EXT.has(extname(entry.name).toLowerCase())) continue
    const body = await readFile(path)
    if (body.length < 1024) continue
    const gz = gzipSync(body, { level: 6 })
    if (gz.length >= body.length) continue
    await writeFile(path + '.gz', gz)
    saved += body.length - gz.length
  }
  return saved
}
const output = resolve(app, 'releases/genoffice-viewer')
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
await cp(resolve(app, 'dist/web'), output, { recursive: true })
await cp(resolve(app, 'deploy/nginx.conf'), resolve(output, 'nginx.conf'))
await cp(resolve(root, 'LICENSE'), resolve(output, 'LICENSE'))
await cp(
  resolve(root, 'packages/viewer-renderers/src/docs/renderer/fonts/LICENSE-OFL.txt'),
  resolve(output, 'FONT-LICENSE-OFL.txt'),
)
await writeFile(
  resolve(output, 'README.md'),
  `# GenOffice Web Viewer

静态站点。用 nginx 或其他静态托管把网站根目录指到本目录即可。

\`/assets/\` 里的脚本、样式和字体文件名带内容 hash。在 nginx 中按同目录的 \`nginx.conf\` 开启 gzip，并为 \`/assets/\` 设置一年缓存；\`index.html\` 与 \`preview.html\` 不要长期缓存。woff2 已压缩，配置里不再对它 gzip。

本地预览不需要后端服务。服务端解析和历史资源功能需要独立 parse-server，请把 /v1/ 同源代理到后端；示例见 nginx.conf。站点本身仍是纯静态发布目录，不包含 Node 或 PM2 进程。本地文件可直接选择；URL 导入需要文件服务器允许跨域访问。

支持只读 PPTX、PDF、DOCX 预览和 PPT 放映。字体包中没有的字体会在界面标出回退。含 HTML/MHT 的 Word altChunk 会提示无法在纯前端转换。
`,
)
const front = JSON.parse(await readFile(resolve(app, 'dist/audit/frontend-modules.json'), 'utf8'))
const notices = []
const recorded = new Set()
for (const { name: importedName, directory: dir } of bundledPackages(front)) {
  const pkg = JSON.parse(await readFile(resolve(dir, 'package.json'), 'utf8'))
  const name = pkg.name || importedName
  const key = `${name}@${pkg.version}`
  if (recorded.has(key)) continue
  recorded.add(key)
  const licensesDirectory = `licenses/${key.replace(/[^a-zA-Z0-9@._-]/g, '_')}`
  notices.push({ name, version: pkg.version, license: pkg.license, licensesDirectory })
  await mkdir(resolve(output, licensesDirectory), { recursive: true })
  const licenses = (await readdir(dir)).filter((path) =>
    /^(?:licen[cs]e|copying|notice)/i.test(path),
  )
  for (const file of licenses)
    await cp(resolve(dir, file), resolve(output, licensesDirectory, file), { recursive: true })
}
await writeFile(resolve(output, 'THIRD_PARTY_NOTICES.json'), JSON.stringify(notices, null, 2))
const saved = await gzipTree(output)
console.log(`Precompressed gzip, saved ${Math.round(saved / 1024)} KiB`)
console.log(`Standalone release: ${output}`)
