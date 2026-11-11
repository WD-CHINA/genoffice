import type { AnimationItem, ShapeKey, LinkTargetOp } from '../shared/ipc'

export interface MediaLoadOptions {
  signal?: AbortSignal
  onStatus?: (text: string) => void
  /** Explicit retry normalizes even a previously compatible media stream. */
  retry?: boolean
}

/** Host-independent read surface used by the original playback components. */
export interface SlidesDataSource {
  getTransition(index: number): Promise<any>
  getAnimations(index: number): Promise<AnimationItem[]>
  getShapeKeys(index: number): Promise<ShapeKey[]>
  getSlideLinks(index: number): Promise<Array<{ sourceId: string; target: LinkTargetOp }>>
  getRunLinks(index: number): Promise<any[]>
  getMediaData(index: number, sourceId: string, options?: MediaLoadOptions): Promise<{ kind: 'video' | 'audio'; dataUrl: string } | null>
  setShowFullScreen?(enabled: boolean): Promise<void>
}
