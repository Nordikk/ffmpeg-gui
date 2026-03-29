# FFmpeg Forge

Early prototype for a focused all-in-one desktop GUI around FFmpeg, currently packaged with Electron for Windows.

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
- `npm run dev` for the browser build
- `npm run start:desktop` to launch the desktop app locally

## Build EXE

- `npm run build:desktop`
- The portable EXE is written to `release/`

## Current Features

- Desktop app shell with Electron
- Focused English UI instead of a landing-page style layout
- Working `Lossless Cut` workflow
- Working `Convert` workflow with safe default presets
- File picker and output picker
- `ffprobe` analysis for loaded media files
- Direct `ffmpeg` execution from the UI
- Visible FFmpeg compliance notice in the app

## Planned Next Steps

1. Bundle `ffmpeg` and `ffprobe` only with a full licensing/compliance workflow in place
2. Add real video preview and frame scrubbing
3. Add keyframe snapping for cleaner lossless cuts
4. Implement the remaining modules such as Audio, Frames, and Batch
