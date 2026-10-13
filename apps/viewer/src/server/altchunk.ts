import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { convertHtmlToDocx } from '@genoffice/html2docx'
import { launchChrome, PlaywrightDriver } from '@genoffice/viewer-services/docs/driver'
let running = 0
export async function convertAltChunk(html: string, signal: AbortSignal) {
  if (running >= 2) throw new Error('Document conversion capacity reached')
  if (!html.trim() || html.length > 16 * 1024 * 1024) throw new Error('Invalid altChunk HTML')
  running++
  let dir: string | undefined, browser: Awaited<ReturnType<typeof launchChrome>> | undefined
  let driver: PlaywrightDriver | undefined, timer: NodeJS.Timeout | undefined
  const cancel = () => {
    void browser?.close()
  }
  try {
    dir = await mkdtemp(join(tmpdir(), 'genoffice-viewer-altchunk-'))
    await writeFile(join(dir, 'chunk.html'), '\ufeff' + html, 'utf8')
    browser = await launchChrome()
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) throw new Error('Conversion cancelled')
    driver = await PlaywrightDriver.create(browser, {
      width: 794,
      height: 1123,
      deviceScaleFactor: 2,
    })
    timer = setTimeout(cancel, 60_000)
    const { pathToFileURL } = await import('node:url')
    const result = await convertHtmlToDocx(
      { url: pathToFileURL(join(dir, 'chunk.html')).href },
      driver,
      { naturalTableWidth: true, signal },
    )
    return Buffer.from(result.docx)
  } finally {
    if (timer) clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
    await driver?.close().catch(() => {})
    await browser?.close().catch(() => {})
    if (dir) await rm(dir, { recursive: true, force: true })
    running--
  }
}
