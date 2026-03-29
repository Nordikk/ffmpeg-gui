# FFmpeg Forge

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
- `npm run dev` for the frontend only
- `npm run tauri:dev` to run the desktop app in Tauri dev mode

## Build Apps

- `npm run tauri:build`
- Windows output is written under `src-tauri/target/release/bundle/`

## Platform Notes

- Windows builds can be produced from this Windows environment.
- A real macOS `.app` build must be created on macOS with Apple's native toolchain.
- Linux bundles should be built on Linux for the cleanest results.

## Current Features

- Tauri desktop app shell
- Focused English UI instead of a landing-page style layout
- Working `Lossless Cut` workflow
- Video preview inside `Lossless Cut`
- Draggable range selection in the `Lossless Cut` timeline
- Working `Convert` workflow with safe default presets
- File picker and output picker
- `ffprobe` analysis for loaded media files
- Direct `ffmpeg` execution from the UI
- Visible FFmpeg compliance notice in the app

## Planned Next Steps

1. Add draggable trim handles for resizing the selected cut range
2. Add real frame stepping and keyframe snapping
3. Bundle `ffmpeg` and `ffprobe` only with a full licensing/compliance workflow in place
4. Implement the remaining modules such as Audio, Frames, and Batch
