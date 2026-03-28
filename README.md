# FFmpeg Forge

Early prototype for a focused all-in-one desktop GUI around FFmpeg, currently packaged with Electron for Windows.

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
- File picker and output picker
- `ffprobe` analysis for loaded media files
- Direct `ffmpeg` execution from the UI

## Planned Next Steps

1. Bundle `ffmpeg` and `ffprobe` with the app so it runs on machines without a local install
2. Add real video preview and frame scrubbing
3. Add keyframe snapping for cleaner lossless cuts
4. Implement the remaining modules such as Convert, Audio, Frames, and Batch
