import { PanelSection } from '../modules/shared/ui/PanelSection'

/**
 * App shell — dark editor layout.
 * Desktop: left tool rail (72) + preview + bottom timeline (64).
 * Mobile: single column stacked (media > preview > timeline).
 */
export default function App() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <span className="rounded size-2.5 bg-accent" aria-hidden />
          Cut
        </div>
        <div className="flex items-center gap-2 text-xs font-medium">
          <button
            type="button"
            className="rounded-lg border border-line px-3 py-1.5 transition-colors hover:bg-zinc-800/70"
            // wired by the export module in a later phase
          >
            Save project
          </button>
          <button
            type="button"
            className="rounded-lg bg-accent px-3 py-1.5 transition-opacity hover:opacity-90"
            // wired by the export module in a later phase
          >
            Export MP4
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="w-full min-w-0 shrink-0 space-y-5 overflow-y-auto border-b border-line p-3 lg:w-72 lg:border-b-0 lg:border-r">
          <PanelSection title="Media">
            <div className="rounded-xl border border-dashed border-line p-4 text-center text-xs text-zinc-500">
              Drag &amp; drop a video file here
            </div>
          </PanelSection>
          <PanelSection title="Controls">
            <div className="text-xs text-zinc-600">Silence controls appear after importing a video.</div>
          </PanelSection>
          <PanelSection title="Props">
            <div className="text-xs text-zinc-600">PNG overlays appear here.</div>
          </PanelSection>
        </aside>

        <main className="flex min-h-0 flex-1 flex-col">
          <section className="grid min-h-0 flex-1 place-items-center p-4">
            <div className="aspect-video max-h-full w-full max-w-4xl overflow-hidden rounded-xl border border-line bg-black">
              {/* preview compositor renders here */}
            </div>
          </section>
          <section className="h-64 shrink-0 border-t border-line p-3 lg:h-72">
            {/* waveform + clip track + prop track render here */}
            <p className="text-center text-xs text-zinc-600">Timeline</p>
          </section>
        </main>
      </div>
    </div>
  )
}
