/** Keep original image bytes while avoiding a full base64 copy in every print-page clone. */
export function createDocxImageScope() {
  const urls = new Map<string, string>()
  const visit = (value: any, seen = new Set<object>()) => {
    if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || seen.has(value)) return
    seen.add(value)
    if (value instanceof Map) {
      for (const item of value.values()) visit(item, seen)
      return
    }
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && /^data:image\/[^;,]+;base64,/i.test(item)) {
        let url = urls.get(item)
        if (!url) {
          const comma = item.indexOf(','),
            binary = atob(item.slice(comma + 1))
          const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
          url = URL.createObjectURL(new Blob([bytes], { type: item.slice(5, item.indexOf(';')) }))
          urls.set(item, url)
        }
        value[key] = url
      } else if (key !== 'internal') visit(item, seen)
    }
  }
  return {
    adopt: visit,
    close() {
      for (const url of urls.values()) URL.revokeObjectURL(url)
      urls.clear()
    },
  }
}
