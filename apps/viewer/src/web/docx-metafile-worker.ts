import { metafileToDataUrl } from '@genoffice/docx-engine/metafile'
import type { MetricFont } from './metric-font-types'

// One conversion owns this worker. The host terminates it after the PNG is
// returned, freeing the original converter's large intermediate Canvas.
self.onmessage = async ({
  data,
}: MessageEvent<{ bytes: ArrayBuffer; mime: string; fonts: MetricFont[] }>) => {
  try {
    const fontSet = (self as unknown as { fonts: FontFaceSet }).fonts
    for (const font of data.fonts) {
      const face = new FontFace(font.family, `url(${font.url})`, {
        ...font.descriptors,
        weight: font.bold ? '700' : '400',
        style: font.italic ? 'italic' : 'normal',
      })
      await face.load()
      fontSet.add(face)
    }
    self.postMessage({ result: await metafileToDataUrl(data.bytes, data.mime) })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
