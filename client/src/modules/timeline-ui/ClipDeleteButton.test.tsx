import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClipDeleteButton } from './ClipDeleteButton'

const deleteClip = vi.fn()

// The button performs its mutation through the editor context; inject a stub.
const ctx: { stub: Record<string, unknown> } = { stub: {} }
vi.mock('../../app/state/EditorProvider', () => ({
  useEditor: () => ctx.stub,
}))

beforeEach(() => {
  deleteClip.mockClear()
  ctx.stub = { deleteClip }
})

describe('ClipDeleteButton', () => {
  it('labels itself for the clip it removes and calls deleteClip on click', () => {
    render(<ClipDeleteButton clipId="clip-2" />)
    const button = screen.getByRole('button', { name: 'Delete clip clip-2' })
    expect(button).toBeInTheDocument()
    fireEvent.click(button)
    expect(deleteClip).toHaveBeenCalledTimes(1)
    expect(deleteClip).toHaveBeenCalledWith('clip-2')
  })

  it('stops propagation so the parent clip block does not seek', () => {
    const parentClick = vi.fn()
    render(
      <div onClick={parentClick}>
        <ClipDeleteButton clipId="c1" />
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete clip c1' }))
    expect(deleteClip).toHaveBeenCalledTimes(1)
    expect(parentClick).not.toHaveBeenCalled()
  })
})
