# Third-Party Notices

## FFmpeg

This application is designed to work with FFmpeg, but the current desktop build does not bundle FFmpeg or ffprobe binaries.
Instead, it calls the user's locally installed `ffmpeg` and `ffprobe` executables through the system `PATH`.

## Licensing Approach In This Project

- No FFmpeg binaries are redistributed in the current build.
- Default Convert presets avoid assuming GPL-only libraries such as `libx264` or nonfree FFmpeg configurations.
- If future releases bundle FFmpeg, the distribution should follow the official FFmpeg licensing and redistribution guidance.

## Official FFmpeg Sources

- FFmpeg legal checklist: https://ffmpeg.org/legal.html
- FFmpeg general documentation for external libraries and configuration flags: https://ffmpeg.org/general.html

## Important Note

This file documents the current project approach for transparency. It is not legal advice.
