# Cut — Personal Web Video Editor

Local, browser-based video editor that jump-cuts silence, applies dynamic auto-zoom, animates PNG props, blurs the background behind props, places still images on the timeline, and exports video — all computed in your browser. See `PRD.md` for the full product requirements; fix history and performance measurements are in [`docs/`](./docs).

## Stack

- **MERN**: MongoDB + Express (server/), React + Node tooling (client/)
- TypeScript everywhere (strict), Tailwind for styling, modern React (function components + hooks)
- Browser engines per PRD: Web Audio API (analysis), HTML5 2D Canvas (compositing), FFmpeg.wasm (video export)
- Backend follows Domain-Driven Design (`server/src/contexts/*`), frontend follows feature modules (`client/src/modules/*`)

## Getting started

```powershell
npm install        # installs both workspaces
npm run dev        # Vite on :5173 (proxies /api), Express on :4000
```

Optional persistence: run `MONGO_URI=... npm run dev -w server` — otherwise projects are saved to an in-memory repository.

## Scripts

Run per workspace with `-w client` / `-w server`, or at the root for both:

| Script | What it does |
| --- | --- |
| `npm test` | vitest suites for both workspaces |
| `npm run typecheck` | strict tsc, no emit |
| `npm run lint` | ESLint (typescript-eslint + react-hooks) |
| `npm run build` | vite build / tsup |
| `npm run bench -w client` | export micro-benchmarks (prints a comparison table) |
| `npm start -w server` | run compiled server (after build) |

## How it works

1. **Import** a video or a still image (PNG/JPEG/WebP/GIF/AVIF/BMP) — drag & drop on the rail, preview, or timeline, or use the file picker. Video audio is decoded to a mono RMS envelope with a progress indicator. Images get a configurable default duration (3 s; 100 ms–10 min) and become normal timeline clips.
2. **Jump cut** — set silence threshold / min silence / padding; "Apply silence cut" highlights silent regions (red on the waveform) and rebuilds the timeline from the remaining speech, non-destructively. Double-click a clip to split, drag clip edges to trim "uh"/"um" leftovers.
3. **Auto-zoom** — one click alternates framing between adjacent clips (100% / 115%).
4. **Props** — import PNG overlays, drag & resize them on the preview, drag their in/out points on the prop track, pick a one-click motion preset (Pop & Bounce / Slide & Snap).
5. **Background blur** — global toggle; blurs the video while any prop is on screen.
6. **Export video** — composites the timeline (canvas + mixed audio) and encodes H.264/AAC or H.265 locally with FFmpeg.wasm; VP9/WebM is also available. Audio is mixed into one 48 kHz PCM track and muxed once, so cuts cannot accumulate A/V drift. A VP9/WebM export that contains an image clip preserves PNG transparency (`yuva420p`); MP4 codecs flatten alpha. The finished file downloads automatically.
7. **Playback** — the playhead is the single source of truth; Play always seeks to the parked frame before starting, Pause captures the exact instant, scrubbing pauses and resumes from the release point, and a cut never blanks the preview while the next frame is decoded. Review frame-by-frame (`,` / `.` or arrows), jog with `J` / `K` / `L`, and mark loop in/out with `I` / `O` (`P` toggles). See [`docs/playback-navigation.md`](./docs/playback-navigation.md) for the transport contract and manual test script.
8. **Save/Load project** — timeline, props, review position (playhead + loop), and settings are persisted as JSON to the Express API; media files always stay local.

## Layout

```
client/src/modules/   # feature modules: audio-analysis, timeline, auto-zoom,
                      # motion, props, compositor, export, media, preview,
                      # timeline-ui, media-rail, projects, shared
client/src/app/       # App shell + editor state (reducer + provider)
server/src/contexts/  # DDD contexts (projects: domain/application/infrastructure/interface)
docs/                 # fix report + playback navigation + export performance
```
