import { describe, expect, it } from 'vitest'
import {
  computeOverallProgress,
  createProgressReporter,
  estimateRemainingMs,
  formatEta,
  stageLabel,
} from './progress'

describe('computeOverallProgress', () => {
  it('walks through the phase weights monotonically', () => {
    expect(computeOverallProgress({ stage: 'idle', chunksCompleted: 0, totalChunks: 4 })).toBe(0)
    expect(computeOverallProgress({ stage: 'initializing', chunksCompleted: 0, totalChunks: 4 })).toBeCloseTo(0.02)
    expect(
      computeOverallProgress({ stage: 'loading-assets', chunksCompleted: 0, totalChunks: 4, assetFraction: 0.5 }),
    ).toBeCloseTo(0.05)
    expect(computeOverallProgress({ stage: 'done', chunksCompleted: 4, totalChunks: 4 })).toBe(1)
  })

  it('allocates progress per chunk while rendering and encoding', () => {
    const renderHalf = computeOverallProgress({
      stage: 'rendering',
      chunksCompleted: 0,
      totalChunks: 4,
      chunkRenderFraction: 0.5,
    })
    const encodeHalf = computeOverallProgress({
      stage: 'encoding',
      chunksCompleted: 0,
      totalChunks: 4,
      chunkEncodeFraction: 0.5,
    })
    expect(renderHalf).toBeGreaterThan(0.08)
    expect(encodeHalf).toBeGreaterThan(renderHalf)
    expect(
      computeOverallProgress({ stage: 'encoding', chunksCompleted: 4, totalChunks: 4, chunkEncodeFraction: 1 }),
    ).toBeCloseTo(0.9)
  })
})

describe('estimateRemainingMs', () => {
  it('combines measured render and encode speeds', () => {
    const eta = estimateRemainingMs({
      progress: 0.4,
      elapsedMs: 10_000,
      renderFps: 10,
      remainingFrames: 100,
      averageEncodeMs: 500,
      remainingChunks: 2,
    })
    // 100 frames at 10 fps = 10s, plus 2 chunks at 0.5s, plus finalize 2s
    expect(eta).toBe(13_000)
  })

  it('falls back to linear extrapolation before any speed is known', () => {
    const eta = estimateRemainingMs({
      progress: 0.5,
      elapsedMs: 10_000,
      renderFps: null,
      remainingFrames: 0,
      averageEncodeMs: null,
      remainingChunks: 0,
    })
    expect(eta).toBe(10_000)
  })

  it('returns zero once complete and null before progress exists', () => {
    expect(
      estimateRemainingMs({ progress: 1, elapsedMs: 100, renderFps: null, remainingFrames: 0, averageEncodeMs: null, remainingChunks: 0 }),
    ).toBe(0)
    expect(
      estimateRemainingMs({ progress: 0, elapsedMs: 0, renderFps: null, remainingFrames: 0, averageEncodeMs: null, remainingChunks: 0 }),
    ).toBeNull()
  })
})

describe('formatEta / stageLabel', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(formatEta(4_000)).toBe('4s')
    expect(formatEta(65_000)).toBe('1m 05s')
    expect(formatEta(3_700_000)).toBe('1h 1m')
    expect(formatEta(null)).toBe('—')
  })
  it('labels every stage', () => {
    expect(stageLabel('rendering')).toBe('Rendering frames')
    expect(stageLabel('error')).toBe('Failed')
  })
})

describe('createProgressReporter', () => {
  it('throttles high-frequency updates but lets forced stage changes through', () => {
    let now = 0
    const seen: string[] = []
    const reporter = createProgressReporter(
      (progress) => seen.push(progress.detail),
      100,
      () => now,
    )
    const make = (detail: string) => ({
      stage: 'rendering' as const,
      detail,
      progress: 0.1,
      frame: 1,
      totalFrames: 10,
      etaMs: null,
      renderFps: null,
      encodingSpeed: null,
    })
    reporter.report(make('a'))
    now = 50
    reporter.report(make('b'))
    reporter.report(make('c'), true)
    now = 150
    reporter.report(make('d'))
    expect(seen).toEqual(['a', 'c', 'd'])
  })
})
