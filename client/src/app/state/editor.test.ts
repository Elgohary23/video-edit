import { describe, expect, it } from 'vitest'
import { editorReducer, initialEditorState, type EditorState } from './editor'

function stateWithClip(): EditorState {
  const base = editorReducer(initialEditorState, {
    type: 'MEDIA_IMPORTED',
    fileName: 'take.mp4',
    videoUrl: 'blob:x',
    durationMs: 3000,
  })
  return editorReducer(base, {
    type: 'CUT_APPLIED',
    cutPlan: {
      cutRegions: [{ startMs: 1000, endMs: 1200 }],
      keepSegments: [
        { startMs: 0, endMs: 1000 },
        { startMs: 1200, endMs: 3000 },
      ],
    },
  })
}

describe('media actions', () => {
  it('import replaces state with fresh defaults + media info', () => {
    const withClip = stateWithClip()
    const next = editorReducer(withClip, { type: 'MEDIA_IMPORTED', fileName: 'b.mp4', videoUrl: 'blob:y', durationMs: 10 })
    expect(next.clips).toEqual([])
    expect(next.props).toEqual([])
    expect(next.project?.fileName).toBe('b.mp4')
    expect(next.playing).toBe(false)
  })
  it('analysis progress clamps and done fills mixdown', () => {
    const base = stateWithClip()
    const tooMuch = editorReducer(base, { type: 'ANALYSIS_PROGRESS', ratio: 5 })
    expect(tooMuch.analysisProgress).toBe(1)
    const done = editorReducer(base, { type: 'ANALYSIS_DONE', samples: new Float32Array([0, 0.5]), sampleRate: 1000, durationMs: 2 })
    expect(done.project?.mixdown?.sampleRate).toBe(1000)
  })
})

describe('silence config + cut', () => {
  it('config change invalidates plan', () => {
    const withPlan = editorReducer(stateWithClip(), { type: 'SILENCE_CONFIG_SET', config: { thresholdDb: -40 } })
    expect(withPlan.silenceConfig.thresholdDb).toBe(-40)
    expect(withPlan.cutPlan).toBeNull()
    expect(stateWithClip().cutPlan).not.toBeNull()
  })
  it('cut applied builds clips and resets playhead', () => {
    const s = stateWithClip()
    expect(s.clips).toHaveLength(2)
    expect(s.cutPlan?.cutRegions).toEqual([{ startMs: 1000, endMs: 1200 }])
  })
})

describe('clip operations', () => {
  it('auto-zoom alternates 1 / 1.15 across clips', () => {
    const zoomed = editorReducer(stateWithClip(), { type: 'AUTO_ZOOM' })
    expect(zoomed.clips.map((c) => c.zoom)).toEqual([1, 1.15])
    expect(stateWithClip().clips.map((c) => c.zoom)).toEqual([1, 1])
  })
  it('split inserts two halves; trim narrows a clip', () => {
    const split = editorReducer(stateWithClip(), { type: 'CLIP_SPLIT', clipId: 'clip-2', atMs: 1100 })
    expect(split.clips).toHaveLength(3)
    expect(split.clips[1].srcStartMs).toBe(1200)
    expect(split.clips[1].srcEndMs).toBe(1300)

    const trimmed = editorReducer(split, { type: 'CLIP_TRIM', clipId: 'clip-2-L', leftMs: 50, rightMs: 25 })
    expect(trimmed.clips[1]).toMatchObject({ srcStartMs: 1250, srcEndMs: 1275 })
  })
})

describe('prop lifecycle', () => {
  it('add clamps to media duration and selects it', () => {
    const added = editorReducer(stateWithClip(), {
      type: 'PROP_ADDED',
      id: 'p1',
      name: 'arrow.png',
      src: 'data:png',
      aspect: 1,
    })
    expect(added.props).toHaveLength(1)
    expect(added.selectedPropId).toBe('p1')
    expect(added.props[0].range).toEqual({ startMs: 0, endMs: 3000 })
  })
  it('range set normalizes and enforces a 50ms minimum', () => {
    const state = { ...stateWithClip(), selectedPropId: 'p1', props: [{ id: 'p1', name: 'x', src: 's', rect: { x: 0, y: 0, w: 0.1, h: 0.1 }, range: { startMs: 0, endMs: 1000 }, preset: 'pop-bounce' as const }] }
    const provoked = editorReducer(state, { type: 'PROP_RANGE_SET', id: 'p1', range: { startMs: 900, endMs: 920 } })
    expect(provoked).toBe(state) // unchanged
    const ok = editorReducer(state, { type: 'PROP_RANGE_SET', id: 'p1', range: { startMs: 900, endMs: 800 } })
    expect(ok.props[0].range).toEqual({ startMs: 800, endMs: 900 })
  })
  it('remove clears the selection when it points at the removed prop', () => {
    const state = { ...stateWithClip(), selectedPropId: 'p1', props: [{ id: 'p1', name: 'x', src: 's', rect: { x: 0, y: 0, w: 1, h: 1 }, range: { startMs: 0, endMs: 100 }, preset: 'none' as const }] }
    const removed = editorReducer(state, { type: 'PROP_REMOVED', id: 'p1' })
    expect(removed.props).toEqual([])
    expect(removed.selectedPropId).toBeNull()
  })
})

describe('playback + export', () => {
  it('playhead clamps to timeline duration', () => {
    const s = stateWithClip() // timeline = 2800ms
    expect(s.clips.reduce((a, c) => a + (c.srcEndMs - c.srcStartMs), 0)).toBe(2800)
    const next = editorReducer(s, { type: 'PLAYHEAD_SET', playheadMs: 9999 })
    expect(next.playheadMs).toBe(2800)
  })
  it('playback set pauses at a position', () => {
    const next = editorReducer(stateWithClip(), { type: 'PLAYBACK_SET', playing: false, playheadMs: 120 })
    expect(next.playing).toBe(false)
    expect(next.playheadMs).toBe(120)
  })
  it('export phases update status with defaults kept detail', () => {
    const s = editorReducer(stateWithClip(), { type: 'EXPORT_PHASE_SET', phase: 'recording', detail: 'capturing' })
    expect(s.exportStatus).toEqual({ phase: 'recording', detail: 'capturing' })
    const t = editorReducer(s, { type: 'EXPORT_PHASE_SET', phase: 'transcoding' })
    expect(t.exportStatus.detail).toBe('capturing')
  })
})

describe('blur', () => {
  it('toggle + strength clamp', () => {
    const on = editorReducer(stateWithClip(), { type: 'BLUR_SET', enabled: true })
    expect(on.blur.enabled).toBe(true)
    const strong = editorReducer(on, { type: 'BLUR_STRENGTH_SET', px: 99 })
    expect(strong.blur.px).toBe(40)
  })
})
