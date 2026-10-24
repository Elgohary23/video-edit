import { describe, expect, it } from 'vitest'
import { MEDIA_DRAG_MIME, isMediaDrag, readMediaDragId, setMediaDragData, type DragDataLike } from './drag'

/** Minimal DataTransfer stand-in that stores formats in a Map. */
function dragData(options: { failPlainText?: boolean } = {}): DragDataLike & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    get types() {
      return [...values.keys()]
    },
    getData: (type) => values.get(type) ?? '',
    setData: (type, value) => {
      if (options.failPlainText && type === 'text/plain') throw new Error('format not supported')
      values.set(type, value)
    },
  }
}

describe('media drag helpers', () => {
  it('writes the private asset id so the timeline can tell it from an OS file drop', () => {
    const data = dragData()
    setMediaDragData(data, 'asset-7')
    expect(data.values.get(MEDIA_DRAG_MIME)).toBe('asset-7')
    expect(data.values.get('text/plain')).toBe('asset-7')
    expect(isMediaDrag(data)).toBe(true)
  })

  it('reads the dragged asset id (empty payload is not a valid drag)', () => {
    const data = dragData()
    setMediaDragData(data, '  asset-9  ')
    expect(readMediaDragId(data)).toBe('asset-9')

    const empty = dragData()
    empty.values.set(MEDIA_DRAG_MIME, '   ')
    expect(readMediaDragId(empty)).toBeNull()
  })

  it('ignores OS file drags and unrelated drag types', () => {
    const files = dragData()
    files.values.set('Files', 'placeholder')
    expect(isMediaDrag(files)).toBe(false)
    expect(readMediaDragId(files)).toBeNull()

    const text = dragData()
    text.values.set('text/plain', 'asset-1')
    expect(readMediaDragId(text)).toBeNull()
  })

  it('still sets the private type when a browser rejects text/plain', () => {
    const data = dragData({ failPlainText: true })
    expect(() => setMediaDragData(data, 'asset-3')).not.toThrow()
    expect(data.values.get(MEDIA_DRAG_MIME)).toBe('asset-3')
    expect(readMediaDragId(data)).toBe('asset-3')
  })
})
