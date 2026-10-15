import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { app, root } from './paths.mjs'

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

打开、解析和绘制都在浏览器中完成，不需要 Node、PM2 或后端端口。本地文件直接选择；URL 导入由浏览器 fetch，文件服务器需要允许当前页面跨域访问。

支持只读 PPTX、PDF、DOCX 预览和 PPT 放映。字体包中没有的字体会在界面标出回退。含 HTML/MHT 的 Word altChunk 会提示无法在纯前端转换。
`,
)
const front = JSON.parse(await readFile(resolve(app, 'dist/audit/frontend-modules.json'), 'utf8'))
const names = [
  ...new Set(
    front.map((path) => /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path)?.[1]).filter(Boolean),
  ),
].sort()
const notices = []
for (const name of names) {
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
const saved = await gzipTree(output)
console.log(`Precompressed gzip, saved ${Math.round(saved / 1024)} KiB`)
console.log(`Standalone release: ${output}`)
