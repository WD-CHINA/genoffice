import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imageDpiFromBytes, imageSizeFromBytes } from '@genoffice/pptx-render'
import type { OpenedPptx } from '@genoffice/pptx-engine'
import { createBrowserMedia, servedMedia, MEDIA_HEAD_BYTES } from '../src/web/browser-media.ts'
import { decodeTiffPixels } from '@genoffice/viewer-services/slides/shared/tiff-pixels'
import { tiffToPng as mainTiffToPng } from '@genoffice/viewer-services/slides/main/tiff-decode'
import { retintThemedSvg } from '@genoffice/viewer-services/slides/shared/themed-svg'
import { retintThemedSvg as serviceRetint } from '@genoffice/viewer-services/slides/main/media'
import UTIF from 'utif2'
import { PNG } from 'pngjs'

/** Decode the head of a data url the way pptx-render's readers do. */
function head(dataUrl: string) {
  const comma = dataUrl.indexOf(',')
  return new Uint8Array(Buffer.from(dataUrl.slice(comma + 1), 'base64'))
}

/** A real PNG (IHDR + pHYs + IDAT + IEND) so the dpi and size readers have something to parse. */
function png(width: number, height: number, pixelsPerMetre: number, padding = 0) {
  const u32 = (value: number) => [
    value >>> 24,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ]
  const chunk = (type: string, data: number[]) => {
    const body = [...type.split('').map((c) => c.charCodeAt(0)), ...data]
    return [...u32(data.length), ...body, 0, 0, 0, 0]
  }
  const parts = [
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    chunk('IHDR', [...u32(width), ...u32(height), 8, 6, 0, 0, 0]),
    chunk('pHYs', [...u32(pixelsPerMetre), ...u32(pixelsPerMetre), 1]),
    chunk('IDAT', [0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]),
    chunk('IEND', []),
  ].flat()
  return new Uint8Array([...parts, ...new Array(padding).fill(0)])
}

function archiveOf(parts: Record<string, Uint8Array>) {
  return { archive: { readBytes: (ref: string) => parts[ref] ?? null } } as unknown as OpenedPptx
}

test('small media parts stay inline data urls', () => {
  const opened = archiveOf({ 'ppt/media/small.png': png(64, 64, 3780) })
  const media = createBrowserMedia(opened)
  const url = media.resolve('ppt/media/small.png')!
  assert.ok(url.startsWith('data:image/png;base64,'))
  assert.equal(media.refs.size, 0, 'nothing is handed over as bytes')
  assert.deepEqual(imageDpiFromBytes(head(url)), { x: 96.012, y: 96.012 })
})

test('a big part becomes its head plus the part bytes, with the same header', () => {
  const bytes = png(1920, 1080, 3780, 80 * 1024)
  assert.ok(bytes.length > MEDIA_HEAD_BYTES)
  const opened = archiveOf({ 'ppt/media/big.png': bytes })
  const media = createBrowserMedia(opened)
  const key = media.resolve('ppt/media/big.png')!
  assert.equal(media.refs.get(key), 'ppt/media/big.png', 'the descriptor names its part')
  // the descriptor is the head the readers decode, so every number they report is the same
  assert.deepEqual(head(key), bytes.subarray(0, MEDIA_HEAD_BYTES))
  assert.ok(
    key.length < 128 * 1024,
    'the tree carries a head, not the payload (a 156 MB deck of these is the OOM)',
  )
  assert.deepEqual(imageDpiFromBytes(head(key)), imageDpiFromBytes(bytes))
  assert.deepEqual(imageSizeFromBytes(head(key)), { w: 1920, h: 1080 })
})

test('metafiles stay inline for the loader to rasterize', () => {
  // EMF/WMF carry device bounds the page needs whole; a head would be meaningless
  const emf = new Uint8Array([1, 0, 9, 0, ...new Array(MEDIA_HEAD_BYTES + 16).fill(7)])
  const media = createBrowserMedia(archiveOf({ 'ppt/media/pic.emf': emf }))
  const url = media.resolve('ppt/media/pic.emf')!
  assert.ok(url.startsWith('data:image/x-emf;base64,'), 'full payload, no descriptor')
  assert.equal(media.refs.size, 0)
})

test('browser TIFF matches main-package decoded pixels, including an offset input view', () => {
  const rgba = new Uint8Array(6 * 4 * 4)
  for (let i = 0; i < rgba.length; i += 4) rgba.set([200, 100, 50, 255], i)
  const tiff = new Uint8Array(UTIF.encodeImage(rgba, 6, 4))
  const padded = new Uint8Array(tiff.length + 8)
  padded.set(tiff, 4)
  const input = padded.subarray(4, 4 + tiff.length)
  const before = input.slice()
  const served = servedMedia(archiveOf({ 'pic.tif': input }), 'pic.tif')!
  assert.equal(served.mime, 'image/png')
  const actual = PNG.sync.read(Buffer.from(served.bytes))
  const expected = PNG.sync.read(Buffer.from(mainTiffToPng(input)!.png))
  assert.equal(actual.width, 6)
  assert.equal(actual.height, 4)
  assert.deepEqual(actual.data, expected.data)
  assert.deepEqual(input, before)
})

test('main TIFF guards reject invalid headers and decoded dimensions before RGBA allocation', () => {
  for (const dims of [
    [40000, 40000],
    [0, 10],
    [NaN, 3],
    [1.5, 4],
    [32767, 32767],
  ]) {
    let decoded = 0
    const result = decodeTiffPixels(new Uint8Array(), {
      decode: () => [{ t256: [dims[0]], t257: [dims[1]] }],
      decodeImage: () => {
        decoded++
        throw Error('must not decode')
      },
      toRGBA8: () => {
        throw Error('must not allocate')
      },
    } as unknown as Parameters<typeof decodeTiffPixels>[1])
    assert.equal(result, null)
    assert.equal(decoded, 0)
  }
  let allocated = 0
  assert.equal(
    decodeTiffPixels(new Uint8Array(), {
      decode: () => [{ t256: [6], t257: [4] }],
      decodeImage: (_bytes: unknown, ifd: any) => {
        ifd.width = 40000
        ifd.height = 40000
      },
      toRGBA8: () => {
        allocated++
        throw Error('post-decode guard must precede RGBA allocation')
      },
    } as unknown as Parameters<typeof decodeTiffPixels>[1]),
    null,
  )
  assert.equal(allocated, 0)
})

test('main TIFF page selection skips hostile IFDs and picks the largest valid page', () => {
  const ifds = [
    { t256: [100000], t257: [100000] },
    { t256: [6], t257: [4] },
    { t256: [3], t257: [2] },
  ]
  let selected: unknown
  const result = decodeTiffPixels(new Uint8Array(), {
    decode: () => ifds,
    decodeImage: (_bytes: unknown, ifd: any) => {
      selected = ifd
      ifd.width = 6
      ifd.height = 4
    },
    toRGBA8: () => new Uint8Array(96),
  } as unknown as Parameters<typeof decodeTiffPixels>[1])
  assert.equal(selected, ifds[1])
  assert.equal(result?.width, 6)
  assert.equal(result?.height, 4)
})

test('browser and service share SVG theme remapping, including master color maps and broken chains', () => {
  assert.equal(serviceRetint, retintThemedSvg)
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><style>.MsftOfcThm_Accent1_Fill_v2{fill:#000000;}.MsftOfcThm_Text1_Stroke_v2{stroke:#ffffff;}</style><rect width="20" height="20"/></svg>'
  const theme =
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="test"><a:dk1><a:srgbClr val="112233"/></a:dk1><a:lt1><a:srgbClr val="ffffff"/></a:lt1><a:accent1><a:srgbClr val="ff0000"/></a:accent1><a:accent2><a:srgbClr val="00ff00"/></a:accent2></a:clrScheme></a:themeElements></a:theme>'
  const opened = {
    deck: { slides: [{ path: 'slide.xml' }] },
    archive: {
      readBytes: () => new TextEncoder().encode(svg),
      resolveSlideChain: () => ({ themePath: 'theme.xml', masterPath: 'master.xml' }),
      readText: (name: string) =>
        name === 'theme.xml'
          ? theme
          : name === 'master.xml'
            ? '<p:sldMaster xmlns:p="p" xmlns:a="a"><p:clrMap accent1="accent2" tx1="dk1"/></p:sldMaster>'
            : '',
    },
  } as unknown as OpenedPptx
  const transformed = retintThemedSvg(svg, opened)
  assert.match(transformed, /fill:#00ff00/i)
  assert.match(transformed, /stroke:#112233/i)
  const url = createBrowserMedia(opened).resolve('pic.svg')!
  assert.equal(new TextDecoder().decode(head(url)), transformed)
  opened.archive.resolveSlideChain = () => {
    throw Error('broken relation')
  }
  assert.equal(retintThemedSvg(svg, opened), svg)
})
