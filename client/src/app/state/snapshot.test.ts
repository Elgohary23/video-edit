import { describe, expect, it } from 'vitest'
import { editorReducer, initialEditorState, type EditorState } from './editor'
import { parseSnapshot, serializeSnapshot } from './snapshot'

function stateWithLoop(): EditorState {
  let s = editorReducer(initialEditorState, {
    type: 'VIDEO_ADDED',
    id: 'v1',
    fileName: 'take.mp4',
    videoUrl: 'blob:take',
    durationMs: 5000,
  })
  s = editorReducer(s, { type: 'PLAYHEAD_SET', playheadMs: 2000 })
  s = editorReducer(s, { type: 'LOOP_IN_SET' })
  s = editorReducer(s, { type: 'PLAYHEAD_SET', playheadMs: 4000 })
  s = editorReducer(s, { type: 'LOOP_OUT_SET' })
  return editorReducer(s, { type: 'PLAYHEAD_SET', playheadMs: 2750 })
}

describe('project snapshot review state', () => {
  it('round-trips the parked playhead and loop region', () => {
    const s = stateWithLoop()
    const payload = serializeSnapshot(s)
    expect(payload.version).toBe(2)
    expect(payload.playheadMs).toBe(2750)

    const parsed = parseSnapshot(payload)
    expect(parsed?.playheadMs).toBe(2750)
    expect(parsed?.loopRegion).toEqual({ startMs: 2000, endMs: 4000 })
    expect(parsed?.loopEnabled).toBe(true)
  })

  it('loads version-1 payloads at the start with looping off', () => {
    const legacy = {
      version: 1,
      clips: [{ id: 'c1', srcStartMs: 0, srcEndMs: 1000, zoom: 1 }],
      props: [],
    }
    const parsed = parseSnapshot(legacy)
    expect(parsed?.playheadMs).toBe(0)
    expect(parsed?.loopRegion).toBeNull()
    expect(parsed?.loopEnabled).toBe(false)
    expect(parsed?.silenceConfig.thresholdDb).toBe(-35)
  })

  it('rejects malformed loop JSON and clamps stale positions to the saved clips', () => {
    const parsed = parseSnapshot({
      clips: [{ id: 'c1', srcStartMs: 0, srcEndMs: 1000, zoom: 1 }],
      props: [],
      playheadMs: 50_000,
      loopRegion: { startMs: 'nope', endMs: 400 } as unknown as { startMs: number; endMs: number },
      loopEnabled: true,
    })
    expect(parsed?.playheadMs).toBe(1000)
    expect(parsed?.loopRegion).toBeNull()
    expect(parsed?.loopEnabled).toBe(false)
  })

  it('clamps a saved loop that reaches past the current timeline', () => {
    const parsed = parseSnapshot({
      clips: [{ id: 'c1', srcStartMs: 0, srcEndMs: 1000, zoom: 1 }],
      props: [],
      playheadMs: 900,
      loopRegion: { startMs: -100, endMs: 3000 },
      loopEnabled: true,
    })
    expect(parsed?.loopRegion).toEqual({ startMs: 0, endMs: 1000 })
    expect(parsed?.loopEnabled).toBe(true)
  })

  it('returns null for unreadable payloads', () => {
    expect(parseSnapshot({ props: [] })).toBeNull()
    expect(parseSnapshot({ clips: [] } as never)).toBeNull()
  })
})
