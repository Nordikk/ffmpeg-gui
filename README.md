# FFForge

Cross-platform desktop prototype for a focused all-in-one FFmpeg GUI, now migrated to Tauri.

## Transparency

This project was created with significant assistance from Codex / AI tooling.
The code, structure, UI, and project setup were developed collaboratively between the project owner and AI-assisted tooling rather than being written entirely by hand from scratch.

## FFmpeg Licensing Notes

This project is designed to reduce FFmpeg licensing risk, but it is not legal advice.

- This build does not bundle FFmpeg or ffprobe binaries.
- The app currently calls external `ffmpeg` and `ffprobe` executables from the local system `PATH`.
- The built-in Convert presets intentionally avoid assuming GPL-only or nonfree FFmpeg configurations.
- If FFmpeg is bundled with future releases, the distribution must follow the official FFmpeg licensing checklist and provide the required notices and corresponding source where applicable.

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for links to the official FFmpeg licensing pages used for this project setup.

## Development

- `npm install`
- macOS local setup:
  - `brew install rust ffmpeg`
  - restart the terminal so `cargo`, `rustc`, `ffmpeg`, and `ffprobe` are on `PATH`
- `npm run dev` for the frontend only
- `npm run tauri:dev` to run the desktop app in Tauri dev mode

## Build Apps

- `npm run tauri:build`
- On macOS this builds a `.app` bundle only
- Current-platform output is written under `src-tauri/target/release/bundle/`
- Explicit macOS app build: `npm run tauri:build:mac`
- Windows installer-only build: `npm run tauri:build:windows`

## Platform Notes

- Windows development remains supported. Use `npm run tauri:build:windows` on Windows when you want the NSIS installer output.
- A real macOS `.app` build must be created on macOS with Apple's native toolchain.
- The default build script is platform-aware: macOS builds `.app`, Windows builds `nsis`.
- macOS development requires local installs of Rust and FFmpeg because this project uses system `ffmpeg` / `ffprobe` from `PATH`.
- Linux bundles should be built on Linux for the cleanest results.

## Current Features

- Tauri desktop app shell
- Focused English UI instead of a landing-page style layout
- Working `Lossless Cut` workflow
- Video preview inside `Lossless Cut`
- Draggable range selection in the `Lossless Cut` timeline
- Working `Convert` workflow with safe default presets
- Working `Audio`, `Frames`, and `Batch` workflows
- File and folder pickers
- `ffprobe` analysis for loaded media files
- Direct `ffmpeg` execution from the UI
- Native drag and drop with manual-path fallback

## Planned Next Steps

1. Remove the `Drop Debug` panel once drag and drop is confirmed stable
2. Keep polishing the desktop UX and module workflows
3. Bundle `ffmpeg` and `ffprobe` only with a full licensing/compliance workflow in place
