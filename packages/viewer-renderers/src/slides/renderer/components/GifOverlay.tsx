import React, { useMemo } from 'react'
import type {
  GroupRenderNode,
  PictureRenderNode,
  RenderNode,
  RenderSlide,
} from '@genoffice/pptx-render'
import type { NodeAnimState } from '../animation-play'
import { isAnimatedGif } from '../gif-animation'

/**
 * Native <img> overlay for animated GIF pictures. Canvas drawImage only paints the
 * first GIF frame reliably, so the animated picture is composited above the Konva
 * canvas at the same slide coordinates. Mirrors the canvas node tree: group wrappers
 * nest (children are in group-local coordinates and inherit the group transform), and
 * each frame carries the node's own rotation/flip/crop/picture-style clip.
 *
 * The overlay paints above the whole canvas, so paint order is reconstructed here:
 * a picture painted later than a GIF and overlapping it (a sticker/logo in front) is
 * lifted into the overlay above that GIF, which keeps both the animation and the
 * picture's front position. Anything else painted later over a GIF (shape, text,
 * table, chart) can't be lifted, so that GIF falls back to the canvas first frame.
 *
 * During a show `states` carries the animation player's per-node state; entrance/exit
 * effects on a GIF's node (or its group) map to CSS opacity/translate/scale/rotation and
 * a wipe clip. Paragraph animation states don't apply to pictures.
 *
 * Known limits: blip color effects (duotone/clrChange/biLevel/lum) and canvas-only
 * effects (soft edge, reflection, shadow) render unprocessed here.
 */
export function GifOverlay({
  slide,
  images,
  width,
  states,
}: {
  slide: RenderSlide
  images: Map<string, HTMLImageElement>
  width: number
  /** Show-mode animation state, keyed by sourceId (see useAnimPlayer) */
  states?: Map<string, NodeAnimState>
}) {
  const scale = width / slide.widthPx
  const plan = useMemo(() => planOverlay(slide.nodes, images), [slide.nodes, images])
  if (!plan) return null
  const children = renderBranches(slide.nodes, plan, scale, states)
  // Every overlaid picture can still be hidden by an entrance animation
  if (!children.some(Boolean)) return null
  return (
    <div
      className="slides-gif-overlay"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}
    >
      {children}
    </div>
  )
}

/** A picture drawn in the overlay (animated GIF, or a later picture lifted above one). */
export interface PictureLayer {
  node: PictureRenderNode
  img: HTMLImageElement
}

export interface OverlayPlan {
  /** Animated GIFs that keep their overlay, by node id */
  gifs: Map<string, PictureLayer>
  /** Later pictures lifted above a GIF, by node id */
  raised: Map<string, PictureLayer>
  /** Nodes whose subtree holds an overlaid picture (kept branches) */
  keep: Set<string>
}

function pictureLayer(
  node: RenderNode,
  images: Map<string, HTMLImageElement>,
): PictureLayer | null {
  if (node.type !== 'picture') return null
  const pic = node as PictureRenderNode
  // Video/audio poster frames have their own player layers
  if (pic.media) return null
  const img = pic.dataUrl ? images.get(pic.dataUrl) : undefined
  if (!img) return null
  return { node: pic, img }
}

function isOverlayGif(layer: PictureLayer): boolean {
  if (!isAnimatedGif(layer.img)) return false
  // ≤2×2 pictures stretch to one flat color on the canvas; an overlay would blow it up
  const w = layer.img.naturalWidth || layer.img.width
  const h = layer.img.naturalHeight || layer.img.height
  return !(w > 0 && h > 0 && w <= 2 && h <= 2)
}

// ── Paint-order analysis ────────────────────────────────────────────────────────────

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** 2D affine [a b c d e f]: x' = a·x + c·y + e, y' = b·x + d·y + f */
type Mat = readonly [number, number, number, number, number, number]
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0]

function multiply(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

/** Node content ([0,w]×[0,h]) → parent space, matching boxPivotProps (rotate/flip about the box center). */
function nodeMatrix(box: RenderNode['box']): Mat {
  const rad = (box.rotationDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const sx = box.flipH ? -1 : 1
  const sy = box.flipV ? -1 : 1
  const a = cos * sx
  const b = sin * sx
  const c = -sin * sy
  const d = cos * sy
  return [
    a,
    b,
    c,
    d,
    box.x + box.w / 2 - a * (box.w / 2) - c * (box.h / 2),
    box.y + box.h / 2 - b * (box.w / 2) - d * (box.h / 2),
  ]
}

function bounds(m: Mat, w: number, h: number): Rect {
  const xs: number[] = []
  const ys: number[] = []
  for (const [x, y] of [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ]) {
    xs.push(m[0] * x + m[2] * y + m[4])
    ys.push(m[1] * x + m[3] * y + m[5])
  }
  const x0 = Math.min(...xs)
  const y0 = Math.min(...ys)
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 }
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

interface FlatNode {
  node: RenderNode
  /** Absolute (slide-space) bounding box */
  rect: Rect
}

/** Depth-first in paint order; a group's children paint at the group's z position. */
function flattenPaintOrder(nodes: RenderNode[], parent: Mat, out: FlatNode[]): void {
  for (const node of nodes) {
    const m = multiply(parent, nodeMatrix(node.box))
    out.push({ node, rect: bounds(m, node.box.w, node.box.h) })
    if (node.type === 'group') flattenPaintOrder((node as GroupRenderNode).children, m, out)
  }
}

/** Exposed for tests: which pictures the overlay shows, and which later pictures ride above them. */
export function planOverlay(
  nodes: RenderNode[],
  images: Map<string, HTMLImageElement>,
): OverlayPlan | null {
  const flat: FlatNode[] = []
  flattenPaintOrder(nodes, IDENTITY, flat)
  const at = new Map<string, number>()
  const layers = new Map<string, PictureLayer>()
  flat.forEach((entry, i) => {
    at.set(entry.node.id, i)
    const layer = pictureLayer(entry.node, images)
    if (layer) layers.set(entry.node.id, layer)
  })
  const gifIds = new Set<string>()
  for (const [id, layer] of layers) if (isOverlayGif(layer)) gifIds.add(id)
  if (!gifIds.size) return null

  // Later pictures overlapping a GIF can ride in the overlay above it; media and
  // undecoded pictures can't, so they force the GIF back to the canvas.
  const candidates = new Set<string>(gifIds)
  for (const gifId of gifIds) {
    const i = at.get(gifId)!
    const gifRect = flat[i]!.rect
    for (let j = i + 1; j < flat.length; j++) {
      const later = flat[j]!
      if (later.node.type !== 'picture') continue
      if (!layers.has(later.node.id)) continue
      if (overlaps(gifRect, later.rect)) candidates.add(later.node.id)
    }
  }

  // A lifted picture must itself stay above everything painted after it that it
  // overlaps: any later node we cannot lift (shape/text/table/chart) takes the picture
  // (and through it the GIF) back to the canvas. Iterate until the set is stable.
  for (let changed = true; changed;) {
    changed = false
    for (const id of [...candidates]) {
      const i = at.get(id)!
      for (let j = i + 1; j < flat.length; j++) {
        const later = flat[j]!
        // A group paints only through its children (already in the list)
        if (later.node.type === 'group') continue
        if (!overlaps(flat[i]!.rect, later.rect)) continue
        if (!candidates.has(later.node.id)) {
          candidates.delete(id)
          changed = true
          break
        }
      }
    }
  }

  const gifs = new Map<string, PictureLayer>()
  for (const id of gifIds) if (candidates.has(id)) gifs.set(id, layers.get(id)!)
  if (!gifs.size) return null

  // Lift only pictures that still sit above a surviving GIF
  const raised = new Map<string, PictureLayer>()
  for (const id of candidates) {
    if (gifIds.has(id)) continue
    const entry = flat[at.get(id)!]!
    for (const gifId of gifs.keys()) {
      const gif = flat[at.get(gifId)!]!
      if (at.get(gifId)! < at.get(id)! && overlaps(gif.rect, entry.rect)) {
        raised.set(id, layers.get(id)!)
        break
      }
    }
  }

  const keep = new Set<string>()
  markKeep(nodes, gifs, raised, keep)
  return { gifs, raised, keep }
}

/** Keep every node whose subtree holds an overlaid picture, so groups can be pruned. */
function markKeep(
  nodes: RenderNode[],
  gifs: Map<string, PictureLayer>,
  raised: Map<string, PictureLayer>,
  keep: Set<string>,
): boolean {
  let any = false
  for (const node of nodes) {
    const child =
      node.type === 'group'
        ? markKeep((node as GroupRenderNode).children, gifs, raised, keep)
        : false
    if (child || gifs.has(node.id) || raised.has(node.id)) {
      keep.add(node.id)
      any = true
    }
  }
  return any
}

// ── Rendering ───────────────────────────────────────────────────────────────────────

function renderBranches(
  nodes: RenderNode[],
  plan: OverlayPlan,
  scale: number,
  states: Map<string, NodeAnimState> | undefined,
): React.ReactNode[] {
  return nodes
    .filter((node) => plan.keep.has(node.id))
    .map((node) => {
      const st = states?.get(node.sourceId)
      if (st?.hidden) return null
      const frame = frameStyle(node.box, scale, st)
      if (node.type === 'group') {
        return (
          <div key={node.id} style={{ ...frame, ...(st ? { opacity: st.opacity } : {}) }}>
            {renderBranches((node as GroupRenderNode).children, plan, scale, states)}
          </div>
        )
      }
      const layer = plan.gifs.get(node.id) ?? plan.raised.get(node.id)
      if (!layer) return null
      return (
        <PictureFrame
          key={node.id}
          frame={frame}
          opacity={(st?.opacity ?? 1) * (layer.node.opacity ?? 1)}
          pic={layer.node}
          img={layer.img}
          scale={scale}
        />
      )
    })
}

function frameStyle(
  box: RenderNode['box'],
  scale: number,
  st: NodeAnimState | undefined,
): React.CSSProperties {
  // Same pivot and transform order as the canvas: the animation group wraps the node's
  // own transform, and both rotate/flip about the box center (the CSS matrix is R·S).
  const transforms: string[] = []
  if (st) {
    transforms.push(
      `translate(${st.dx * scale}px, ${st.dy * scale}px)`,
      `rotate(${st.rotationDeg}deg)`,
      `scale(${st.scale * st.scaleX}, ${st.scale})`,
    )
  }
  transforms.push(`rotate(${box.rotationDeg}deg) ${flipScale(box.flipH, box.flipV)}`)
  return {
    position: 'absolute',
    left: box.x * scale,
    top: box.y * scale,
    width: box.w * scale,
    height: box.h * scale,
    transform: transforms.join(' '),
    transformOrigin: '50% 50%',
    ...(st?.clip ? { clipPath: wipeClip(st.clip) } : {}),
  }
}

function flipScale(flipH: boolean, flipV: boolean): string {
  return `scale(${flipH ? -1 : 1}, ${flipV ? -1 : 1})`
}

/** Konva wipe clip → CSS inset: the visible band is anchored per mode, sized by t. */
function wipeClip(clip: NonNullable<NodeAnimState['clip']>): string {
  const hiddenPct = (1 - clip.t) * 100
  if (clip.mode === 'top') return `inset(0 0 ${hiddenPct}% 0)`
  if (clip.mode === 'mid') return `inset(${hiddenPct / 2}% 0 ${hiddenPct / 2}% 0)`
  return `inset(${hiddenPct}% 0 0 0)`
}

function PictureFrame({
  frame,
  opacity,
  pic,
  img,
  scale,
}: {
  frame: React.CSSProperties
  opacity: number
  pic: PictureRenderNode
  img: HTMLImageElement
  scale: number
}) {
  const { box } = pic
  // srcRect: the frame maps the source span [l, 1-r]×[t, 1-b] onto the whole box, so
  // the full image is scaled up by the inverse span and shifted by the crop.
  let imageStyle: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    width: '100%',
    height: '100%',
  }
  const sr = pic.srcRect
  if (sr) {
    const spanX = 1 - sr.l - sr.r
    const spanY = 1 - sr.t - sr.b
    if (spanX > 0 && spanY > 0) {
      imageStyle = {
        position: 'absolute',
        left: `${(-sr.l / spanX) * 100}%`,
        top: `${(-sr.t / spanY) * 100}%`,
        width: `${100 / spanX}%`,
        height: `${100 / spanY}%`,
      }
    }
  }
  // Picture-style shape clip: local px, so the clip sits on an unscaled layer that the
  // parent then scales to slide coordinates.
  const clip = pic.clip
  const clipStyle: React.CSSProperties = clip
    ? clip.pathData
      ? { clipPath: `path('${clip.pathData}')` }
      : clip.polygonPoints
        ? { clipPath: `polygon(${pointPairs(clip.polygonPoints)})` }
        : { borderRadius: clip.cornerRadiusPx ?? 0 }
    : {}
  return (
    <div style={{ ...frame, overflow: 'hidden', ...(opacity !== 1 ? { opacity } : {}) }}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: box.w,
          height: box.h,
          transform: `scale(${scale})`,
          transformOrigin: '0 0',
          overflow: 'hidden',
          ...clipStyle,
        }}
      >
        <img
          src={img.src}
          alt=""
          aria-hidden="true"
          draggable={false}
          style={{ ...imageStyle, objectFit: 'fill', pointerEvents: 'none' }}
        />
      </div>
    </div>
  )
}

function pointPairs(points: number[]): string {
  const out: string[] = []
  for (let i = 0; i + 1 < points.length; i += 2) out.push(`${points[i]}px ${points[i + 1]}px`)
  return out.join(', ')
}
