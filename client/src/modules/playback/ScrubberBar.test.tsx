import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ScrubberBar } from './ScrubberBar'

const seek = vi.fn()
const play = vi.fn()
const pause = vi.fn()

// ScrubberBar pulls transport + playhead from the editor context; inject a
// mutable stub so these tests isolate the component's own behavior.
const ctx: { stub: Record<string, unknown> } = { stub: {} }
vi.mock('../../app/state/EditorProvider', () => ({
  useEditor: () => ctx.stub,
}))

function oneClipTimeline(): Array<{ id: string; srcStartMs: number; srcEndMs: number }> {
  return [{ id: 'c1', srcStartMs: 0, srcEndMs: 1000 }]
}

function renderBar(state: { playing: boolean; playheadMs: number; clips: Array<{ srcEndMs: number }> }): { unmount: () => void } {
  ctx.stub = { seek, play, pause, state }
  return render(<ScrubberBar />)
}

function gripEl(): HTMLElement {
  return screen.getByLabelText('Move scan bar')
}

function barEl(): HTMLElement {
  return gripEl().closest('[data-scrubber-bar]') as HTMLElement
}

beforeEach(() => {
  seek.mockClear()
  play.mockClear()
  pause.mockClear()
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
    const slider = screen.getByRole('slider', { name: 'Scan timeline' })
    expect(slider).toHaveValue('0')

    fireEvent.change(slider, { target: { value: '1200' } }) // beyond the end clamps
    expect(seek).toHaveBeenCalledWith(1000)
    fireEvent.change(slider, { target: { value: '480' } })
    expect(seek).toHaveBeenCalledWith(480)
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
