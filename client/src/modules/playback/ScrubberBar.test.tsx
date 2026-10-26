import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ScrubberBar } from './ScrubberBar'

const seek = vi.fn()
const play = vi.fn()
const pause = vi.fn()
const beginScrub = vi.fn()
const endScrub = vi.fn()
const stepFrames = vi.fn()
const toggleLoop = vi.fn()
const clearLoop = vi.fn()

// ScrubberBar pulls transport + playhead from the editor context; inject a
// mutable stub so these tests isolate the component's own behavior.
const ctx: { stub: Record<string, unknown> } = { stub: {} }
vi.mock('../../app/state/EditorProvider', () => ({
  useEditor: () => ctx.stub,
}))

interface StubState {
  playing: boolean
  playheadMs: number
  clips: Array<{ id?: string; srcStartMs?: number; srcEndMs: number }>
  loopRegion?: { startMs: number; endMs: number } | null
  loopEnabled?: boolean
}

function oneClipTimeline(): Array<{ id: string; srcStartMs: number; srcEndMs: number }> {
  return [{ id: 'c1', srcStartMs: 0, srcEndMs: 1000 }]
}

function renderBar(state: StubState): ReturnType<typeof render> {
  ctx.stub = {
    seek,
    play,
    pause,
    beginScrub,
    endScrub,
    stepFrames,
    toggleLoop,
    clearLoop,
    state: { loopRegion: null, loopEnabled: false, ...state },
  }
  return render(<ScrubberBar />)
}

function gripEl(): HTMLElement {
  return screen.getByLabelText('Move scan bar')
}

function barEl(): HTMLElement {
  return gripEl().closest('[data-scrubber-bar]') as HTMLElement
}

function sliderEl(): HTMLInputElement {
  return screen.getByRole('slider', { name: 'Scan timeline' }) as HTMLInputElement
}

beforeEach(() => {
  seek.mockClear()
  play.mockClear()
  pause.mockClear()
  beginScrub.mockClear()
  endScrub.mockClear()
  stepFrames.mockClear()
  toggleLoop.mockClear()
  clearLoop.mockClear()
})

describe('ScrubberBar', () => {
  it('shows the empty state and disables transport without a timeline', () => {
    renderBar({ playing: false, playheadMs: 0, clips: [] })
    expect(barEl()).toHaveTextContent('No timeline')
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    expect(screen.queryByRole('slider', { name: 'Scan timeline' })).toBeNull()
  })

  it('scrubs: moving the slider seeks to the clamped position', () => {
    renderBar({ playing: false, playheadMs: 0, clips: oneClipTimeline() })
    expect(sliderEl()).toHaveValue('0')

    fireEvent.change(sliderEl(), { target: { value: '1200' } }) // beyond the end clamps
    expect(seek).toHaveBeenCalledWith(1000)
    fireEvent.change(sliderEl(), { target: { value: '480' } })
    expect(seek).toHaveBeenCalledWith(480)
  })

  it('owns the thumb during drag and resumes from the release frame', () => {
    const view = renderBar({ playing: true, playheadMs: 100, clips: oneClipTimeline() })

    fireEvent.pointerDown(sliderEl(), { button: 0 })
    expect(beginScrub).toHaveBeenCalledTimes(1)
    fireEvent.change(sliderEl(), { target: { value: '400' } })
    expect(seek).toHaveBeenLastCalledWith(400)

    // The rAF writer dispatches a new playhead while the pointer is down; the
    // local draft must keep the thumb exactly where the hand put it.
    ctx.stub = { ...ctx.stub, state: { ...(ctx.stub.state as StubState), playheadMs: 650 } }
    view.rerender(<ScrubberBar />)
    expect(sliderEl()).toHaveValue('400')
    expect(barEl()).toHaveAttribute('data-scrubbing', 'true')

    fireEvent.pointerUp(sliderEl())
    expect(endScrub).toHaveBeenCalledTimes(1)
    expect(play).toHaveBeenCalledWith(400)
  })

  it('stays paused when Alt is held on release', () => {
    renderBar({ playing: true, playheadMs: 100, clips: oneClipTimeline() })
    fireEvent.pointerDown(sliderEl(), { button: 0 })
    fireEvent.change(sliderEl(), { target: { value: '250' } })
    fireEvent.pointerUp(sliderEl(), { altKey: true })

    expect(endScrub).toHaveBeenCalledTimes(1)
    expect(play).not.toHaveBeenCalled()
  })

  it('does not auto-play a scrub that started while paused', () => {
    renderBar({ playing: false, playheadMs: 100, clips: oneClipTimeline() })
    fireEvent.pointerDown(sliderEl(), { button: 0 })
    fireEvent.change(sliderEl(), { target: { value: '250' } })
    fireEvent.pointerUp(sliderEl())

    expect(endScrub).toHaveBeenCalledTimes(1)
    expect(play).not.toHaveBeenCalled()
  })

  it('plays from the scrub position, then pauses while playing', () => {
    const first = renderBar({ playing: false, playheadMs: 250, clips: oneClipTimeline() })
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(play).toHaveBeenCalledTimes(1)
    expect(pause).not.toHaveBeenCalled()
    first.unmount()

    renderBar({ playing: true, playheadMs: 250, clips: oneClipTimeline() })
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(pause).toHaveBeenCalledTimes(1)
  })

  it('steps one frame with the visible step buttons', () => {
    renderBar({ playing: false, playheadMs: 250, clips: oneClipTimeline() })
    fireEvent.click(screen.getByRole('button', { name: 'Step back one frame' }))
    fireEvent.click(screen.getByRole('button', { name: 'Step forward one frame' }))
    expect(stepFrames).toHaveBeenNthCalledWith(1, -1)
    expect(stepFrames).toHaveBeenNthCalledWith(2, 1)
  })

  it('toggles and clears a marked loop region', () => {
    renderBar({
      playing: false,
      playheadMs: 2000,
      clips: [{ id: 'c1', srcStartMs: 0, srcEndMs: 5000 }],
      loopRegion: { startMs: 2000, endMs: 4000 },
      loopEnabled: false,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Enable loop playback' }))
    expect(toggleLoop).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Clear loop region' }))
    expect(clearLoop).toHaveBeenCalledTimes(1)
  })

  it('the grip parks it anywhere: dragging repaints fixed px coordinates', () => {
    renderBar({ playing: false, playheadMs: 0, clips: oneClipTimeline() })
    expect(barEl().style.left).toBe('')

    fireEvent.pointerDown(gripEl(), { button: 0, clientX: 500, clientY: 500 })
    fireEvent.pointerMove(gripEl(), { clientX: 300, clientY: 200 })
    fireEvent.pointerUp(gripEl())

    expect(barEl().style.left).not.toBe('')
    expect(barEl().style.top).not.toBe('')
    // slider keeps working after a reposition
    fireEvent.change(screen.getByRole('slider', { name: 'Scan timeline' }), { target: { value: '200' } })
    expect(seek).toHaveBeenLastCalledWith(200)
  })
})
