# Free, drift-free timeline navigation

Implementation notes and manual verification for the scrubber / transport fix.
The authoritative state remains `state.playheadMs`; the preview `<video>` is
always slaved to it.

## Root causes

### 1. The slider was a pure controlled input

`ScrubberBar` rendered `value={state.playheadMs}` and the rAF loop dispatched
`PLAYHEAD_SET` on almost every animation frame. Grabbing the thumb did not
create any ownership boundary, so the external writer and the pointer both
updated the same controlled value. The thumb could stutter, snap backwards, or
lose the pointer session while the media clock kept writing.

### 2. Play started the transport before the element had landed

`play()` dispatched `playing: true` immediately. On the next rAF tick
`planTransport()` was allowed to derive the playhead from `video.currentTime`
whenever the source was within `VIDEO_SYNC_TOLERANCE_MS` (60 ms). A stale
`currentTime` from the previous clip could therefore satisfy the window and
overwrite the parked playhead. The element was not required to seek first, and
there was no guard against the media clock during startup.

### 3. No precision review model

The transport had no scrub flag, frame-step math, keyboard map, reverse review,
or loop region. The range input was the only navigation surface, and its 10 ms
step could not express export-frame steps or a repeatable in/out loop.

## Fix model

### Scrub session owns the thumb

- `EditorState.scrubbing` is set by `SCRUB_BEGIN` and cleared by `SCRUB_END`.
- `ScrubberBar` keeps a local `draftMs` while the pointer is down. The range
  value, timecode, and `aria-valuetext` read that draft; rAF dispatches cannot
  move the thumb.
- On grab, the provider pauses the media immediately and starts the scrub
  session. On release it clears the session. If playback was running, it
  resumes through the play gate from the release position.
- Releasing with **Alt** deliberately leaves the transport paused.

### Play is a seek-first gate

`play()` now:

1. pauses the media element;
2. dispatches `playing: true` with `awaitingPlayStart: true` and the exact
   parked timeline position;
3. lets `planTransport()` seek/settle until `readyState >= 2`, `seeking ===
   false`, and the element is within 2 ms of the requested source instant;
4. emits `start-play` only then, which calls `video.play()` and clears the
   gate.

While `awaitingPlayStart` is true, no branch can return `play-video` and no
media-clock value can move the playhead. For 250 ms after the gate opens,
`PLAY_START_GUARD_TOLERANCE_MS` (40 ms) replaces the normal 60 ms playback
tolerance, so a stale clock cannot win at startup.

Loop wraps use the same gate at the in-point. The compositor holds the last
good frame while the seek is in flight, so wrapping has no black frame.

### Review keys

| Key | Action |
| --- | --- |
| `,` / `.` | One export frame back / forward |
| `←` / `→` | One export frame back / forward |
| `Shift+←` / `Shift+→` | One second back / forward |
| `Home` / `End` | Timeline start / end |
| `J` | Start stepped reverse review (10 fps jog) |
| `K` | Pause / stop reverse review |
| `L` | Play from park (through the seek gate) |
| `I` | Set loop in-point at the playhead |
| `O` | Set loop out-point at the playhead |
| `P` | Toggle loop playback |
| `Shift+P` | Clear the loop region |

Frame steps use `state.exportSettings.fps`, round to the nearest frame index,
and clamp to the last frame that starts inside the timeline. Stepping N frames
forward and N back returns to the same grid instant with no fractional drift.

`I` and `O` enable the loop automatically. The ScrubberBar has a Loop toggle
and a clear button; the timeline header shows the marked range and the lanes
show a shaded in/out region.

### Persistence

Project snapshots (version 2) include `playheadMs`, `loopRegion`, and
`loopEnabled`. Loading clamps the playhead and loop to the restored clips and
keeps playback paused so the user can resume the review deliberately. Version-1
snapshots load at the start with looping off.

## Manual verification script

1. **Rapid back/forth while paused.** Drag the thumb left and right ten times
   quickly and release at an arbitrary point. The thumb follows the pointer 1:1,
   never rubber-bands, and the timecode/playhead end exactly at the release
   position each time.
2. **Grab during playback.** Press Play, then grab the thumb and move it. Audio
   stops on grab, the thumb follows the hand, and release resumes from the new
   position through a short seek (the previous frame is held, never black).
   Repeat with **Alt** held on release: playback stays parked.
3. **Park and Play.** Pause at 5 s in a clip whose element had previously been
   at 1 s, press Play. The preview must seek to 5 s before moving; it must not
   jump to the old `currentTime`.
4. **Frame steps.** Press `.` thirty times, then `,` thirty times. The preview
   advances exactly thirty export frames and returns to the original frame
   instant. The thumb and timecode update on every press.
5. **Edges.** `Home` shows the first frame; `End` shows the final frame. Press
   `.`/`,` at an edge and confirm the playhead does not creep past it.
6. **Loop.** Park at 2 s, press `I`, park at 4 s, press `O`, then press Play
   from anywhere. The playhead cycles 2 s → 4 s → 2 s indefinitely. Watch the
   wrap: no black frame, no flash, and the timeline shows the loop band when it
   is enabled. Press `P` to disable, `Shift+P` to clear.
7. **Shuttle.** Press `J`; the preview jogs backwards about ten frames per
   second. Press `K`; it stops immediately. Press `L`; playback resumes from
   the parked frame through the gate.
8. **Save/load.** Save a project with a loop and a parked playhead, reload it,
   and confirm the playhead, loop band, and loop-enabled state are restored.
   Playback starts paused.
9. **Existing suites.** `npm run test -w client`, `npm run typecheck`, and
   `npm run lint` stay green.

## Automated coverage

- `client/src/modules/playback/engine.test.ts` — scrub clock isolation,
  play-from-park seek gate, tight startup guard, loop wrap (video/image, clip
  end), frame-grid stepping, loop normalization, play-start resolution, and
  repeated identical plan results.
- `client/src/modules/playback/shortcuts.test.ts` — key mapping, editable-field
  protection, repeat behavior, and default-prevention rules.
- `client/src/modules/playback/ScrubberBar.test.tsx` — local thumb ownership
  under external updates, resume from release, Alt-to-stay-paused, paused
  releases, step buttons, and loop controls.
- `client/src/app/state/editor.test.ts` — scrub/play-gate reducer transitions,
  loop marking/clamping, referentially stable repeated seeks, and project-load
  review restoration.
- `client/src/app/state/snapshot.test.ts` — version-2 round-trip, version-1
  fallback, malformed loop JSON, and timeline clamping.

## Remaining edge cases

- **Source switching during scrub:** if the target cut belongs to a different
  imported file, the preview holds the last decoded frame until the new source
  reaches `readyState >= 2` and the seek lands. There is deliberately no black
  clear during that window.
- **Image clips:** the play gate opens immediately (there is no media clock to
  wait for). Loop wrapping still runs through the hold frame, and images use
  wall-clock advance.
- **Very short timelines:** the loop minimum is 100 ms, and a timeline shorter
  than one export frame can only step on frame zero. Both are intentional
  guards against zero-length regions and seek storms; they are not a substitute
  for frame-accurate editing of sub-frame media.
- **Reverse review is stepped:** `J` is a 10 fps jog (one frame every 100 ms),
  not native negative playback. Browsers do not reliably decode/play video at
  negative rates, so a jog is the deterministic option.
- **Loop audio:** the video element is paused and re-seeked at the in-point, so
  a very short audio discontinuity can be audible on some browsers even though
  the canvas holds a continuous frame. Export is unaffected.
- **Browser seek precision:** HTML media seeks land on decoded frames, not
  arbitrary sub-frame timestamps. The reducer keeps the exact requested
  millisecond, and repeated seeks are idempotent; the displayed frame depends
  on the browser's decode grid.
- **Project media reattachment:** review state is restored only when the save
  is loaded onto the currently imported media, matching the existing project
  payload contract.
