import React from 'react'
import type {
  GroupRenderNode,
  PictureRenderNode,
  RenderNode,
  RenderSlide,
} from '@genoffice/pptx-render'
import { isAnimatedGif } from '../gif-animation'

/**
 * Native <img> overlay for animated GIF pictures. Canvas drawImage only paints the
 * first GIF frame reliably, so the animated picture is composited above the Konva
 * canvas at the same slide coordinates. Mirrors the canvas node tree: group wrappers
 * nest (children are in group-local coordinates and inherit the group transform), and
 * each frame carries the node's own rotation/flip/crop/picture-style clip.
 *
 * Known limits: pictures with blip color effects (duotone/clrChange/biLevel/lum) and
 * canvas-only effects (soft edge, reflection, shadow) render unprocessed here; the
 * overlay also always paints above the whole canvas, so a picture covered by a
 * later-in-z-order node is not occluded.
 */
export function GifOverlay({
  slide,
  images,
  width,
}: {
  slide: RenderSlide
  images: Map<string, HTMLImageElement>
  width: number
}) {
  const scale = width / slide.widthPx
  const keep = new Set<string>()
  if (!markGifBranches(slide.nodes, images, keep)) return null
  return (
    <div
      className="slides-gif-overlay"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}
    >
      {renderBranches(slide.nodes, images, keep, scale)}
    </div>
  )
}

interface GifPicture {
  node: PictureRenderNode
  img: HTMLImageElement
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

/** Depth-first: keep every node whose subtree carries a GIF, so groups can be pruned. */
function markGifBranches(
  nodes: RenderNode[],
  images: Map<string, HTMLImageElement>,
  keep: Set<string>,
): boolean {
  let any = false
  for (const node of nodes) {
    const child =
      node.type === 'group'
        ? markGifBranches((node as GroupRenderNode).children, images, keep)
        : false
    if (child || gifPicture(node, images)) {
      keep.add(node.id)
      any = true
    }
  }
  return any
}

function renderBranches(
  nodes: RenderNode[],
  images: Map<string, HTMLImageElement>,
  keep: Set<string>,
  scale: number,
): React.ReactNode[] {
  return nodes
    .filter((node) => keep.has(node.id))
    .map((node) => {
      const { box } = node
      // Same pivot and transform order as boxPivotProps (translate → rotate → flip,
      // around the box center): the CSS matrix is R·S, matching Konva.
      const frame: React.CSSProperties = {
        position: 'absolute',
        left: box.x * scale,
        top: box.y * scale,
        width: box.w * scale,
        height: box.h * scale,
        transform: `rotate(${box.rotationDeg}deg) scale(${box.flipH ? -1 : 1}, ${
          box.flipV ? -1 : 1
        })`,
        transformOrigin: '50% 50%',
      }
      if (node.type === 'group') {
        return (
          <div key={node.id} style={frame}>
            {renderBranches((node as GroupRenderNode).children, images, keep, scale)}
          </div>
        )
      }
      const pic = gifPicture(node, images)
      if (!pic) return null
      return (
        <GifPictureFrame key={node.id} frame={frame} pic={pic.node} img={pic.img} scale={scale} />
      )
    })
}

function GifPictureFrame({
  frame,
  pic,
  img,
  scale,
}: {
  frame: React.CSSProperties
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
    <div
      style={{
        ...frame,
        overflow: 'hidden',
        ...(pic.opacity != null ? { opacity: pic.opacity } : {}),
      }}
    >
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
