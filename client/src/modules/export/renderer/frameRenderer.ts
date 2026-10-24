/**
 * Dedicated offline frame renderer.
 *
 * Each frame resolves the timeline deterministically, seeks a source-specific
 * export video element, composites through the shared 2D compositor, and
 * encodes JPEG bytes for FFmpeg. The preview element/canvas are untouched.
 */
import { drawFrame, type PropFrame, type VideoSource } from '../../compositor/engine'
import { createBackdropRenderer, type BackdropRenderer } from '../../compositor/backdrop'
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
  private readonly backdrop: BackdropRenderer | null

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
    private readonly preserveAlpha: boolean,
  ) {
    this.width = surface.width
    this.height = surface.height
    // Alpha exports must keep the area around a contained PNG transparent, so
    // the blurred backdrop is disabled for them.
    this.backdrop = preserveAlpha ? null : createBackdropRenderer(surface.width, surface.height)
  }

  async renderFrame(_frameIndex: number, timelineMs: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.disposed) throw new Error('Export renderer disposed')
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const placement = placementAt(this.planned, timelineMs)
    if (!placement || placement.planned.sourceId === null) {
      throw new ExportError('NO_CLIPS', `No clip covers export frame at ${timelineMs.toFixed(1)}ms`, {
        userMessage: 'Export failed because the timeline changed during the export. Try again.',
      })
    }

    const frame = await this.pool.resolve(placement.planned.sourceId, placement.srcMs, signal)
    if (!frame.ready) {
      // Never silently rasterize a black frame: a missing decoded frame is a
      // hard error the user can act on (re-import / lower resolution).
      throw new ExportError(
        'ASSET_LOAD_FAILED',
        `Source ${placement.planned.sourceId} has no decoded frame at ${placement.srcMs.toFixed(1)}ms`,
        { userMessage: 'Export stopped because the browser could not decode a video frame. Try a lower resolution.' },
      )
    }

    const video: VideoSource = { el: frame.el, width: frame.width, height: frame.height, ready: true }
    // The backdrop only matters for `contain`; skipping the work for a
    // full-frame `cover` export saves one draw per frame.
    if (this.backdrop && this.fitMode === 'contain') this.backdrop.draw(frame.el)

    drawFrame(this.surface.ctx, this.width, this.height, {
      clips: this.clips,
      playheadMs: timelineMs,
      blurEnabled: this.blur.enabled,
      blurPx: this.blur.px,
      fitMode: this.fitMode,
      video,
      activeProps: activePropFrames(this.props, this.images, timelineMs),
      backdrop: this.backdrop ? this.backdrop.canvas : null,
      preserveAlpha: this.preserveAlpha,
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
    this.backdrop?.dispose()
    this.surface.dispose()
  }
}

export interface CreateRendererOptions {
  signal?: AbortSignal
  onAssetProgress?: (ratio: number) => void
  /** Encode PNG frames with an alpha channel (VP9/WebM exports). */
  preserveAlpha?: boolean
}

export async function createDefaultRenderer(
  job: ExportJob,
  settings: ExportSettings,
  options: CreateRendererOptions = {},
): Promise<FrameRenderer> {
  const { signal, onAssetProgress } = options
  const preserveAlpha = options.preserveAlpha === true
  const surface = createExportSurface(settings.width, settings.height, preserveAlpha)
  let pool: VideoPool | null = null
  let encoder: FrameEncoder | null = null
  try {
    const images = await loadPropImages(job.props, signal, (ratio) => onAssetProgress?.(ratio * 0.45))
    pool = new VideoPool(job.videos)
    await pool.preloadAll(signal, (ratio) => onAssetProgress?.(0.45 + ratio * 0.55))
    // PNG frames are required for VP9 alpha; JPEG stays the default because
    // it is substantially faster to encode and smaller in MEMFS.
    encoder = createFrameEncoder(preserveAlpha ? 'png' : 'jpeg')
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
      preserveAlpha,
    )
  } catch (error) {
    encoder?.dispose()
    pool?.dispose()
    surface.dispose()
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    throw error
  }
}
