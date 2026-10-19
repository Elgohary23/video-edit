import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPORT_SETTINGS,
  applyResolution,
  formatFps,
  normalizeExportSettings,
  qualityProfile,
  toEvenDimension,
} from './settings'

describe('normalizeExportSettings', () => {
  it('returns production defaults when nothing is provided', () => {
    expect(normalizeExportSettings()).toEqual(DEFAULT_EXPORT_SETTINGS)
  })

  it('resolves preset dimensions and ignores stale custom values', () => {
    const settings = normalizeExportSettings({ resolution: '720p', width: 999, height: 999 })
    expect(settings.width).toBe(720)
    expect(settings.height).toBe(1280)
  })

  it('rounds custom dimensions to even pixel counts', () => {
    const settings = normalizeExportSettings({ resolution: 'custom', width: 1081, height: 1921 })
    expect(settings.width).toBe(1082)
    expect(settings.height).toBe(1922)
  })

  it('clamps invalid values instead of trusting caller input', () => {
    const settings = normalizeExportSettings({
      quality: 'nonsense' as never,
      codec: 'nope' as never,
      fps: 5000,
      bitrate: 1,
      audioBitrate: 9999,
    })
    expect(settings.quality).toBe('standard')
    expect(settings.codec).toBe('h264')
    expect(settings.fps).toBe(240)
    expect(settings.bitrate).toBe(100)
    expect(settings.audioBitrate).toBe(512)
  })

  it('keeps auto bitrate as null and custom bitrates as numbers', () => {
    expect(normalizeExportSettings({ bitrate: null }).bitrate).toBeNull()
    expect(normalizeExportSettings({ bitrate: 8000 }).bitrate).toBe(8000)
  })
})

describe('toEvenDimension', () => {
  it('clamps to a minimum of 16 and a maximum of 7680', () => {
    expect(toEvenDimension(1, 100)).toBe(16)
    expect(toEvenDimension(99999, 100)).toBe(7680)
    expect(toEvenDimension(Number.NaN, 1080)).toBe(1080)
  })
})

describe('applyResolution', () => {
  it('switches presets and keeps custom dimensions when asked', () => {
    const base = normalizeExportSettings({ resolution: 'custom', width: 500, height: 900 })
    expect(applyResolution(base, '1080p')).toMatchObject({ width: 1080, height: 1920 })
    expect(applyResolution(base, 'custom')).toMatchObject({ width: 500, height: 900 })
  })
})

describe('qualityProfile', () => {
  it('gets slower and higher quality as the preset increases', () => {
    const draft = qualityProfile('draft')
    const ultra = qualityProfile('ultra')
    expect(draft.crf).toBeGreaterThan(ultra.crf)
    expect(draft.jpegQuality).toBeLessThan(ultra.jpegQuality)
  })
})

describe('formatFps', () => {
  it('prints integers plainly and trims fractional rates', () => {
    expect(formatFps(30)).toBe('30')
    expect(formatFps(29.97)).toBe('29.97')
  })
})
