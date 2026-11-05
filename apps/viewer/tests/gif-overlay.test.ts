import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RenderNode, RenderSlide } from '@genoffice/pptx-render'
import { GifOverlay } from '@genoffice/viewer-renderers/slides/renderer/components/GifOverlay'

function box(
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Record<string, unknown> = {},
): RenderNode['box'] {
  return {
    x,
    y,
    w,
    h,
    rotationDeg: 0,
    flipH: false,
    flipV: false,
    centerX: x + w / 2,
    centerY: y + h / 2,
    ...extra,
  } as RenderNode['box']
}

function picture(
  id: string,
  b: RenderNode['box'],
  dataUrl: string,
  extra: Record<string, unknown> = {},
): RenderNode {
  return { id, type: 'picture', sourceId: id, box: b, dataUrl, ...extra } as RenderNode
}

const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='
const PNG = 'data:image/png;base64,iVBORw0KGgo='

function image(src: string): HTMLImageElement {
  return {
    src,
    currentSrc: src,
    width: 100,
    height: 100,
    naturalWidth: 100,
    naturalHeight: 100,
  } as unknown as HTMLImageElement
}

function slide(nodes: RenderNode[]): RenderSlide {
  return { widthPx: 1000, heightPx: 500, scale: 1, background: { kind: 'none' }, nodes }
}

function render(node: RenderSlide, images: Map<string, HTMLImageElement>, width: number): string {
  return renderToStaticMarkup(createElement(GifOverlay, { slide: node, images, width }))
}

test('renders animated GIF pictures recursively through groups with their transforms', () => {
  const group: RenderNode = {
    id: 'g1',
    type: 'group',
    sourceId: 'g1',
    box: box(100, 50, 400, 200, { rotationDeg: 30, flipH: true }),
    children: [
      picture('p1', box(10, 20, 100, 50), GIF, {
        srcRect: { l: 0.25, t: 0.5, r: 0, b: 0 },
        clip: { cornerRadiusPx: 6 },
      }),
    ],
  } as RenderNode
  const topLevel = picture('p2', box(600, 300, 200, 100), GIF)
  const staticPng = picture('p3', box(0, 0, 10, 10), PNG)
  const emptyGroup: RenderNode = {
    id: 'g2',
    type: 'group',
    sourceId: 'g2',
    box: box(700, 400, 100, 100, { rotationDeg: 45 }),
    children: [picture('p4', box(0, 0, 10, 10), PNG)],
  } as RenderNode
  const html = render(
    slide([group, topLevel, staticPng, emptyGroup]),
    new Map([
      [GIF, image(GIF)],
      [PNG, image(PNG)],
    ]),
    500,
  )

  // Group wrapper: scaled box, rotation + horizontal flip around the box center
  assert.match(html, /style="position:absolute;left:50px;top:25px;width:200px;height:100px;/)
  assert.match(html, /rotate\(30deg\) scale\(-1, 1\)/)
  // Group child in group-local coordinates, still scaled by the slide scale
  assert.match(html, /left:5px;top:10px;width:50px;height:25px/)
  // Local-px clip layer, unscaled, then scaled to slide coordinates
  assert.match(html, /width:100px;height:50px;transform:scale\(0.5\)/)
  assert.match(html, /border-radius:6px/)
  // srcRect crop: span 0.75 × 0.5 → image is enlarged and shifted by the crop
  assert.match(html, /left:-33\.33[0-9]*%;top:-100%;width:133\.33[0-9]*%;height:200%/)
  // Top-level picture
  assert.match(html, /left:300px;top:150px;width:100px;height:50px/)
  // Static pictures are not overlaid, and GIF-free groups are pruned
  assert.equal(html.includes(PNG), false)
  assert.equal(html.includes('rotate(45deg)'), false)
})

test('renders nothing when the slide holds no animated GIF', () => {
  const html = render(
    slide([picture('p1', box(0, 0, 10, 10), PNG)]),
    new Map([[PNG, image(PNG)]]),
    500,
  )
  assert.equal(html, '')
})
