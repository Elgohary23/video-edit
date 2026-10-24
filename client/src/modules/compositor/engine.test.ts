import { describe, expect, it, vi } from 'vitest'
import { computeContainRect, computeCropRect, computePropRect, drawFrame, PREVIEW_FRAME, type CompositorSettings } from './engine'
import { IDENTITY_TRANSFORM } from '../motion/engine'
import type { Clip } from '../timeline/engine'

describe('computeCropRect — cover fit then centered punch-in', () => {
  it('same aspect, zoom 1 → identity crop', () => {
    expect(computeCropRect(1000, 1000, 100, 100, 1)).toEqual({ sx: 0, sy: 0, sw: 1000, sh: 1000 })
  })
  it('widescreen video in square canvas crops sides', () => {
    // 2:1 video into 1:1 canvas → 1000×1000 crop centered on 2000×1000
    const crop = computeCropRect(2000, 1000, 100, 100, 1)
    expect(crop.sw).toBeCloseTo(1000, 6)
    expect(crop.sh).toBeCloseTo(1000, 6)
    expect(crop.sx).toBeCloseTo(500, 6)
    expect(crop.sy).toBeCloseTo(0, 6)
  })
  it('zoom 1.15 shrinks the visible window around center', () => {
    const zoom = 1.15
    const crop = computeCropRect(1000, 1000, 100, 100, zoom)
    expect(crop.sw).toBeCloseTo(1000 / zoom, 6)
    expect(crop.sx).toBeCloseTo((1000 - 1000 / zoom) / 2, 6)
  })
  it('degenerate canvas still yields a sane crop', () => {
    const crop = computeCropRect(1000, 1000, 0, 100, 1)
    expect(crop.sh).toBeCloseTo(1000, 6)
  })
})

describe('computeContainRect — pillarbox / letterbox fit preserving full frame', () => {
  it('portrait or taller video in widescreen canvas pillarboxes without height crop', () => {
    // 1000x1000 in 1280x720 canvas → height matches 720, width 720, centered horizontally
    const r = computeContainRect(1000, 1000, 1280, 720, 1)
    expect(r.dh).toBeCloseTo(720, 6)
    expect(r.dw).toBeCloseTo(720, 6)
    expect(r.dx).toBeCloseTo((1280 - 720) / 2, 6)
    expect(r.dy).toBeCloseTo(0, 6)
    // 0 pixels cropped from video source
    expect(r.sw).toBeCloseTo(1000, 6)
    expect(r.sh).toBeCloseTo(1000, 6)
  })
  it('zoom punches in within source space while maintaining letterbox destination', () => {
    const r = computeContainRect(1000, 1000, 1280, 720, 1.15)
    expect(r.sw).toBeCloseTo(1000 / 1.15, 6)
    expect(r.sh).toBeCloseTo(1000 / 1.15, 6)
    expect(r.sx).toBeCloseTo((1000 - 1000 / 1.15) / 2, 6)
  })
})

describe('landscape source into the fixed 9:16 PREVIEW_FRAME', () => {
  const { width: canvasW, height: canvasH } = PREVIEW_FRAME

  it('cover crops the horizontal overflow so landscape fills the portrait frame', () => {
    const crop = computeCropRect(1920, 1080, canvasW, canvasH, 1)
    expect(crop.sh).toBeCloseTo(1080, 6) // full height kept
    expect(crop.sw).toBeCloseTo(1080 * (canvasW / canvasH), 6)
    expect(crop.sx).toBeCloseTo((1920 - crop.sw) / 2, 6)
    expect(crop.sy).toBeCloseTo(0, 6)
  })

  it('contain pillarboxes the landscape video with zero source crop', () => {
    const r = computeContainRect(1920, 1080, canvasW, canvasH, 1)
    expect(r.dw).toBeCloseTo(canvasW, 6)
    expect(r.dh).toBeCloseTo(canvasW / (1920 / 1080), 6) // 405
    expect(r.dx).toBeCloseTo(0, 6)
    expect(r.dy).toBeCloseTo((canvasH - r.dh) / 2, 6)
    expect(r.sw).toBeCloseTo(1920, 6) // nothing cropped from the source
    expect(r.sh).toBeCloseTo(1080, 6)
  })
})

describe('computePropRect — centered scaling with relative offsets', () => {
  it('natural size: rect coords scale to canvas space', () => {
    const dest = computePropRect({ x: 0.35, y: 0.4, w: 0.3, h: 0.2 }, 1000, 500, IDENTITY_TRANSFORM)
    expect(dest.w).toBeCloseTo(300, 6)
    expect(dest.h).toBeCloseTo(100, 6)
    expect(dest.x).toBeCloseTo(350, 6)
    expect(dest.y).toBeCloseTo(200, 6)
    expect(dest.alpha).toBe(1)
  })
  it('scale is anchored at the prop center', () => {
    const dest = computePropRect({ x: 0.35, y: 0.4, w: 0.3, h: 0.2 }, 1000, 500, { scale: 2, offsetX: 0, offsetY: 0, opacity: 1 })
    expect(dest.w).toBeCloseTo(600, 6)
    expect(dest.x).toBeCloseTo(500 - 300, 6) // center unchanged at 500
  })
  it('offsetX moves by a fraction of the zoomed prop width', () => {
    const dest = computePropRect({ x: 0.35, y: 0.4, w: 0.3, h: 0.2 }, 1000, 500, { scale: 2, offsetX: -0.5, offsetY: 0, opacity: 1 })
    // zoomed width 600 × 0.5 = 300px to the left
    expect(dest.x).toBeCloseTo(500 - 300 - 300, 6)
  })
})

/** Minimal recording Canvas2D stub. */
function stubCtx(canvasW = 640, canvasH = 360) {
  const calls: string[] = []
  const ctx = {
    clearRect: vi.fn((...args: unknown[]) => calls.push(`clear:${args.join(',')}`)),
    drawImage: vi.fn((...args: unknown[]) => calls.push(`draw:${args.join(',')}`)),
    fillRect: vi.fn((...args: unknown[]) => calls.push(`fill:${args.join(',')}`)),
    save: vi.fn(() => calls.push('save')),
    restore: vi.fn(() => calls.push('restore')),
    translate: vi.fn((...args: unknown[]) => calls.push(`translate:${args.join(',')}`)),
    rotate: vi.fn((...args: unknown[]) => calls.push(`rotate:${args.join(',')}`)),
    filter: 'none',
    globalAlpha: 1,
    fillStyle: '#000',
    canvas: { width: canvasW, height: canvasH },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, raw: ctx }
}

describe('drawFrame', () => {
  const clip: Clip = { id: 'a', srcStartMs: 0, srcEndMs: 1000, zoom: 1 }

  it('renders black when no video', () => {
    const { ctx, calls, raw } = stubCtx()
    const settings: CompositorSettings = { clips: [clip], playheadMs: 0, blurEnabled: true, blurPx: 10, video: null, activeProps: [] }
    drawFrame(ctx, 640, 360, settings)
    expect(raw.clearRect).toHaveBeenCalledTimes(1)
    expect(calls.every((c) => c.startsWith('clear:'))).toBe(true)
  })
  it('draws the video cover-cropped, no blur without active props', () => {
    const { ctx, calls, raw } = stubCtx()
    const video = { el: 'video-el' as unknown as CanvasImageSource, width: 1000, height: 1000, ready: true }
    const settings: CompositorSettings = { clips: [clip], playheadMs: 0, blurEnabled: true, blurPx: 12, video, activeProps: [] }
    drawFrame(ctx, 640, 360, settings)

    expect(raw.filter).toBe('none')
    const draw = calls.find((c) => c.startsWith('draw:video-el'))
    // 1:1 video into 16:9 canvas → full width crop, height 562.5, vertically centered
    expect(draw).toBe('draw:video-el,0,218.75,1000,562.5,0,0,640,360')
  })
  it('applies blur while a prop is active, and resets filters/alpha after', () => {
    const { ctx, calls, raw } = stubCtx()
    const video = { el: 'v' as unknown as CanvasImageSource, width: 1000, height: 1000, ready: true }
    const image = 'img' as unknown as CanvasImageSource
    const settings: CompositorSettings = {
      clips: [clip],
      playheadMs: 0,
      blurEnabled: true,
      blurPx: 8,
      video,
      activeProps: [{ image, rect: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, transform: { scale: 1, offsetX: 0, offsetY: 0, opacity: 0.5 } }],
    }
    drawFrame(ctx, 640, 360, settings)

    const videoDraw = calls.findIndex((c) => c.startsWith('draw:v') && !c.startsWith('draw:img'))
    expect(videoDraw).toBeGreaterThanOrEqual(0)
    expect(calls.filter((c) => c.startsWith('draw:img'))).toHaveLength(1)
    expect(raw.filter).toBe('none')
    expect(raw.globalAlpha).toBe(1)
  })
  it('punch-in zoom crops a centered 1/zoom window', () => {
    const { ctx, calls } = stubCtx()
    const zoomed: Clip = { id: 'b', srcStartMs: 0, srcEndMs: 1000, zoom: 1.15 }
    const video = { el: 'v' as unknown as CanvasImageSource, width: 3840, height: 2160, ready: true }
    const settings: CompositorSettings = { clips: [zoomed], playheadMs: 0, blurEnabled: false, blurPx: 0, video, activeProps: [] }
    drawFrame(ctx, 640, 360, settings)

    const draw = calls.find((c) => c.startsWith('draw:v'))!
    const [sx, sy, sw, sh] = draw.slice('draw:v,'.length).split(',').map(Number)
    expect(sw).toBeCloseTo(3840 / 1.15, 4)
    expect(sh).toBeCloseTo(2160 / 1.15, 4)
    expect(sx + sw / 2).toBeCloseTo(1920, 4)
    expect(sy + sh / 2).toBeCloseTo(1080, 4)
  })
  it('draws with fitMode contain letterboxed without crop', () => {
    const { ctx, calls } = stubCtx()
    const video = { el: 'v-portrait' as unknown as CanvasImageSource, width: 720, height: 1280, ready: true }
    const settings: CompositorSettings = { clips: [clip], playheadMs: 0, blurEnabled: false, blurPx: 0, fitMode: 'contain', video, activeProps: [] }
    drawFrame(ctx, 640, 360, settings)

    // Should contain inside 640x360: height is 360, width is 360 * (720/1280) = 202.5, dx = (640 - 202.5)/2 = 218.75
    const drawMain = calls.find((c) => c.startsWith('draw:v-portrait,0,0,720,1280,218.75,0,202.5,360'))
    expect(drawMain).toBeDefined()
  })

  it('holds the previous frame instead of clearing while a source is undecodable', () => {
    const { ctx, calls, raw } = stubCtx()
    const video = { el: 'v' as unknown as CanvasImageSource, width: 1000, height: 1000, ready: false }
    const settings: CompositorSettings = {
      clips: [clip],
      playheadMs: 500,
      blurEnabled: false,
      blurPx: 0,
      video,
      activeProps: [],
      holdLastFrame: true,
    }
    drawFrame(ctx, 640, 360, settings)
    expect(raw.clearRect).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it('still renders a ready frame when holdLastFrame is set', () => {
    const { ctx, raw } = stubCtx()
    const video = { el: 'v' as unknown as CanvasImageSource, width: 1000, height: 1000, ready: true }
    const settings: CompositorSettings = {
      clips: [clip],
      playheadMs: 500,
      blurEnabled: false,
      blurPx: 0,
      video,
      activeProps: [],
      holdLastFrame: true,
    }
    drawFrame(ctx, 640, 360, settings)
    expect(raw.clearRect).toHaveBeenCalledTimes(1)
    expect(raw.drawImage).toHaveBeenCalled()
  })

  it('paints the small pre-blurred backdrop instead of the full blur fallback', () => {
    const { ctx, calls } = stubCtx()
    const video = { el: 'v-portrait' as unknown as CanvasImageSource, width: 720, height: 1280, ready: true }
    const settings: CompositorSettings = {
      clips: [clip],
      playheadMs: 0,
      blurEnabled: false,
      blurPx: 0,
      fitMode: 'contain',
      video,
      activeProps: [],
      backdrop: 'backdrop' as unknown as CanvasImageSource,
    }
    drawFrame(ctx, 640, 360, settings)

    const backdropIndex = calls.indexOf('draw:backdrop,0,0,640,360')
    const videoIndex = calls.findIndex((call) => call.startsWith('draw:v-portrait'))
    expect(backdropIndex).toBeGreaterThanOrEqual(0)
    expect(videoIndex).toBeGreaterThan(backdropIndex)
    // The expensive per-frame blur of the source is not used.
    expect(calls.filter((call) => call.startsWith('draw:v-portrait'))).toHaveLength(1)
    expect(calls.some((call) => call.startsWith('fill:'))).toBe(true)
  })

  it('leaves the letterbox transparent for alpha exports', () => {
    const { ctx, calls } = stubCtx()
    const video = { el: 'v-portrait' as unknown as CanvasImageSource, width: 720, height: 1280, ready: true }
    const settings: CompositorSettings = {
      clips: [clip],
      playheadMs: 0,
      blurEnabled: false,
      blurPx: 0,
      fitMode: 'contain',
      video,
      activeProps: [],
      backdrop: 'backdrop' as unknown as CanvasImageSource,
      preserveAlpha: true,
    }
    drawFrame(ctx, 640, 360, settings)
    expect(calls.some((call) => call.startsWith('draw:backdrop'))).toBe(false)
    expect(calls.some((call) => call.startsWith('fill:'))).toBe(false)
    expect(calls.filter((call) => call.startsWith('draw:v-portrait'))).toHaveLength(1)
  })

  it('falls back to a blurred full-frame backdrop when no backdrop was supplied', () => {
    const { ctx, calls, raw } = stubCtx()
    const video = { el: 'v-portrait' as unknown as CanvasImageSource, width: 720, height: 1280, ready: true }
    const settings: CompositorSettings = {
      clips: [clip],
      playheadMs: 0,
      blurEnabled: false,
      blurPx: 0,
      fitMode: 'contain',
      video,
      activeProps: [],
    }
    drawFrame(ctx, 640, 360, settings)
    expect(calls.filter((call) => call.startsWith('draw:v-portrait'))).toHaveLength(2)
    expect(raw.filter).toBe('none')
  })

  it('balances save/restore when rotating so exports do not accumulate transforms', () => {
    const { ctx, calls } = stubCtx()
    const video = { el: 'v' as unknown as CanvasImageSource, width: 1000, height: 1000, ready: true }
    const settings: CompositorSettings = {
      clips: [clip],
      playheadMs: 0,
      blurEnabled: false,
      blurPx: 0,
      rotation: 90,
      video,
      activeProps: [],
    }
    drawFrame(ctx, 640, 360, settings)
    expect(calls[0]).toBe('clear:0,0,640,360')
    expect(calls[1]).toBe('save')
    expect(calls.at(-1)).toBe('restore')
    expect(calls.filter((call) => call === 'save')).toHaveLength(1)
    expect(calls.filter((call) => call === 'restore')).toHaveLength(1)
  })
})
