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

function shape(id: string, b: RenderNode['box']): RenderNode {
  return {
    id,
    type: 'shape',
    sourceId: id,
    box: b,
    fill: { kind: 'solid', color: '#ff0000' },
    presetGeometry: 'rect',
  } as RenderNode
}

function render(
  node: RenderSlide,
  images: Map<string, HTMLImageElement>,
  width: number,
  states?: Parameters<typeof GifOverlay>[0]['states'],
): string {
  return renderToStaticMarkup(createElement(GifOverlay, { slide: node, images, width, states }))
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
    box: box(700, 20, 100, 100, { rotationDeg: 45 }),
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

test('keeps the overlay only while nothing later paints over the GIF', () => {
  const gif = picture('p1', box(100, 100, 200, 100), GIF)
  const behind = shape('s0', box(0, 0, 1000, 500))
  const images = new Map([[GIF, image(GIF)]])
  // Painted earlier → the GIF still owns the top layer
  assert.match(render(slide([behind, gif]), images, 500), /slides-gif-overlay/)
  // A later shape overlapping the frame → fall back to the canvas first frame
  assert.equal(render(slide([gif, shape('s1', box(250, 120, 50, 50))]), images, 500), '')
  // The group container alone doesn't paint; an overlapping child does
  const farGroup: RenderNode = {
    id: 'g1',
    type: 'group',
    sourceId: 'g1',
    box: box(0, 0, 500, 500),
    children: [shape('s2', box(400, 400, 10, 10))],
  } as RenderNode
  assert.match(render(slide([gif, farGroup]), images, 500), /slides-gif-overlay/)
  const nearGroup: RenderNode = {
    id: 'g2',
    type: 'group',
    sourceId: 'g2',
    box: box(0, 0, 500, 400),
    children: [shape('s3', box(260, 130, 10, 10))],
  } as RenderNode
  assert.equal(render(slide([gif, nearGroup]), images, 500), '')
  // A rotated group's child is tested in absolute slide coordinates: unrotated it sits
  // below the GIF, and the 90° group rotation carries it up over the frame
  const rotatedGroup: RenderNode = {
    id: 'g3',
    type: 'group',
    sourceId: 'g3',
    box: box(0, 200, 400, 200, { rotationDeg: 90 }),
    children: [shape('s4', box(40, 90, 20, 20))],
  } as RenderNode
  assert.equal(render(slide([gif, rotatedGroup]), images, 500), '')
})

test('applies show-mode animation state to the overlay', () => {
  const gif = picture('p1', box(100, 100, 200, 100), GIF)
  const images = new Map([[GIF, image(GIF)]])
  const states = new Map([
    [
      'p1',
      {
        hidden: false,
        opacity: 0.5,
        scale: 1.5,
        scaleX: 1,
        rotationDeg: 45,
        dx: 20,
        dy: -10,
        clip: { t: 0.5, mode: 'btm' as const },
      },
    ],
  ])
  const html = render(slide([gif]), images, 500, states)
  // Canvas-space offsets scale with the slide; animation transform wraps the node transform
  assert.match(
    html,
    /transform:translate\(10px, -5px\) rotate\(45deg\) scale\(1\.5, 1\.5\) rotate\(0deg\) scale\(1, 1\)/,
  )
  assert.match(html, /opacity:0\.5/)
  assert.match(html, /clip-path:inset\(50% 0 0 0\)/)
})

test('lifts a later overlapping picture above the GIF instead of freezing it', () => {
  const gif = picture('p1', box(100, 100, 200, 100), GIF)
  const sticker = picture('p2', box(250, 120, 100, 100), PNG)
  const images = new Map([
    [GIF, image(GIF)],
    [PNG, image(PNG)],
  ])
  // Both paint, the sticker after the GIF (above it)
  const html = render(slide([gif, sticker]), images, 500)
  assert.ok(html.indexOf(GIF) >= 0)
  assert.ok(html.indexOf(PNG) > html.indexOf(GIF))
  // A later shape over that sticker can't be lifted, so the GIF goes back to the canvas
  assert.equal(render(slide([gif, sticker, shape('s1', box(250, 120, 20, 20))]), images, 500), '')
  // A picture that doesn't overlap the GIF is not lifted
  const far = picture('p3', box(700, 400, 50, 50), PNG)
  const farHtml = render(slide([gif, far]), images, 500)
  assert.ok(farHtml.indexOf(GIF) >= 0)
  assert.equal(farHtml.includes(PNG), false)
})

test('a GIF hidden by an entrance animation renders no overlay', () => {
  const gif = picture('p1', box(100, 100, 200, 100), GIF)
  const states = new Map([
    [
      'p1',
      {
        hidden: true,
        opacity: 0,
        scale: 1,
        scaleX: 1,
        rotationDeg: 0,
        dx: 0,
        dy: 0,
        clip: null,
      },
    ],
  ])
  assert.equal(render(slide([gif]), new Map([[GIF, image(GIF)]]), 500, states), '')
})
