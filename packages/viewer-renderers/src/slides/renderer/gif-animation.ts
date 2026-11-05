/** True when this decoded image is an animated GIF (data URL, media URL or tagged blob). */
export function isAnimatedGif(img: HTMLImageElement): boolean {
  if ((img as HTMLImageElement & { __genofficeAnimatedGif?: boolean }).__genofficeAnimatedGif)
    return true
  const src = img.currentSrc || img.src || ''
  return src.startsWith('data:image/gif') || /\.gif(?:[?#]|$)/i.test(src)
}
