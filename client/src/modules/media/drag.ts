/**
 * Media-rail → timeline drag payload.
 *
 * Files dragged from the OS already carry `Files`; dragging an *asset row*
 * needs a stable, private MIME type so the timeline can distinguish it from
 * an OS file drop without relying on fragile DOM dataset lookups.
 */
export const MEDIA_DRAG_MIME = 'application/x-cut-media-id'

/** Minimal DataTransfer surface, which keeps the helpers unit-testable. */
export interface DragDataLike {
  readonly types: readonly string[] | DOMStringList
  getData(type: string): string
  setData(type: string, value: string): void
}

export function setMediaDragData(data: DragDataLike, assetId: string): void {
  data.setData(MEDIA_DRAG_MIME, assetId)
  try {
    data.setData('text/plain', assetId)
  } catch {
    // Some browsers reject secondary formats; the private type is enough.
  }
}

/** Types are readable during `dragover`; payload data is not. */
export function isMediaDrag(data: Pick<DragDataLike, 'types'>): boolean {
  return Array.from(data.types).includes(MEDIA_DRAG_MIME)
}

export function readMediaDragId(data: DragDataLike): string | null {
  if (!isMediaDrag(data)) return null
  const id = data.getData(MEDIA_DRAG_MIME).trim()
  return id.length > 0 ? id : null
}
