import { useEffect, useState } from 'react'
import { EditorProvider, useEditor } from './state/EditorProvider'
import type { SavedProjectSummary } from '../modules/projects/api'
import { MediaRail } from '../modules/media-rail/MediaRail'
import { PreviewStage } from '../modules/preview/PreviewStage'
import { TimelinePanel } from '../modules/timeline-ui/TimelinePanel'
import { ScrubberBar } from '../modules/playback/ScrubberBar'

/** Header actions + inline host for the load-project popover. */
function Toolbar() {
  const { state, saveProject, fetchProjectList, applySavedProject, exportToMp4 } = useEditor()
  const [projects, setProjects] = useState<SavedProjectSummary[] | null>(null)
  const hasMedia = state.project !== null
  const busy = state.exportStatus.phase !== null

  return (
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
      <div className="flex items-center gap-2 text-sm font-semibold tracking-tight">
        <span className="rounded size-2.5 bg-accent" aria-hidden />
        Cut
        {state.project !== null && <span className="max-w-40 truncate text-xs font-normal text-zinc-500">{state.project.fileName}</span>}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
        {state.exportStatus.phase !== null && <span className="animate-pulse text-accent">{state.exportStatus.detail}</span>}
        <button
          type="button"
          onClick={async () => setProjects(await fetchProjectList())}
          className="rounded-lg border border-line px-3 py-1.5 transition-colors hover:bg-zinc-800/70"
        >
          Load project
        </button>
        <button
          type="button"
          onClick={() => void saveProject()}
          disabled={!hasMedia}
          className="rounded-lg border border-line px-3 py-1.5 transition-colors hover:bg-zinc-800/70 disabled:opacity-40"
        >
          Save project
        </button>
        <button
          type="button"
          onClick={() => void exportToMp4()}
          disabled={!hasMedia || busy}
          className="rounded-lg bg-accent px-3 py-1.5 transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Export MP4
        </button>
      </div>

      {projects !== null && (
        <div className="absolute inset-x-0 top-full z-10 mx-auto mt-1 w-full max-w-md rounded-xl border border-line bg-zinc-900 p-3 shadow-xl">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>Saved projects</span>
            <button type="button" className="text-zinc-500 hover:text-zinc-200" onClick={() => setProjects(null)}>
              close ×
            </button>
          </div>
          {projects.length === 0 ? (
            <p className="py-4 text-center text-xs text-zinc-600">Nothing saved yet</p>
          ) : (
            <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => {
                      void applySavedProject(p.id)
                      setProjects(null)
                    }}
                    className="flex w-full items-center justify-between rounded-lg border border-line px-3 py-2 text-left text-xs text-zinc-200 transition-colors hover:bg-zinc-800/60"
                  >
                    <span className="truncate">{p.name}</span>
                    <span className="shrink-0 pl-3 tabular-nums text-zinc-500">{new Date(p.updatedAt).toLocaleString()}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </header>
  )
}

function EditorShell() {
  const { message } = useEditor()
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (message === '') return
    setToast(message)
    const id = window.setTimeout(() => setToast(null), 4000)
    return () => window.clearTimeout(id)
  }, [message])

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <Toolbar />

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <MediaRail />
        <main className="flex min-h-0 flex-1 flex-col">
          <PreviewStage />
          <TimelinePanel />
        </main>
      </div>

      {toast && (
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-lg border border-line bg-zinc-900 px-4 py-2 text-xs text-zinc-200 shadow-xl">
          {toast}
        </div>
      )}

      {/* Floating scan bar — user-draggable, parks anywhere over the editor */}
      <ScrubberBar />
    </div>
  )
}

export default function App() {
  return (
    <EditorProvider>
      <EditorShell />
    </EditorProvider>
  )
}
