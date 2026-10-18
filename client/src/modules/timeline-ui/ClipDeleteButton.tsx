import type { MouseEvent as ReactMouseEvent } from 'react'
import { useEditor } from '../../app/state/EditorProvider'

/**
 * Per-clip delete affordance rendered inside timeline clip blocks. Calls the
 * editor context's `deleteClip` (non-destructive reducer filter) and stops
 * propagation so selecting/seeking on the parent clip block stays intact.
 */
export function ClipDeleteButton({ clipId }: { clipId: string }) {
  const { deleteClip } = useEditor()

  const onClick = (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    deleteClip(clipId)
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Delete clip ${clipId}`}
      title="Delete this clip"
      className="absolute right-2 top-1/2 z-10 grid size-4 -translate-y-1/2 place-items-center rounded-full border border-zinc-600 bg-zinc-900/90 text-[9px] font-bold leading-none text-zinc-300 opacity-0 transition-[opacity,background-color] focus-visible:opacity-100 group-hover:opacity-100 hover:border-red-400 hover:bg-red-500/90 hover:text-white"
    >
      ×
    </button>
  )
}
