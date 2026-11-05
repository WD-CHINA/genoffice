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
 * A GIF whose frame is covered by anything later in the paint order falls back to the
 * canvas first frame: the overlay paints above the whole canvas, so leaving it in would
 * draw the animation over the covering content.
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
  // Every kept picture can still be hidden by an entrance animation
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

interface GifPicture {
  node: PictureRenderNode
  img: HTMLImageElement
}

interface OverlayPlan {
  /** GIF pictures that keep their overlay, by node id */
  pictures: Map<string, GifPicture>
  /** Nodes whose subtree still carries a picture (ancestors of the kept ones) */
  keep: Set<string>
}

function gifPicture(node: RenderNode, images: Map<string, HTMLImageElement>): GifPicture | null {
  if (node.type !== 'picture') return null
  const pic = node as PictureRenderNode
  // Video/audio poster frames are stills, never animated GIFs
  if (pic.media) return null
  const img = pic.dataUrl ? images.get(pic.dataUrl) : undefined
  if (!img || !isAnimatedGif(img)) return null
  // ≤2×2 pictures stretch to one flat color on the canvas; an overlay would blow it up
  const w = img.naturalWidth || img.width
  const h = img.naturalHeight || img.height
  if (w > 0 && h > 0 && w <= 2 && h <= 2) return null
  return { node: pic, img }
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

function planOverlay(
  nodes: RenderNode[],
  images: Map<string, HTMLImageElement>,
): OverlayPlan | null {
  const flat: FlatNode[] = []
  flattenPaintOrder(nodes, IDENTITY, flat)
  const pictures = new Map<string, GifPicture>()
  for (const entry of flat) {
    const pic = gifPicture(entry.node, images)
    if (pic) pictures.set(entry.node.id, pic)
  }
  if (!pictures.size) return null
  // Anything painted later that overlaps the GIF's frame would have drawn over it on
  // the canvas; the overlay can't be occluded, so that GIF keeps the canvas first frame.
  const covered = new Set<string>()
  for (let i = 0; i < flat.length; i++) {
    const entry = flat[i]!
    if (!pictures.has(entry.node.id)) continue
    for (let j = i + 1; j < flat.length; j++) {
      const later = flat[j]!
      // A group paints only through its children (already in the list)
      if (later.node.type === 'group') continue
      if (overlaps(entry.rect, later.rect)) {
        covered.add(entry.node.id)
        break
      }
    }
  }
  for (const id of covered) pictures.delete(id)
  if (!pictures.size) return null
  const keep = new Set<string>()
  markKeep(nodes, pictures, keep)
  return { pictures, keep }
}

/** Keep every node whose subtree holds a kept picture, so groups can be pruned. */
function markKeep(
  nodes: RenderNode[],
  pictures: Map<string, GifPicture>,
  keep: Set<string>,
): boolean {
  let any = false
  for (const node of nodes) {
    const child =
      node.type === 'group' ? markKeep((node as GroupRenderNode).children, pictures, keep) : false
    if (child || pictures.has(node.id)) {
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
      const pic = plan.pictures.get(node.id)
      if (!pic) return null
      return (
        <GifPictureFrame
          key={node.id}
          frame={frame}
          opacity={(st?.opacity ?? 1) * (pic.node.opacity ?? 1)}
          pic={pic.node}
          img={pic.img}
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

function GifPictureFrame({
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
