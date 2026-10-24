# Fix report — cuts, A/V sync, transport, export speed, image media

This document records the root cause, implementation, and regression coverage for the five issues in `fix.txt`. Performance measurements live in [`export-performance.md`](./export-performance.md).

All work is local-only browser code; no server or database behavior changed.

## 1. Black flash between adjacent clips

**Root cause**

`drawFrame()` unconditionally called `clearRect()` before drawing. When the playhead crossed a cut, the single preview `<video>` needed a seek to the next clip's source instant. For one or more animation frames `readyState < 2` (or the element still held the previous source), so the compositor had cleared the canvas but had no decoded frame to paint — a black flash. The old transport also hopped `<video>.src` and set `currentTime` while allowing the playhead to advance from the stale element, so a cut could render an instant from the previous clip and then a blank frame.

**Fix**

- `CompositorSettings.holdLastFrame` (preview only): when the clip under the playhead exists but the video source is not decoded, `drawFrame()` returns before `clearRect()`, leaving the previous good frame on screen. It resumes drawing as soon as the seek lands.
- The preview loop resolves media by the clip's source URL and `kind`; a not-ready or mismatched element is passed as `null`, which triggers the hold path instead of a blank frame.
- Export never holds a stale frame: `FrameRenderer` throws `ASSET_LOAD_FAILED` if a source has no decoded frame, and `NO_CLIPS` if no clip covers an output frame. Silent black frames cannot be encoded.
- `planClips()` skips zero-length `[srcStart, srcEnd)` windows, so a malformed cut cannot insert an empty instant into the plan.
- `planTransport()` treats the timeline end as exclusive and maps a cut boundary to the first instant of the following clip; `previewPlayheadMs()` keeps the sampled time inside the last frame.
- Frame accuracy is unchanged: clip placement remains `srcStartMs + (timelineMs - clipStartMs)`, sampled at `frameIndex / fps * 1000`; no frame is skipped or duplicated at boundaries.

**Regression tests**

- `client/src/modules/playback/engine.test.ts` — cut-boundary mapping, next-clip advance, seeking hold, end-of-timeline finish.
- `client/src/modules/compositor/engine.test.ts` — hold without clear, normal draw with hold enabled, balanced save/restore.
- `client/src/modules/export/pipeline/timelinePlan.test.ts` — zero-span skip, binary placement matches linear mapping around every boundary.

## 2. Exported audio drifts out of sync

**Root cause**

Every render chunk was encoded as a standalone A/V segment: its own WAV was written, then its own AAC/Opus stream was encoded, and the encoded segments were concatenated. Each audio encode carries encoder priming/padding (AAC encoder delay, Opus pre-skip). Repeating that delay once per chunk produced increasing lip-sync error over the export. Chunk audio lengths were also derived by rounding milliseconds per chunk, so boundary rounding accumulated.

**Fix**

- Video-only chunk encoding: `encodeChunk()` now takes no audio and the segment arguments always include `-an`.
- One continuous 16-bit mono 48 kHz PCM track is allocated once for the exact output frame count (`pcm16ByteLength(exportAudioSampleCount(totalFrames, fps, 48000))`).
- Each chunk's mix is written into that buffer at an **absolute** sample/byte offset (`planAudioPcmChunks` + `mixAudioChunk({ startSample, lengthSamples })`). Every boundary comes from `round(frame / fps * 48000)` independently, never from accumulated chunk durations.
- The mixer derives timeline time from the absolute output sample index, not the local chunk index, so a source resumes exactly where the previous chunk stopped (including 44.1 kHz sources resampled to 48 kHz).
- The final concat pass copies the video streams losslessly and encodes the PCM once (`-f s16le -ar 48000 -ac 1`), with AAC for MP4 or Opus for WebM, `-shortest`, and `+faststart` for MP4. Encoder priming therefore exists once at the start, not once per chunk.
- Image assets are excluded from audio decoding and audio segments.
- `ExportResult.durationMs` now reports the encoded frame-grid duration (`totalFrames / fps`), not the raw timeline duration.

**Regression tests**

- `client/src/modules/export/audio/mixer.test.ts` — boundary continuity, absolute output time, mid-chunk source offsets, explicit `lengthSamples`, gapless long runs.
- `client/src/modules/export/audio/pcm.test.ts` — absolute frame-to-sample mapping, non-accumulating boundaries over 100 irregular frames, preallocated writes, clamping.
- `client/src/modules/export/pipeline/timelinePlan.test.ts` — PCM chunk offsets on the frame grid and a ten-minute export with no accumulated rounding.
- `client/src/modules/export/encoding/args.test.ts` — video-only segments, one PCM track, AAC/Opus final mux, silent timelines.
- `client/src/modules/export/pipeline/exportPipeline.test.ts` — one buffer written at absolute offsets, one concat/mux, correct audio bytes.

**Remaining risk**

Container-level priming still exists once per file, as it does in any encoder; that is a constant, not cumulative. The final number should be validated on real devices with the manual browser check in the performance report.

## 3. Playback starts from the wrong position

**Root cause**

The playhead had two writers: reducer actions and the rAF loop, which overwrote it from `video.currentTime` whenever it believed the element was inside a clip. Starting playback did not first seek the element to the playhead; pausing only called `video.pause()` and left the reducer playhead at the last update; `ended` reset the playhead to `0`; and source hops changed the element independently of the playhead. Stale element time could therefore win over the user's chosen position.

**Fix**

- `client/src/modules/playback/engine.ts` defines `planTransport()`: a pure, unit-tested decision (`hold`, `pause-video`, `seek-video`, `play-video`, `advance`, `finish`). The reducer's `playheadMs` is the single source of truth; the element is always slaved to it.
- Before playing, if the element URL is wrong, is not ready, or sits more than `PAUSED_SEEK_TOLERANCE_MS` (2 ms) from the mapped source instant, the plan seeks the element to the playhead. Playback starts only once the element is in place.
- During playback the media clock may update the playhead only while it is within `VIDEO_SYNC_TOLERANCE_MS` (60 ms); otherwise the element is corrected. This removes drift from stale ticks while preserving smooth playback.
- `pause()` captures the exact video instant only when the element is on the same source, inside the clip, and near the planned instant; otherwise the reducer playhead is kept. Resume uses that playhead verbatim.
- `ended` parks the playhead at the timeline end instead of resetting to zero. `play()` restarts at zero only when already parked at the end; otherwise it resumes at the current playhead.
- Image clips use the same authoritative playhead but advance on wall-clock delta, with no media element.

**Regression tests**

- `client/src/modules/playback/engine.test.ts` — empty timeline, stale element seek, source change, exact start, wrong paused frame, resume after pause, media-clock sync window, cut boundary, clip end, timeline end, seek hold, image advance/stop/finish.
- `client/src/modules/playback/engine.test.ts` also covers `previewPlayheadMs` clamping at end/negative/empty values.

**Remaining risk**

Cross-source cuts still require an actual browser seek, so a slow decoder can show the held frame for a few frames. This is intentional and no longer a black flash. Browser autoplay policy requires Play to originate from a user gesture (it does).

## 4. Export performance

Full analysis and measured numbers: [`export-performance.md`](./export-performance.md). Summary of changes:

- Binary search (`placementAt`) replaces the per-frame linear clip scan (measured ~8–9× faster over 400 clips).
- A low-resolution pre-blurred backdrop replaces a full-size `ctx.filter = 'blur(20px)'` draw for letterboxed frames (measured 2.2× faster in headless Chrome: ~24.6/22.0 ms → ~11.4/10.1 ms per frame).
- Audio is mixed once into a preallocated PCM buffer and encoded once in the final mux (previously one WAV + one audio encode per chunk).
- Frame writes overlap up to `MAX_PENDING_WRITES = 4` instead of serializing every `writeFrame` round-trip.
- MEMFS frame/segment deletion is batched 32 files at a time.
- Timeline images are decoded once per source and reused by all clips.
- Per-chunk logs now report render time, audio-mix time, encode time, segment size, and heap usage; the final mux is timed separately.

Quality is unchanged: JPEG intermediate quality and encoder settings are untouched, audio is 16-bit 48 kHz mono, and the final video is stream-copied. Alpha exports deliberately use slower PNG frames only when VP9 transparency is requested.

## 5. PNG images on the timeline

**Root cause**

The entire media path assumed video: the file picker accepted only `video/*`, drop filters required video MIME, `VideoSource` had no kind, the timeline only appended clips for video imports, the asset list was hidden with fewer than two videos and had no draggable rows, and export decoded every source with a `<video>` element and encoded JPEG/yuv420p. There was no duration model for stills and no alpha-preserving export path.

**Fix**

- `MediaKind = 'video' | 'image'` and `mediaKindOf()` accept PNG/JPEG/WebP/GIF/AVIF/BMP; SVG is rejected because it would taint the export canvas. Filename extension is used only when the OS omits the MIME type (common on Windows).
- `importMedia()` handles both kinds. Images are decoded once into a preview cache, then appended as a full-length clip with `srcStartMs = 0`, `srcEndMs = durationMs`, default 3 s, clamped to 100 ms–10 min. A per-asset duration input updates full-length clips; split/trimmed image clips are clamped to the new length.
- `MediaRail` asset rows are draggable (`MEDIA_DRAG_MIME`, with `text/plain` fallback). `TimelinePanel` accepts both asset drags and OS file drops, highlights the drop target, and creates clips through the same reducer path as the append button.
- Preview resolves image clips from the decoded image cache and composites them through the same canvas/props/blur pipeline. Images are labelled `IMG` in the rail, source row, and timeline.
- Export `VideoPool.resolve()` returns a decoded `<img>` for image sources and caches it per asset; image clips never seek and never contribute audio.
- Alpha output is enabled only for VP9/WebM timelines containing an image clip: PNG intermediate frames, `yuva420p`, `-auto-alt-ref 0`, no blurred backdrop, and `preserveAlpha` keeps letterbox areas transparent. H.264/H.265 cannot carry alpha and flatten transparent pixels to the normal backdrop/black.
- Image clips respect trimming, splitting, auto-zoom, props, blur, and timeline save/load like video clips.

**Regression tests**

- `client/src/modules/media/engine.test.ts` — image MIME/extension classification, SVG rejection, Windows extension fallback, octet-stream video.
- `client/src/modules/media/drag.test.ts` — private drag MIME, whitespace handling, OS file distinction, browsers rejecting `text/plain`.
- `client/src/app/state/editor.test.ts` — image import/clip lifecycle, default and normalized durations, full-length vs split clip updates, playhead clamping, mixed video/image timelines.
- `client/src/modules/export/pipeline/timelinePlan.test.ts` — alpha plan only for VP9 + image clips, image audio exclusion.
- `client/src/modules/export/pipeline/exportPipeline.test.ts` — PNG alpha requested for VP9 only; MP4 flattens alpha.
- `client/src/modules/compositor/engine.test.ts` — transparent letterbox for alpha exports, backdrop suppression.
- `client/src/modules/export/encoding/args.test.ts` — PNG pattern and `yuva420p` flags.

**Remaining risks**

- VP9 alpha support depends on the playback/editor application; H.264/H.265 exports intentionally flatten it.
- Animated GIF/WebP is treated as a single still frame.
- Very large stills are decoded at native size; memory use scales with image dimensions, not export dimensions.
- Object URLs remain owned by the editor for the session; projects persist metadata, not browser-local media.

## Files modified

Backend: none.

Client application/state:

- `client/src/app/App.tsx`
- `client/src/app/state/editor.ts`
- `client/src/app/state/EditorProvider.tsx`
- `client/src/modules/media-rail/MediaRail.tsx`
- `client/src/modules/timeline-ui/TimelinePanel.tsx`
- `client/src/modules/preview/PreviewStage.tsx`
- `client/src/modules/export/ui/ExportDialog.tsx`

Engines and rendering:

- `client/src/modules/playback/engine.ts`
- `client/src/modules/compositor/engine.ts`
- `client/src/modules/compositor/backdrop.ts` (new)
- `client/src/modules/media/engine.ts`
- `client/src/modules/media/drag.ts` (new)
- `client/src/modules/export/types.ts`
- `client/src/modules/export/renderer/frameRenderer.ts`
- `client/src/modules/export/renderer/videoPool.ts`
- `client/src/modules/export/renderer/assets.ts`
- `client/src/modules/export/renderer/surface.ts`
- `client/src/modules/export/pipeline/exportPipeline.ts`
- `client/src/modules/export/pipeline/timelinePlan.ts`
- `client/src/modules/export/pipeline/defaultDependencies.ts`
- `client/src/modules/export/audio/mixer.ts`
- `client/src/modules/export/audio/pcm.ts` (new)
- `client/src/modules/export/encoding/args.ts`
- `client/src/modules/export/encoding/ffmpegEncoder.ts`
- `client/src/modules/export/encoding/ffmpegSession.ts`
- `client/src/modules/export/workers/canvasToJpeg.ts`
- `client/src/modules/export/workers/frameEncodeCore.ts`
- `client/src/modules/export/workers/frameEncoder.worker.ts`
- `client/src/modules/export/workers/frameEncoderClient.ts`
- `client/src/modules/export/workers/frameEncoderProtocol.ts`

Tooling/docs:

- `client/package.json` (`bench` script)
- `client/src/modules/export/pipeline/timelinePlan.bench.ts` (new)
- `README.md`
- `docs/fixes.md`, `docs/export-performance.md`

## Verification

- `npm run test -w client` — 28 files, 281 tests passing.
- `npm run typecheck` — both workspaces pass.
- `npm run lint` — clean.
- `npm run build -w client` and `npm run build -w server` — pass.
- `npm run bench -w client` — placement benchmark passes and prints the comparison table.
- Headless Chrome 156 canvas benchmark — letterboxed backdrop 2.16–2.18× faster than the old full-size blur.

No real-media browser export was available in the automated environment; see the manual validation procedure and remaining risk in `docs/export-performance.md`.
