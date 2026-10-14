import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { app, root } from './paths.mjs'
const output = resolve(app, 'releases/genoffice-viewer')
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
await cp(resolve(app, 'dist/web'), output, { recursive: true })
await cp(resolve(root, 'LICENSE'), resolve(output, 'LICENSE'))
await cp(
  resolve(root, 'packages/viewer-renderers/src/docs/renderer/fonts/LICENSE-OFL.txt'),
  resolve(output, 'FONT-LICENSE-OFL.txt'),
)
await writeFile(
  resolve(output, 'README.md'),
  `# GenOffice Web Viewer

静态站点。用 nginx 或其他静态托管把网站根目录指到本目录即可。

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
console.log(`Standalone release: ${output}`)
