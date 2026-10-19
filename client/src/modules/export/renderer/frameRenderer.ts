/**
 * Dedicated offline frame renderer.
 *
 * Each frame resolves the timeline deterministically, seeks a source-specific
 * export video element, composites through the shared 2D compositor, and
 * encodes JPEG bytes for FFmpeg. The preview element/canvas are untouched.
 */
import { drawFrame, type PropFrame, type VideoSource } from '../../compositor/engine'
import { resolveMotion } from '../../motion/engine'
import type { ExportJob, ExportProp, ExportSettings, FrameRenderer, PlannedClip } from '../types'
import { qualityProfile } from '../settings'
import { ExportError, isAbortLike } from '../utils/errors'
import { loadPropImages } from './assets'
import { createExportSurface, type ExportSurface } from './surface'
import { VideoPool } from './videoPool'
import { placementAt, planClips } from '../pipeline/timelinePlan'
import { createFrameEncoder, type FrameEncoder } from '../workers/frameEncoderClient'

/** Visible props at an instant, with motion already resolved. Pure + tested. */
export function activePropFrames(
  props: readonly ExportProp[],
  images: ReadonlyMap<string, CanvasImageSource>,
  timelineMs: number,
): PropFrame[] {
  const frames: PropFrame[] = []
  for (const prop of props) {
    if (prop.range.startMs > timelineMs || prop.range.endMs <= timelineMs) continue
    const image = images.get(prop.id)
    if (!image) continue
    frames.push({
      image,
      rect: prop.rect,
      transform: resolveMotion(prop.preset, timelineMs, prop.range.startMs, prop.range.endMs),
    })
  }
  return frames
}

class DefaultFrameRenderer implements FrameRenderer {
  readonly width: number
  readonly height: number
  private disposed = false

  constructor(
    private readonly surface: ExportSurface,
    private readonly pool: VideoPool,
    private readonly encoder: FrameEncoder,
    private readonly props: readonly ExportProp[],
    private readonly images: ReadonlyMap<string, CanvasImageSource>,
    private readonly planned: readonly PlannedClip[],
    private readonly clips: ExportJob['clips'],
    private readonly blur: ExportJob['blur'],
    private readonly fitMode: ExportJob['fitMode'],
    private readonly jpegQuality: number,
  ) {
    this.width = surface.width
    this.height = surface.height
  }

  async renderFrame(_frameIndex: number, timelineMs: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.disposed) throw new Error('Export renderer disposed')
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const placement = placementAt(this.planned, timelineMs)
    let video: VideoSource | null = null
    if (placement?.planned.sourceId) {
      const element = await this.pool.seek(placement.planned.sourceId, placement.srcMs, signal)
      if (element.readyState >= 2 && element.videoWidth > 0 && element.videoHeight > 0) {
        video = {
          el: element,
          width: element.videoWidth,
          height: element.videoHeight,
          ready: true,
        }
      }
    }

    drawFrame(this.surface.ctx, this.width, this.height, {
      clips: this.clips,
      playheadMs: timelineMs,
      blurEnabled: this.blur.enabled,
      blurPx: this.blur.px,
      fitMode: this.fitMode,
      video,
      activeProps: activePropFrames(this.props, this.images, timelineMs),
    })

    try {
      return await this.encoder.encode(this.surface.source, this.jpegQuality)
    } catch (error) {
      if (isAbortLike(error)) throw error
      throw new ExportError('ASSET_LOAD_FAILED', `Could not rasterize frame at ${timelineMs.toFixed(1)}ms`, {
        userMessage: 'Export failed while rasterizing a video frame.',
        cause: error,
      })
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.encoder.dispose()
    this.pool.dispose()
    this.surface.dispose()
  }
}

export interface CreateRendererOptions {
  signal?: AbortSignal
  onAssetProgress?: (ratio: number) => void
}

export async function createDefaultRenderer(
  job: ExportJob,
  settings: ExportSettings,
  options: CreateRendererOptions = {},
): Promise<FrameRenderer> {
  const { signal, onAssetProgress } = options
  const surface = createExportSurface(settings.width, settings.height)
  let pool: VideoPool | null = null
  let encoder: FrameEncoder | null = null
  try {
    const images = await loadPropImages(job.props, signal, (ratio) => onAssetProgress?.(ratio * 0.45))
    pool = new VideoPool(job.videos)
    await pool.preloadAll(signal, (ratio) => onAssetProgress?.(0.45 + ratio * 0.55))
    encoder = createFrameEncoder()
    const planned = planClips(job.clips, job.videos, job.activeVideoId)
    const profile = qualityProfile(settings.quality)
    return new DefaultFrameRenderer(
      surface,
      pool,
      encoder,
      job.props,
      images,
      planned,
      job.clips,
      job.blur,
      job.fitMode,
      profile.jpegQuality,
    )
  } catch (error) {
    encoder?.dispose()
    pool?.dispose()
    surface.dispose()
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    throw error
  }
}
