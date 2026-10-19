import { describe, expect, it } from 'vitest'
import { clipSourceId, clipVideoSource, clipsOfSource, editorReducer, initialEditorState, type EditorState } from './editor'
import { timelineStartOfClip } from '../../modules/timeline/engine'

function stateWithClip(): EditorState {
  const base = editorReducer(initialEditorState, {
    type: 'VIDEO_ADDED',
    id: 'vid-1',
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
  it('import appends a full-length clip to the track and keeps the edit so far', () => {
    const withClip = stateWithClip()
    const next = editorReducer(withClip, { type: 'VIDEO_ADDED', id: 'vid-2', fileName: 'b.mp4', videoUrl: 'blob:y', durationMs: 10 })
    // the track grows instead of resetting: vid-1's segments stay, then b.mp4
    expect(next.clips).toHaveLength(3)
    expect(next.clips[2]).toMatchObject({ videoId: 'vid-2', srcStartMs: 0, srcEndMs: 10, zoom: 1 })
    expect(next.props).toEqual(withClip.props)
    expect(next.project?.fileName).toBe('b.mp4')
    expect(next.playing).toBe(false)
    // multi-video: the new source joins the list and takes over the edit target
    expect(next.videos).toHaveLength(2)
    expect(next.videos[0]).toMatchObject({ id: 'vid-1', fileName: 'take.mp4' })
    expect(next.activeVideoId).toBe('vid-2')
    // the derived plan follows the active source (vid-2 has none yet)
    expect(next.cutPlan).toBeNull()
    expect(next.cutPlans['vid-1']).toBeDefined()
  })

  it('a durationless import still joins the list but adds no empty clip', () => {
    const next = editorReducer(stateWithClip(), { type: 'VIDEO_ADDED', id: 'vid-2', fileName: 'b.mp4', videoUrl: 'blob:y', durationMs: 0 })
    expect(next.clips).toHaveLength(2)
    expect(next.clips.every((c) => c.videoId === 'vid-1')).toBe(true)
  })

  it('selecting an imported video retargets the tools but keeps the one track', () => {
    const twoVideos = stateWithClip()
    const second = editorReducer(twoVideos, { type: 'VIDEO_ADDED', id: 'vid-2', fileName: 'b.mp4', videoUrl: 'blob:y', durationMs: 10 })
    const analyzed = editorReducer(second, {
      type: 'ANALYSIS_DONE',
      videoId: 'vid-1',
      samples: new Float32Array([0.2]),
      sampleRate: 1000,
      durationMs: 1,
    })
    const back = editorReducer(analyzed, { type: 'VIDEO_SELECTED', id: 'vid-1' })
    expect(back.activeVideoId).toBe('vid-1')
    expect(back.project?.fileName).toBe('take.mp4')
    expect(back.project?.mixdown?.sampleRate).toBe(1000) // vid-1's analysis follows it
    expect(back.videos).toHaveLength(2) // the other source stays in the list
    // the track survives switching — both sources' clips keep their order
    expect(back.clips).toEqual(analyzed.clips)
    expect(back.props).toEqual(analyzed.props)
    // the derived plan belongs to vid-1 again
    expect(back.cutPlan?.cutRegions).toEqual([{ startMs: 1000, endMs: 1200 }])
    expect(editorReducer(analyzed, { type: 'VIDEO_SELECTED', id: 'nope' })).toBe(analyzed)
  })

  it('clipSourceId resolves explicit ids; legacy clips follow the active source', () => {
    const s = stateWithClip()
    expect(clipSourceId(s, s.clips[0])).toBe('vid-1')
    const legacy = { id: 'clip-x', srcStartMs: 0, srcEndMs: 1, zoom: 1 }
    expect(clipSourceId(s, legacy)).toBe('vid-1')
    expect(clipVideoSource(s, legacy)?.fileName).toBe('take.mp4')
    // a dangling videoId falls back to the active source too
    expect(clipSourceId(s, { ...legacy, videoId: 'ghost' })).toBe('vid-1')
    const two = editorReducer(s, { type: 'VIDEO_ADDED', id: 'vid-2', fileName: 'b.mp4', videoUrl: 'blob:y', durationMs: 10 })
    expect(clipVideoSource(two, two.clips[2])?.fileName).toBe('b.mp4')
    expect(clipsOfSource(two, 'vid-2')).toHaveLength(1)
    expect(clipsOfSource(two, 'vid-1')).toHaveLength(2)
  })

  it('analysis progress clamps and done fills mixdown of the named source', () => {
    const base = stateWithClip()
    const tooMuch = editorReducer(base, { type: 'ANALYSIS_PROGRESS', ratio: 5 })
    expect(tooMuch.analysisProgress).toBe(1)
    const done = editorReducer(base, { type: 'ANALYSIS_DONE', samples: new Float32Array([0, 0.5]), sampleRate: 1000, durationMs: 2 })
    expect(done.project?.mixdown?.sampleRate).toBe(1000)
    expect(done.videos[0].mixdown?.sampleRate).toBe(1000)
  })

  it('analysis done for a non-active video updates that video only', () => {
    const base = stateWithClip()
    const other = editorReducer(base, { type: 'VIDEO_ADDED', id: 'vid-2', fileName: 'b.mp4', videoUrl: 'blob:y', durationMs: 10 })
    const next = editorReducer(other, {
      type: 'ANALYSIS_DONE',
      videoId: 'vid-1',
      samples: new Float32Array([1]),
      sampleRate: 2000,
      durationMs: 2,
    })
    expect(next.videos.find((v) => v.id === 'vid-1')?.mixdown?.sampleRate).toBe(2000)
    expect(next.videos.find((v) => v.id === 'vid-2')?.mixdown).toBeNull()
    expect(next.project?.mixdown).toBeNull() // vid-2 stays the active edit target
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

describe('endless appending (one track, many clips)', () => {
  it('CLIP_APPEND appends the full source at the end of the track', () => {
    const two = editorReducer(stateWithClip(), { type: 'VIDEO_ADDED', id: 'vid-2', fileName: 'b.mp4', videoUrl: 'blob:y', durationMs: 10 })
    const grown = editorReducer(two, { type: 'CLIP_APPEND', videoId: 'vid-2' })
    expect(grown.clips).toHaveLength(4)
    const last = grown.clips[3]
    expect(last).toMatchObject({ videoId: 'vid-2', srcStartMs: 0, srcEndMs: 10, zoom: 1 })
    // appended after vid-2's own seeded clip — starts exactly where the track ended
    expect(timelineStartOfClip(grown.clips, 3)).toBe(2810)
    expect(grown.clips.slice(0, 3).reduce((a, c) => a + (c.srcEndMs - c.srcStartMs), 0)).toBe(timelineStartOfClip(grown.clips, 3))
  })
  it('CLIP_APPEND without a resolvable source is a no-op (same reference)', () => {
    const s = stateWithClip()
    expect(editorReducer(s, { type: 'CLIP_APPEND', videoId: 'ghost' })).toBe(s)
    const empty = initialEditorState
    expect(editorReducer(empty, { type: 'CLIP_APPEND' })).toBe(empty)
  })
})

describe('per-source silence cuts on a shared track', () => {
  const twoSources = () =>
    editorReducer(stateWithClip(), { type: 'VIDEO_ADDED', id: 'vid-2', fileName: 'b.mp4', videoUrl: 'blob:y', durationMs: 10 })

  it('cutting the active source keeps the other import intact', () => {
    const s = twoSources() // [clip-1(vid-1), clip-2(vid-1), b.mp4 full(vid-2)]
    expect(s.activeVideoId).toBe('vid-2')
    const cut = editorReducer(s, {
      type: 'CUT_APPLIED',
      cutPlan: {
        cutRegions: [{ startMs: 2, endMs: 5 }],
        keepSegments: [
          { startMs: 0, endMs: 2 },
          { startMs: 5, endMs: 10 },
        ],
      },
    })
    // vid-1's two clips stay before vid-2's two new segments
    expect(cut.clips).toHaveLength(4)
    expect(cut.clips[0]).toMatchObject({ videoId: 'vid-1', srcEndMs: 1000 })
    expect(cut.clips[2]).toMatchObject({ videoId: 'vid-2', srcStartMs: 0, srcEndMs: 2 })
    expect(cut.clips[3]).toMatchObject({ videoId: 'vid-2', srcStartMs: 5, srcEndMs: 10 })
    expect(cut.cutPlan?.cutRegions).toEqual([{ startMs: 2, endMs: 5 }])
  })

  it('generated ids never collide with another source that already owns clip-1', () => {
    const s = twoSources()
    const cut = editorReducer(s, { type: 'CUT_APPLIED', cutPlan: { cutRegions: [], keepSegments: [{ startMs: 0, endMs: 10 }] } })
    const ids = cut.clips.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids[0]).toBe('clip-1') // vid-1's original untouched
    expect(ids[2]).not.toBe('clip-1') // vid-2's replacement got a fresh id
  })

  it('reset restores only the active source to one full clip, in place', () => {
    const s = twoSources()
    const cut = editorReducer(s, {
      type: 'CUT_APPLIED',
      cutPlan: { cutRegions: [{ startMs: 2, endMs: 5 }], keepSegments: [{ startMs: 0, endMs: 2 }, { startMs: 5, endMs: 10 }] },
    })
    const reset = editorReducer(cut, { type: 'RESET_CUTS' })
    expect(reset.clips).toHaveLength(3)
    expect(reset.clips[2]).toMatchObject({ videoId: 'vid-2', srcStartMs: 0, srcEndMs: 10 })
    expect(reset.cutPlan).toBeNull() // vid-2's plan cleared
    expect(reset.clips[0].videoId).toBe('vid-1') // vid-1 keeps its cut clips
  })

  it('silence config change only invalidates the active plan', () => {
    const s = twoSources() // active = vid-2 (no plan)
    const cutVid2 = editorReducer(s, { type: 'CUT_APPLIED', cutPlan: { cutRegions: [], keepSegments: [{ startMs: 0, endMs: 10 }] } })
    expect(cutVid2.cutPlan).not.toBeNull()
    // switch to vid-1 (has a plan), tinker config → vid-1's plan drops
    const back = editorReducer(cutVid2, { type: 'VIDEO_SELECTED', id: 'vid-1' })
    expect(back.cutPlan?.cutRegions).toEqual([{ startMs: 1000, endMs: 1200 }])
    const after = editorReducer(back, { type: 'SILENCE_CONFIG_SET', config: { paddingMs: 200 } })
    expect(after.cutPlan).toBeNull()
    expect(after.silenceConfig.paddingMs).toBe(200)
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

describe('clip deletion', () => {
  it('removes the clip by id and clamps the playhead into the shrunken timeline', () => {
    const atEnd = editorReducer(stateWithClip(), { type: 'PLAYHEAD_SET', playheadMs: 2800 })
    const next = editorReducer(atEnd, { type: 'CLIP_DELETED', clipId: 'clip-2' })
    expect(next.clips).toHaveLength(1)
    expect(next.playheadMs).toBe(1000) // timeline shrank to 1000ms
  })
  it('keeps a playhead that still fits the remaining timeline', () => {
    const parked = editorReducer(stateWithClip(), { type: 'PLAYHEAD_SET', playheadMs: 800 })
    const next = editorReducer(parked, { type: 'CLIP_DELETED', clipId: 'clip-1' })
    expect(next.clips).toHaveLength(1)
    expect(next.playheadMs).toBe(800)
  })
  it('unknown clip id is a no-op (same state reference)', () => {
    const s = stateWithClip()
    expect(editorReducer(s, { type: 'CLIP_DELETED', clipId: 'nope' })).toBe(s)
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

describe('export settings + dialog state', () => {
  it('normalizes settings updates through the reducer', () => {
    const next = editorReducer(initialEditorState, {
      type: 'EXPORT_SETTINGS_SET',
      settings: { fps: 60, resolution: '720p', width: 1, height: 1 },
    })
    expect(next.exportSettings.fps).toBe(60)
    expect(next.exportSettings.width).toBe(720)
    expect(next.exportSettings.height).toBe(1280)
  })

  it('stores detailed status and only auto-opens the dialog for a fresh export', () => {
    const running = editorReducer(initialEditorState, {
      type: 'EXPORT_STATUS_SET',
      status: {
        phase: 'transcoding',
        detail: 'Rendering frames',
        stage: 'rendering',
        progress: 0.4,
        frame: 12,
        totalFrames: 30,
        etaMs: 1000,
        renderFps: 10,
        encodingSpeed: null,
        error: null,
      },
    })
    expect(running.exportStatus.stage).toBe('rendering')
    expect(running.exportStatus.progress).toBe(0.4)
    expect(running.exportDialogOpen).toBe(false)

    const initializing = editorReducer(running, {
      type: 'EXPORT_STATUS_SET',
      status: { ...running.exportStatus, stage: 'initializing' },
    })
    expect(initializing.exportDialogOpen).toBe(true)
  })

  it('refuses to close the dialog while the pipeline is busy', () => {
    const busy = editorReducer(initialEditorState, {
      type: 'EXPORT_STATUS_SET',
      status: { phase: 'transcoding', detail: 'Encoding', stage: 'encoding' },
    })
    const opened = editorReducer(busy, { type: 'EXPORT_DIALOG_SET', open: true })
    const attempt = editorReducer(opened, { type: 'EXPORT_DIALOG_SET', open: false })
    expect(attempt.exportDialogOpen).toBe(true)

    const done = editorReducer(opened, {
      type: 'EXPORT_STATUS_SET',
      status: { phase: null, detail: 'Export complete', stage: 'done' },
    })
    const closed = editorReducer(done, { type: 'EXPORT_DIALOG_SET', open: false })
    expect(closed.exportDialogOpen).toBe(false)
  })
})
