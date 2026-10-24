# Export performance report

This report covers the export-pipeline optimization work for issue 4 in `fix.txt`. It separates **measured Node micro-benchmarks**, a **measured browser canvas component benchmark**, **deterministic work reductions**, and **full browser end-to-end timings**, which cannot be captured by the jsdom test environment.

## Environment

- Date: 2026-10-24
- OS: Windows (win32)
- CPU: AMD Ryzen 5 PRO 3500U (4 cores / 8 threads, 2.1–3.7 GHz)
- RAM: 13.9 GB usable
- Node: v24.20.0
- Vitest: 5.0.5
- Command: `npm run bench -w client` (`vitest bench --run --reporter=verbose`)

## Bottlenecks found

1. **Per-frame linear clip lookup.** The exporter scanned every planned clip for every output frame. A 10-minute 30 fps export is 18,000 frames; a 400-clip timeline meant ~7.2 million comparisons, all on the render hot path.
2. **Full-canvas blur for letterboxed video.** Whenever a source did not fill the frame, the compositor drew the full-size source with `ctx.filter = 'blur(20px)'` before drawing the actual frame. Canvas2D blur is a full-frame convolution; doing it 18,000 times dominates software-rendered exports.
3. **Audio encoded once per chunk.** Every render chunk wrote a stereo WAV, encoded its own AAC/Opus stream, and was concatenated. Besides causing drift (see `fixes.md` §2), this multiplied audio encoder work, MEMFS writes, and mux overhead by the chunk count: 100 chunks = 100 audio encodes for a 10-minute 1080p30 export.
4. **Serialized frame writes.** `await encoder.writeFrame(...)` crossed the worker/MEMFS boundary for every frame and blocked rendering until it finished.
5. **Serialized file deletion.** Every JPEG frame and segment was deleted with an individual awaited FFmpeg worker call: ~18,100 round-trips for the same 10-minute export.
6. **Repeated image decoding.** Still images were not part of the export pool, so every image clip would have needed its own decode path.
7. **No stage timings.** The old logs reported only chunk encode time, which hid whether rendering, audio, I/O, or encoding was slow.

## Changes implemented

- `placementAt()` now binary-searches the precomputed, sorted `PlannedClip[]` (`timelinePlan.ts`). Zero-length clips are removed first so the sorted assumption always holds.
- `createBackdropRenderer()` (`compositor/backdrop.ts`) keeps a 1/8-size scratch canvas, draws the source at that size with `blur(1.5px)`, then the compositor upscales it and applies a dark overlay. The old full-size blur path remains only as a fallback when no backdrop canvas is available (e.g. tests).
- Export audio is one preallocated mono 16-bit 48 kHz buffer. Chunks mix into absolute sample offsets; the final mux encodes audio once. This removes **99 of 100** audio encodes and WAV writes on a 10-minute 1080p30 export.
- Frame writes overlap up to `MAX_PENDING_WRITES = 4`; errors are still awaited and re-thrown before the chunk encode starts.
- `discardChunk()`, `concat()`, and `FFmpegSession.cleanup()` delete MEMFS files in batches of 32 instead of one at a time.
- `VideoPool.resolve()` caches one decoded `<img>` per image source and shares it across all clips of that asset.
- Chunk logs now include render, audio-mix, encode, segment size, heap, and final-mux times. Example:
  `chunk 3/100 · render 4.2s (180f) · audio 0.03s · encode 8.7s (1,204 KB, heap 412 MB)`.
- The export no longer builds per-chunk WAV headers or per-chunk audio copies; the PCM buffer is written in place.
- JPEG quality, video codec settings, audio sample rate, and output loudness handling are unchanged. The optimization work does not trade quality for speed.

## Measured micro-benchmark

`client/src/modules/export/pipeline/timelinePlan.bench.ts` compares the new binary lookup with the linear `timelineToSource` scan it replaced. Both run against the same 400-clip timeline and 200 sampled instants, with module exports hoisted out of the loop.

Two consecutive runs on the same machine (the benchmark is intentionally micro-scale, so run-to-run variance matters):

| Run | Linear scan (pre-optimization) | Binary `placementAt` (current) | Mean speedup |
| --- | ---: | ---: | ---: |
| 1 | 0.1816 ms mean, 6,676.75 ops/s | 0.0225 ms mean, 53,280.58 ops/s | 8.1× |
| 2 | 0.2169 ms mean, 5,309.86 ops/s | 0.0242 ms mean, 46,255.20 ops/s | 9.0× |

Result: **~8–9× lower mean latency** and **~8–9× higher throughput**. The benchmark asserts binary is faster than linear, so a regression fails the bench run.

At 18,000 frames and 400 clips, that changes the lookup portion from ~7.2 million comparisons to ~162,000 (9 comparisons per frame).

## Browser canvas micro-benchmark (measured)

The other hot path is the letterboxed backdrop. A standalone headless-Chrome harness measured the old full-size blur against the current 1/8-size backdrop on a synthetic 1920×1080 output with a 720×1280 portrait source, using `contain` placement. Each sample renders a batch of 8 frames and flushes the canvas once with `getImageData` so queued draws are included.

- Chrome 156.0.8078.47, headless, default raster backend (no GPU flags forced)
- Old frame: full 1920×1080 `drawImage` with `filter = 'blur(20px) brightness(0.35)'`, then the main image
- New frame: 240×135 `drawImage` with `filter = 'blur(1.5px)'`, upscale to 1920×1080, dark overlay, then the main image
- 8 frames per sample; two consecutive runs

| Run | Old full-size blur | New 1/8 backdrop | Speedup |
| --- | ---: | ---: | ---: |
| 1 | 24.64 ms/frame | 11.42 ms/frame | 2.16× |
| 2 | 22.02 ms/frame | 10.11 ms/frame | 2.18× |

This is a canvas-only component benchmark, not a full export: it excludes video seeking, prop compositing, JPEG encoding, and FFmpeg. It does confirm that the backdrop change removes real per-frame raster work rather than just moving it elsewhere.

## Deterministic work reduction (10-minute 1080p30 example)

These are counts derived from the pipeline, not wall-clock timings. At 1080p30 the planner uses 180 frames per chunk, so 18,000 frames produce 100 chunks.

| Work item | Before | After |
| --- | ---: | ---: |
| Audio encodes / muxes | 100 (one per chunk) | 1 (final mux) |
| Audio intermediate files | 100 stereo WAVs | 1 mono PCM track |
| Intermediate audio bytes | ~115.2 MB stereo WAV | ~57.6 MB mono PCM |
| Full-canvas blur passes | up to 18,000 | 0 (1/8-size backdrop instead) |
| Frame writes awaited serially | 18,000 | overlapped, ≤4 in flight |
| MEMFS delete round-trips | ~18,100 sequential | ~600 batched awaits |
| Clip lookups | linear (up to 7.2M comparisons) | binary (~162k comparisons) |
| Image decodes | per use | 1 per still asset |

**What is not measured here:** actual FFmpeg.wasm encode time at export scale. The canvas component above is measured in a real browser, but a full export also requires real media seeks, the bundled WASM core, and container muxing; jsdom cannot run those (the project’s own tests stub FFmpeg and canvas). No full-export before/after browser wall-clock table is claimed.

## Manual browser validation procedure

To produce full before/after export timings on a real machine:

1. Use the same project and the same media file for both builds (e.g. a 5–10 minute 1080p30 clip with several cuts, props, and at least one letterboxed source).
2. Record the baseline with the pre-fix commit checked out in a separate worktree.
3. In the current build, open DevTools → Console (the pipeline logs through `console.debug`) or observe the export progress dialog.
4. Export the same settings (1080p30, H.264, standard quality) and copy the per-chunk log lines plus the final `final mux …` line.
5. Compare:
   - total wall-clock time from “Export” click to download;
   - sum of `render` times;
   - sum of `encode` times;
   - final `mux` time;
   - peak `heap` values.
6. Repeat at least three times and report the median; browser cache/thermal state can dominate a single run.

Recommended cases: 1080p30 H.264 (default), 1080p30 VP9 alpha with a PNG still, and a 4K30 short export to exercise chunking and memory limits.

## Quality and correctness guardrails

- Video chunk encodes are video-only and stream-copied during concat; the only new generation loss is the existing JPEG intermediate.
- Audio remains 48 kHz, normalized once, with the same 5 ms cut micro-fades. Output is still AAC (MP4) or Opus (WebM) at the configured bitrate.
- PCM length is derived from the exact output frame count and filled at absolute offsets, so speed work cannot introduce drift.
- Alpha exports intentionally opt into PNG frames only for VP9/WebM image timelines; this is slower but required for transparency.
- `MAX_PENDING_WRITES` bounds in-flight frames; chunk size still bounds MEMFS memory. Peak memory should remain similar to the old pipeline (one chunk of frames + accumulated encoded segments).

## Remaining risks / technical debt

- Browser E2E timings are still unmeasured in this environment; the manual procedure above is the gap to close.
- Frame encoding still goes through one JPEG/PNG per frame. A future WebCodecs `VideoEncoder` path could remove the image-file round-trip entirely, but it would change the FFmpeg contract and is out of scope.
- The binary lookup is O(log n) only because `planClips` guarantees sorted, non-empty spans; callers must not pass arbitrary unsorted plans.
- The backdrop is redrawn at 1/8 size every frame; caching it per source frame would help only if the same frame were rendered repeatedly, which the export does not do.
- Batch size 32 for MEMFS deletes is a heuristic; it should be re-tuned if FFmpeg.wasm’s worker message overhead changes.
