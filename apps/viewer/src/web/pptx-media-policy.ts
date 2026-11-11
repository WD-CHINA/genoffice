import JSZip from 'jszip'

/** Small auto-mode decks containing media need the server's codec preparation. */
export async function pptxHasMedia(file: Blob): Promise<boolean> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  const types = zip.file('[Content_Types].xml')
  // Read only a bounded content-types entry. Unknown/oversized metadata goes to
  // the server, whose ZIP gate validates the archive before parsing anything.
  const size = (types as unknown as { _data?: { uncompressedSize?: number } })?._data?.uncompressedSize
  if (!types || typeof size !== 'number' || size > 1024 * 1024) return true
  return /\bContentType\s*=\s*["'](?:audio|video)\//i.test(await types.async('string'))
}
