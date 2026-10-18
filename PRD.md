# 📄 Product Requirements Document (PRD)

---

## 1. Executive Summary & Core Objective

* **Project Name:** Personal Web Video Editor (Desktop-Local Web App).
* **Operating Environment:** Local-only, browser-based web application. Runs entirely on the user's machine without external servers or artificial intelligence.
* **Objective:** Streamline the personal video editing workflow by automating silence detection and jump cutting, applying dynamic auto-zooming across clips, and providing an intuitive UI to overlay animated visual props and background blur effects.

---

## 2. System Architecture & Tech Stack

```
+-----------------------------------------------------------------------------------+
|                                  Browser Client                                   |
|                                                                                   |
|  +--------------------+    +------------------------+    +---------------------+  |
|  | Web Audio Engine   |    | HTML5 Canvas / UI      |    | Auto-Motion Engine  |  |
|  | - AudioBuffer RMS  |    | - Waveform & Overlays  |    | - Interpolation     |  |
|  | - Silence Cuts     |    | - Props Placement      |    | - Easing Curves     |  |
|  +---------+----------+    +-----------+------------+    +----------+----------+  |
|            |                           |                            |             |
|            +---------------------------+----------------------------+             |
|                                        |                                          |
|                                        v                                          |
|                     +---------------------------------------+                     |
|                     | Light 2D Canvas Render Pipeline (CPU) |                     |
|                     +-------------------+-------------------+                     |
|                                         |                                         |
|                                         v                                         |
|                     +---------------------------------------+                     |
|                     | FFmpeg.wasm Export Engine (Local MP4) |                     |
|                     +---------------------------------------+                     |
+-----------------------------------------------------------------------------------+

```

* **Frontend UI & State:** React or Vanilla JavaScript + HTML5 Canvas.
* **Audio Analysis Engine:** Web Audio API (Algorithmic `AudioBuffer` RMS analysis).
* **Rendering Pipeline:** CPU-lightweight HTML5 2D Canvas Rendering Engine for real-time preview and editing.
* **Video Export Pipeline:** Local `FFmpeg.wasm` for background rendering and encoding.

---

## 3. Detailed Functional Requirements

### Feature 1: Video Upload & Audio Analysis

* **File Ingestion:** Drag-and-drop or file picker input for local video files.
* **Audio Extraction & Progress Indicator:** Extracts the audio track into an `AudioBuffer` and renders a precise **Progress Bar** indicating the analysis status.

---

### Feature 2: Algorithmic Jump-Cut Engine (Silence Detection)

* **Parameter Sliders (UI Controls):**
* **Silence Threshold (`dB`):** Adjustable gain threshold (Default: `-35dB`).
* **Min Silence Duration (`ms`):** Minimum silence length to trigger a cut (Default: `300ms`).
* **Safety Padding (`ms`):** Padding before and after speech to prevent clipping word edges (Default: `120ms`).


* **Waveform Visualization:** Renders the audio waveform on the timeline with identified silent regions highlighted in **Red Overlays** prior to execution.
* **Non-Destructive Splitting:** Clicking **"Apply Silence Cut"** removes the silent gaps and leaves the remaining vocal clips split on the timeline, allowing the user to manually clean up filler sounds (e.g., "uhs" and "ams").

---

### Feature 3: Dynamic Auto-Zoom (Multi-Camera Effect)

* **One-Click Automation:** A dedicated button that automatically applies dynamic framing across all split clips on the timeline.
* **Alternating Scale Logic:** Automatically alternates scale factors between adjacent clips to break visual monotony:
* `Clip 1 = 100% (Base Scale)`
* `Clip 2 = 115% (Punch-in Zoom)`
* `Clip 3 = 100% (Base Scale)` ... and so forth.



---

### Feature 4: Interactive Props & Motion Animation Engine

* **Asset Import & On-Screen Placement:** Import PNG images/graphics onto overlay tracks. Position and scale props directly on the preview window using **Interactive Drag & Resize** handles.
* **Timeline Range Editing:** Adjust in-points and out-points by **dragging the edges** of prop blocks on the overlay timeline tracks.
* **One-Click In/Out Motion Presets:** Single-button trigger that automatically calculates and applies eye-catching entry/exit motion dynamics (e.g., Pop & Bounce / Slide and Snap) to all active props based on their timeline durations.

---

### Feature 5: Global Background Blur

* **Global Blur Toggle:** A global UI toggle switch. When enabled, it automatically applies a subtle Gaussian blur to the main video track whenever a prop is actively rendered on screen, reverting back to normal once the prop disappears.

---

### Feature 6: Local MP4 Video Export

* **Export Pipeline:** Processes timeline layers, transformations, motion curves, and cuts locally in the browser memory using `FFmpeg.wasm`.
* **Output Format:** Generates a downloadable **MP4 (H.264)** video file saved directly to the user's local disk.

---