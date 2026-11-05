import React from 'react'
import type { RenderNode, RenderSlide } from '@genoffice/pptx-render'
import { isAnimatedGif } from '../gif-animation'

/**
 * Native <img> overlay for animated GIF pictures. Canvas drawImage only paints the
 * first GIF frame reliably, so the animated picture is composited above the Konva
 * canvas at the same slide coordinates. Top-level pictures are covered here; group
 * children keep the canvas first frame.
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
  const pictures: Array<{ node: RenderNode; img: HTMLImageElement }> = []
  for (const node of slide.nodes) {
    if (node.type !== 'picture') continue
    const dataUrl = (node as { dataUrl?: string }).dataUrl
    const img = dataUrl ? images.get(dataUrl) : undefined
    if (img && isAnimatedGif(img)) pictures.push({ node, img })
  }
  if (!pictures.length) return null
  return (
    <div
      className="slides-gif-overlay"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}
    >
      {pictures.map(({ node, img }) => (
        <img
          key={node.id}
          src={img.src}
          alt=""
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: node.box.x * scale,
            top: node.box.y * scale,
            width: node.box.w * scale,
            height: node.box.h * scale,
            objectFit: 'fill',
            pointerEvents: 'none',
          }}
        />
      ))}
    </div>
  )
}
