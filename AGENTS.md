# AGENTS.md

## Project Overview

This repository contains `FFmpeg Forge`, a cross-platform desktop prototype for a focused FFmpeg GUI.
The desktop runtime is now `Tauri`, not Electron.
The frontend is `React + TypeScript + Vite`.
The Tauri backend is implemented in Rust under `src-tauri/`.

## Current Architecture

- Frontend entry: `src/App.tsx`
- Frontend styles: `src/styles/app.css`
- Shared UI data: `src/data/appData.ts`
- Tauri config: `src-tauri/tauri.conf.json`
- Tauri backend commands: `src-tauri/src/lib.rs`
- Tauri Rust entry: `src-tauri/src/main.rs`

## Important Current Features

- `Lossless Cut` is functional.
- `Lossless Cut` has an embedded video preview.
- `Lossless Cut` has a draggable timeline selection for moving the selected segment.
- `Convert` is functional.
- `Convert` uses safer default presets intended to avoid assuming GPL-only or nonfree FFmpeg builds.
- The app uses external `ffmpeg` and `ffprobe` binaries from the system `PATH`.
- The app does **not** currently bundle FFmpeg binaries.

## Licensing / Compliance Rules

Be careful not to make FFmpeg licensing worse without explicitly documenting it.

Current project policy:

- Do not bundle `ffmpeg` or `ffprobe` binaries unless the user explicitly asks for it.
- If bundling is added later, update `README.md` and `THIRD_PARTY_NOTICES.md`.
- Avoid adding default workflows that assume GPL-only libraries such as `libx264` unless the user explicitly wants that tradeoff and documentation is updated.
- Prefer defaults that work with broadly available FFmpeg builds.
- Keep visible compliance messaging in the app unless the user explicitly asks to change it.

Relevant files:

- `README.md`
- `THIRD_PARTY_NOTICES.md`

Official reference links already documented in the repo:

- https://ffmpeg.org/legal.html
- https://ffmpeg.org/general.html

## Build / Run Commands

Frontend only:

- `npm install`
- `npm run dev`
- `npm run build`

Tauri desktop development:

- `npm run tauri:dev`

Tauri production build:

- `npm run tauri:build`

Current Windows bundle output:

- `src-tauri/target/release/bundle/nsis/`

## Platform Notes

- Windows builds can be produced from this Windows environment.
- A real macOS `.app` must be built on macOS with Apple's native toolchain.
- Linux bundles should be built on Linux for the cleanest results.
- If a future session is asked to build macOS artifacts from Windows, explain clearly that the project can be prepared for macOS, but the final native macOS build must run on a Mac.

## Current Known Limitations

- `Lossless Cut` can move the selected range, but does not yet have separate drag handles for resizing the range.
- `Lossless Cut` does not yet have frame stepping or keyframe snapping.
- `Lossless Cut` preview uses the browser video element and is not yet a professional editing timeline.
- Remaining modules (`Audio`, `Frames`, `Batch`) are placeholders.
- There may still be old Electron-related files in the repo; do not assume they are still active.

## Priorities For The Next Session

If the user says "continue" or asks for the next logical step, prioritize in this order unless they specify otherwise:

1. Improve `Lossless Cut` with resize handles.
2. Add frame stepping and keyframe snapping.
3. Implement `Audio` module.
4. Implement `Frames` module.
5. Implement `Batch` module.
6. Clean out obsolete Electron files if they are no longer used.

## Workflow Guidance For Codex

- Preserve the current plain, tool-oriented UI. Do not turn the app back into a marketing-style landing page.
- Keep the entire UI in English unless the user explicitly requests another language.
- Prefer focused desktop-app behavior over flashy web-style design.
- Before changing packaging/runtime again, inspect `package.json` and `src-tauri/` first.
- If something about Tauri build tooling fails, check Rust toolchain availability and Tauri icon/config requirements early.
- When modifying FFmpeg behavior, keep command previews visible where practical.
- When adding new media workflows, continue using `ffprobe` analysis where useful.

## Transparency Note

This project has been developed collaboratively with Codex / AI assistance.
Do not remove that transparency from `README.md` unless the user explicitly asks for it.
