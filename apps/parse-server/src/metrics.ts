import {
  HeuristicMetrics,
  type FontMetrics,
  type FontMetricsProvider,
  type RunStyle,
} from '@genoffice/pptx-render'

export interface WidthItem {
  key: string
  family: string
  text: string
  bold: boolean
  italic: boolean
  kerning?: boolean
}

/**
 * Server-side metrics provider that records every text width the browser
 * should measure. Until a width comes back it estimates with the deterministic
 * heuristic; accepted widths are stored at 100px and scaled per run, exactly
 * like the Viewer worker's bundled metrics.
 */
export class FeedbackMetrics implements FontMetricsProvider {
  constructor(private readonly fallback: FontMetricsProvider = new HeuristicMetrics()) {}
  private readonly cache = new Map<string, number>()
  private readonly pending = new Map<string, WidthItem>()

  metrics(style: RunStyle): FontMetrics {
    return this.fallback.metrics(style)
  }

  measure(text: string, style: RunStyle): number {
    if (!text) return this.fallback.measure(text, style)
    const family = this.fallback.displayFamily?.(style, text) ?? style.fontFamily
    const key = `${style.bold ? 'b' : ''}${style.italic ? 'i' : ''}${style.kerning === false ? 'n' : ''}|${family}|${text}`
    const known = this.cache.get(key)
    if (known != null) return (known / 100) * style.fontSizePx
    this.pending.set(key, {
      key,
      family,
      text,
      bold: style.bold,
      italic: style.italic,
      kerning: style.kerning,
    })
    return this.fallback.measure(text, style)
  }

  displayFamily(style: RunStyle, text?: string) {
    return this.fallback.displayFamily?.(style, text) ?? style.fontFamily
  }
  substituted(style: RunStyle) {
    return this.fallback.substituted?.(style) ?? false
  }

  pendingWidthMeasurements(): WidthItem[] {
    return [...this.pending.values()]
  }

  hasPending(): boolean {
    return this.pending.size > 0
  }

  /** Restore this viewing session's accepted widths in a short-lived layout worker. */
  restore(widths: Readonly<Record<string, number>>): void {
    for (const [key, width] of Object.entries(widths)) {
      if (Number.isFinite(width) && width >= 0) this.cache.set(key, width)
    }
  }

  /** Accept browser-measured widths (at 100px) for pending keys. */
  accept(widths: Readonly<Record<string, number>>): void {
    for (const [key, width] of Object.entries(widths)) {
      if (!this.pending.has(key)) continue
      if (!Number.isFinite(width) || width < 0) continue
      this.cache.set(key, width)
      this.pending.delete(key)
    }
  }
}
