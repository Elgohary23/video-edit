# AGENTS.md — Personal Web Video Editor

Local-only, browser-based video editor: auto silence cuts, dynamic auto-zoom, animated props, background blur, local MP4 export. `PRD.md` is the source of truth for behavior and defaults (silence threshold -35dB, min silence 300ms, padding 120ms, zoom alternation 100%/115%) — re-read it before building a feature.

## Stack — fixed, do not substitute
- MERN (MongoDB, Express, React, Node).
- TypeScript on both frontend and backend; never write plain JavaScript files.
- Tailwind for all styling; no other styling system.
- Modern React only: function components + hooks, no class components.
- Browser engines per PRD: Web Audio API (analysis), HTML5 2D Canvas (render), FFmpeg.wasm (MP4 export).

## Layout conventions
- **Backend: Domain-Driven Design.** Code organized by bounded context/domain, each domain owning its layers (domain / application / infrastructure / interface). No cross-domain grab-bag folders like a global `utils/` or `services/`.
- **Frontend: modules/feature structure.** Each feature owns its components, hooks, state, and styles; no shared catch-all component folder.

## Editing rules
- Surgical accuracy: change exactly what the task requires. No drive-by refactors, renames, or reformatting of unrelated code — even if it looks wrong.
- Every layout must be responsive (desktop, tablet, mobile), including timeline/canvas panels.
- Design system: minimal and creative — restrained Tailwind utilities, tight spacing scale, few colors.

## Verification & Git
- Test every snippet (frontend and backend) and do not stop until it passes; a change is done only when green.
- Push each tested snippet to the remote even if the overall task is incomplete; if pushed code later proves wrong, push the fix as a follow-up.
- `origin` = `git@github.com:Elgohary23/video-edit.git` (SSH, auth already works — no credential setup needed). Main working branch: `master`.
- Clean commits with messages that say what and why.

## Commands (npm workspaces: `client/` Vite+React+Tailwind, `server/` Express+Mongoose)
- Install once at repo root: `npm install` (workspaces only — never install inside `client/` or `server/` per-package without a reason).
- Run in one workspace: append `-w client` or `-w server` (e.g. `npm run test -w client`).
- `npm run dev` — both workspaces in parallel (Vite on :5173, API on :4000).
- `npm run test -w client` / `-w server` — vitest per workspace; `npm test` runs both.
- `npm run typecheck` — tsc strict, runs per workspace; run after tests before committing.
- `npm run lint` — ESLint (typescript-eslint + react-hooks) at repo root via `eslint.config.mjs`.
- `npm run build -w client` / `-w server` — production builds (vite / tsup).
