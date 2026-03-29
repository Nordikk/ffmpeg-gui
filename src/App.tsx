import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useRef, useState } from 'react';
import { convertPresets, presets, tools } from './data/appData';

declare const __BUILD_ID__: string;

type ToolId = (typeof tools)[number]['id'];

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  sample_rate?: string;
};

type ProbeResult = {
  streams?: ProbeStream[];
  format?: {
    duration?: string;
    format_long_name?: string;
    bit_rate?: string;
  };
};

type ToolBinaryStatus = {
  available: boolean;
  version: string;
  error: string;
};

type ToolStatus = {
  ffmpeg: ToolBinaryStatus;
  ffprobe: ToolBinaryStatus;
};

type JobRecord = {
  id: string;
  kind: 'cut' | 'convert' | 'audio' | 'frames' | 'batch';
  source: string;
  output: string;
  status: 'Running' | 'Done' | 'Error';
  startedAt: string;
  detail: string;
};

type DropDebugState = {
  lastEvent: 'idle' | 'enter' | 'over' | 'leave' | 'drop';
  pathCount: number;
  firstPath: string;
  timestamp: string;
  source: 'none' | 'window' | 'dom';
  detail: string;
};

type DragDropPayload = {
  paths?: string[];
  position?: {
    x: number;
    y: number;
  };
};

const moduleDescriptions: Record<ToolId, { title: string; description: string }> = {
  'lossless-cut': {
    title: 'Lossless Cut',
    description: 'Trim a source file with preview, keyframe snapping, and stream copy options.'
  },
  'smart-convert': {
    title: 'Convert',
    description: 'Convert media with conservative FFmpeg defaults.'
  },
  'audio-lab': {
    title: 'Audio',
    description: 'Extract or transcode audio streams with safe FFmpeg options.'
  },
  'image-sequence': {
    title: 'Frames',
    description: 'Export image sequences from video sources.'
  },
  'batch-pipeline': {
    title: 'Batch',
    description: 'Run the same convert settings across multiple files.'
  }
};

function padTime(value: number) {
  return String(value).padStart(2, '0');
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function secondsToTimestamp(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '00:00:00';
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${padTime(hours)}:${padTime(minutes)}:${padTime(seconds)}`;
}

function timestampToSeconds(value: string) {
  const parts = value.split(':').map((part) => Number(part));

  if (parts.some((part) => Number.isNaN(part))) {
    return NaN;
  }

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  if (parts.length === 1) {
    return parts[0];
  }

  return NaN;
}

function fileNameFromPath(filePath: string) {
  const normalized = filePath.replaceAll('\\', '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || filePath;
}

function isWindowsPath(filePath: string) {
  return /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\');
}

function pathSeparatorFor(filePath: string) {
  return isWindowsPath(filePath) ? '\\' : '/';
}

function directoryFromPath(filePath: string) {
  const normalized = filePath.replaceAll('\\', '/');
  const lastSeparator = normalized.lastIndexOf('/');

  if (lastSeparator < 0) {
    return '';
  }

  if (lastSeparator === 0) {
    return '/';
  }

  return normalized.slice(0, lastSeparator);
}

function joinPath(basePath: string, childName: string, pathStyleSample = basePath || childName) {
  if (!basePath) {
    return childName;
  }

  const separator = pathSeparatorFor(pathStyleSample);
  const trimmedBase = basePath.endsWith('/') || basePath.endsWith('\\') ? basePath.slice(0, -1) : basePath;
  const trimmedChild = childName.replace(/^[/\\]+/, '');
  return `${trimmedBase}${separator}${trimmedChild}`;
}

function stripExtension(filePath: string) {
  return filePath.replace(/\.[^.]+$/, '');
}

function extensionFromPath(filePath: string) {
  const match = /\.([^.]+)$/.exec(filePath);
  return match?.[1]?.toLowerCase() || 'mp4';
}

function replaceExtension(filePath: string, suffix: string, extension: string) {
  if (/\.[^.]+$/.test(filePath)) {
    return filePath.replace(/\.[^.]+$/, `${suffix}.${extension}`);
  }

  return `${filePath}${suffix}.${extension}`;
}

function filePathToVideoUrl(filePath: string) {
  if (!filePath) {
    return '';
  }

  if (isTauri()) {
    return convertFileSrc(filePath);
  }

  const normalized = filePath.replaceAll('\\', '/');
  return `file:///${encodeURI(normalized)}`;
}

function decodeFileUri(value: string) {
  if (!value.toLowerCase().startsWith('file://')) {
    return '';
  }

  try {
    const url = new URL(value);
    const decodedPath = decodeURIComponent(url.pathname || '');

    if (url.hostname && url.hostname !== 'localhost') {
      return `\\\\${url.hostname}${decodedPath.replaceAll('/', '\\')}`;
    }

    if (/^\/[a-zA-Z]:/.test(decodedPath)) {
      return decodedPath.slice(1).replaceAll('/', '\\');
    }

    return decodedPath;
  } catch {
    return '';
  }
}

function uniquePaths(paths: string[]) {
  return [...new Set(paths.filter(Boolean))];
}

function extractPathsFromDroppedText(rawText: string) {
  return uniquePaths(
    rawText
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry && !entry.startsWith('#'))
      .map((entry) => {
        const decodedUri = decodeFileUri(entry);
        if (decodedUri) {
          return decodedUri;
        }

        if (/^[a-zA-Z]:[\\/]/.test(entry) || entry.startsWith('\\\\')) {
          return entry;
        }

        if (entry.startsWith('/')) {
          return entry;
        }

        return '';
      })
  );
}

function describeDataTransfer(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) {
    return 'No dataTransfer available';
  }

  const types = Array.from(dataTransfer.types || []);
  const items = Array.from(dataTransfer.items || []).map((item) => `${item.kind}:${item.type || 'unknown'}`);
  const files = Array.from(dataTransfer.files || []).map((file) => file.name);

  return [
    types.length ? `types=${types.join(', ')}` : '',
    items.length ? `items=${items.join(', ')}` : '',
    files.length ? `files=${files.join(', ')}` : ''
  ]
    .filter(Boolean)
    .join(' | ');
}

function extractDroppedPaths(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) {
    return [];
  }

  const fileObjectPaths = Array.from(dataTransfer.files || [])
    .map((file) => ('path' in file ? String((file as File & { path?: string }).path || '') : ''))
    .filter(Boolean);

  if (fileObjectPaths.length) {
    return uniquePaths(fileObjectPaths);
  }

  const uriList = dataTransfer.getData('text/uri-list');
  const textPlain = dataTransfer.getData('text/plain');

  return uniquePaths([
    ...extractPathsFromDroppedText(uriList),
    ...extractPathsFromDroppedText(textPlain)
  ]);
}

function isFileDrag(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) {
    return false;
  }

  const hasFileType = Array.from(dataTransfer.types || []).includes('Files');
  const hasFileItem = Array.from(dataTransfer.items || []).some((item) => item.kind === 'file');
  return hasFileType || hasFileItem;
}

function buildLosslessCommandPreview(
  sourcePath: string,
  outputPath: string,
  start: string,
  end: string,
  videoCodec: string,
  audioCodec: string
) {
  if (!sourcePath || !outputPath) {
    return 'ffmpeg -y -ss 00:00:00 -to 00:00:00 -i "input.mp4" -c:v copy -c:a copy "output.mp4"';
  }

  return `ffmpeg -y -ss ${start} -to ${end} -i "${sourcePath}" -c:v ${videoCodec} -c:a ${audioCodec} "${outputPath}"`;
}

function buildConvertCommandPreview(
  sourcePath: string,
  outputPath: string,
  videoCodec: string,
  audioCodec: string,
  videoBitrate: string,
  audioBitrate: string
) {
  if (!sourcePath || !outputPath) {
    return 'ffmpeg -y -i "input.mov" -c:v mpeg4 -b:v 5M -c:a aac -b:a 192k "output.mp4"';
  }

  const parts = ['ffmpeg', '-y', '-i', `"${sourcePath}"`];

  if (videoCodec === 'none') {
    parts.push('-vn');
  } else {
    parts.push('-c:v', videoCodec);
    if (videoBitrate && videoCodec !== 'copy') {
      parts.push('-b:v', videoBitrate);
    }
  }

  if (audioCodec === 'none') {
    parts.push('-an');
  } else {
    parts.push('-c:a', audioCodec);
    if (audioBitrate && audioCodec !== 'copy') {
      parts.push('-b:a', audioBitrate);
    }
  }

  parts.push(`"${outputPath}"`);
  return parts.join(' ');
}

function buildAudioCommandPreview(
  sourcePath: string,
  outputPath: string,
  audioCodec: string,
  audioBitrate: string,
  sampleRate: string,
  channels: string
) {
  if (!sourcePath || !outputPath) {
    return 'ffmpeg -y -i "input.mp4" -vn -c:a aac -b:a 192k -ar 48000 -ac 2 "output.m4a"';
  }

  const parts = ['ffmpeg', '-y', '-i', `"${sourcePath}"`, '-vn', '-c:a', audioCodec];

  if (audioBitrate && audioCodec !== 'copy') {
    parts.push('-b:a', audioBitrate);
  }

  if (sampleRate) {
    parts.push('-ar', sampleRate);
  }

  if (channels) {
    parts.push('-ac', channels);
  }

  parts.push(`"${outputPath}"`);
  return parts.join(' ');
}

function buildFrameCommandPreview(
  sourcePath: string,
  outputDir: string,
  imageFormat: string,
  fps: string,
  quality: string,
  startNumber: number
) {
  if (!sourcePath || !outputDir) {
    return 'ffmpeg -y -i "input.mp4" -vf fps=1 -start_number 1 "frames/frame_%06d.png"';
  }

  const parts = ['ffmpeg', '-y', '-i', `"${sourcePath}"`];

  if (fps) {
    parts.push('-vf', `fps=${fps}`);
  }

  parts.push('-start_number', String(startNumber));

  if (quality && (imageFormat === 'jpg' || imageFormat === 'jpeg' || imageFormat === 'webp')) {
    parts.push('-q:v', quality);
  }

  parts.push(`"${joinPath(outputDir, `frame_%06d.${imageFormat}`)}"`);
  return parts.join(' ');
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }

  return date.toLocaleString();
}

function errorMessageFromUnknown(caughtError: unknown, fallback: string) {
  if (caughtError instanceof Error && caughtError.message.trim()) {
    return caughtError.message.trim();
  }

  if (typeof caughtError === 'string' && caughtError.trim()) {
    return caughtError.trim();
  }

  if (caughtError && typeof caughtError === 'object') {
    const message =
      'message' in caughtError && typeof caughtError.message === 'string'
        ? caughtError.message
        : 'error' in caughtError && typeof caughtError.error === 'string'
          ? caughtError.error
          : '';

    if (message.trim()) {
      return message.trim();
    }
  }

  return fallback;
}

function nearestKeyframe(value: number, keyframes: number[]) {
  if (!keyframes.length) {
    return value;
  }

  let best = keyframes[0];
  let bestDistance = Math.abs(best - value);

  for (const keyframe of keyframes) {
    const distance = Math.abs(keyframe - value);
    if (distance < bestDistance) {
      best = keyframe;
      bestDistance = distance;
    }
  }

  return best;
}

function App() {
  const buildId = __BUILD_ID__;
  const [activeTool, setActiveTool] = useState<ToolId>('lossless-cut');
  const [toolStatus, setToolStatus] = useState<ToolStatus | null>(null);
  const [isCheckingToolStatus, setIsCheckingToolStatus] = useState(true);

  const [sourcePath, setSourcePath] = useState('');
  const [outputPath, setOutputPath] = useState('');
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [start, setStart] = useState('00:00:00');
  const [end, setEnd] = useState('00:00:00');
  const [videoCodec, setVideoCodec] = useState('copy');
  const [audioCodec, setAudioCodec] = useState('copy');
  const [preset, setPreset] = useState('Lossless Trim');
  const [status, setStatus] = useState('Idle');
  const [error, setError] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [lastLog, setLastLog] = useState('');
  const [previewTime, setPreviewTime] = useState(0);
  const [keyframes, setKeyframes] = useState<number[]>([]);
  const [snapToKeyframes, setSnapToKeyframes] = useState(true);
  const [manualSourcePath, setManualSourcePath] = useState('');

  const [convertSourcePath, setConvertSourcePath] = useState('');
  const [convertOutputPath, setConvertOutputPath] = useState('');
  const [convertProbe, setConvertProbe] = useState<ProbeResult | null>(null);
  const [convertPreset, setConvertPreset] = useState('MP4 Safe Convert');
  const [convertContainer, setConvertContainer] = useState('mp4');
  const [convertVideoCodec, setConvertVideoCodec] = useState('mpeg4');
  const [convertAudioCodec, setConvertAudioCodec] = useState('aac');
  const [convertVideoBitrate, setConvertVideoBitrate] = useState('5M');
  const [convertAudioBitrate, setConvertAudioBitrate] = useState('192k');
  const [convertStatus, setConvertStatus] = useState('Idle');
  const [convertError, setConvertError] = useState('');
  const [isConvertBusy, setIsConvertBusy] = useState(false);
  const [convertLog, setConvertLog] = useState('');
  const [manualConvertPath, setManualConvertPath] = useState('');

  const [audioSourcePath, setAudioSourcePath] = useState('');
  const [audioOutputPath, setAudioOutputPath] = useState('');
  const [audioProbe, setAudioProbe] = useState<ProbeResult | null>(null);
  const [audioCodecSetting, setAudioCodecSetting] = useState('aac');
  const [audioBitrateSetting, setAudioBitrateSetting] = useState('192k');
  const [audioSampleRate, setAudioSampleRate] = useState('48000');
  const [audioChannels, setAudioChannels] = useState('2');
  const [audioStatus, setAudioStatus] = useState('Idle');
  const [audioError, setAudioError] = useState('');
  const [isAudioBusy, setIsAudioBusy] = useState(false);
  const [audioLog, setAudioLog] = useState('');
  const [manualAudioPath, setManualAudioPath] = useState('');

  const [frameSourcePath, setFrameSourcePath] = useState('');
  const [frameOutputDir, setFrameOutputDir] = useState('');
  const [frameProbe, setFrameProbe] = useState<ProbeResult | null>(null);
  const [frameImageFormat, setFrameImageFormat] = useState('png');
  const [frameFps, setFrameFps] = useState('1');
  const [frameQuality, setFrameQuality] = useState('2');
  const [frameStartNumber, setFrameStartNumber] = useState('1');
  const [frameStatus, setFrameStatus] = useState('Idle');
  const [frameError, setFrameError] = useState('');
  const [isFrameBusy, setIsFrameBusy] = useState(false);
  const [frameLog, setFrameLog] = useState('');
  const [manualFramePath, setManualFramePath] = useState('');

  const [batchFiles, setBatchFiles] = useState<string[]>([]);
  const [batchPreset, setBatchPreset] = useState('MP4 Safe Convert');
  const [batchContainer, setBatchContainer] = useState('mp4');
  const [batchVideoCodec, setBatchVideoCodec] = useState('mpeg4');
  const [batchAudioCodec, setBatchAudioCodec] = useState('aac');
  const [batchVideoBitrate, setBatchVideoBitrate] = useState('5M');
  const [batchAudioBitrate, setBatchAudioBitrate] = useState('192k');
  const [batchStatus, setBatchStatus] = useState('Idle');
  const [batchError, setBatchError] = useState('');
  const [isBatchBusy, setIsBatchBusy] = useState(false);
  const [batchLog, setBatchLog] = useState('');
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [isDropTargetActive, setIsDropTargetActive] = useState(false);
  const [dropDebug, setDropDebug] = useState<DropDebugState>({
    lastEvent: 'idle',
    pathCount: 0,
    firstPath: '',
    timestamp: '',
    source: 'none',
    detail: ''
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timelineTrackRef = useRef<HTMLDivElement | null>(null);
  const lastDropRef = useRef<{ signature: string; at: number }>({ signature: '', at: 0 });
  const domDragDepthRef = useRef(0);
  const activeToolRef = useRef<ToolId>('lossless-cut');
  const convertContainerRef = useRef('mp4');
  const losslessLoadRequestRef = useRef(0);
  const nativeDropEnabledRef = useRef(false);
  const dragRef = useRef<{ active: false } | { active: true; mode: 'move' | 'start' | 'end'; startX: number; startStart: number; startEnd: number }>({
    active: false
  });

  const durationSeconds = Number(probe?.format?.duration || 0);
  const durationLabel = secondsToTimestamp(durationSeconds);
  const videoStream = probe?.streams?.find((stream) => stream.codec_type === 'video');
  const audioStream = probe?.streams?.find((stream) => stream.codec_type === 'audio');
  const outputExtension = extensionFromPath(outputPath || sourcePath || 'output.mp4');
  const commandPreview = buildLosslessCommandPreview(sourcePath, outputPath, start, end, videoCodec, audioCodec);
  const selectionStartSeconds = clamp(timestampToSeconds(start), 0, durationSeconds || 0);
  const selectionEndSeconds = clamp(timestampToSeconds(end), 0, durationSeconds || 0);
  const selectionSpan = Math.max(selectionEndSeconds - selectionStartSeconds, 0);
  const selectionLeftPercent = durationSeconds > 0 ? (selectionStartSeconds / durationSeconds) * 100 : 0;
  const selectionWidthPercent = durationSeconds > 0 ? (selectionSpan / durationSeconds) * 100 : 0;
  const previewPercent = durationSeconds > 0 ? (clamp(previewTime, 0, durationSeconds) / durationSeconds) * 100 : 0;
  const videoPreviewUrl = filePathToVideoUrl(sourcePath);

  const convertDurationSeconds = Number(convertProbe?.format?.duration || 0);
  const convertDurationLabel = secondsToTimestamp(convertDurationSeconds);
  const convertVideoStream = convertProbe?.streams?.find((stream) => stream.codec_type === 'video');
  const convertAudioStream = convertProbe?.streams?.find((stream) => stream.codec_type === 'audio');
  const convertCommandPreview = buildConvertCommandPreview(
    convertSourcePath,
    convertOutputPath,
    convertVideoCodec,
    convertAudioCodec,
    convertVideoBitrate,
    convertAudioBitrate
  );
  const activeModule = moduleDescriptions[activeTool];
  const ffmpegReady = Boolean(toolStatus?.ffmpeg.available && toolStatus?.ffprobe.available);
  const audioDurationLabel = secondsToTimestamp(Number(audioProbe?.format?.duration || 0));
  const audioSourceStream = audioProbe?.streams?.find((stream) => stream.codec_type === 'audio');
  const audioCommandPreview = buildAudioCommandPreview(
    audioSourcePath,
    audioOutputPath,
    audioCodecSetting,
    audioBitrateSetting,
    audioSampleRate,
    audioChannels
  );
  const frameDurationLabel = secondsToTimestamp(Number(frameProbe?.format?.duration || 0));
  const frameVideoStream = frameProbe?.streams?.find((stream) => stream.codec_type === 'video');
  const frameCommandPreview = buildFrameCommandPreview(
    frameSourcePath,
    frameOutputDir,
    frameImageFormat,
    frameFps,
    frameQuality,
    Number(frameStartNumber || 1)
  );

  useEffect(() => {
    let isDisposed = false;
    const timer = window.setTimeout(() => {
      void invoke<ToolStatus>('check_tool_status')
        .then((nextStatus) => {
          if (isDisposed) {
            return;
          }

          setToolStatus(nextStatus);
        })
        .catch(() => {
          if (isDisposed) {
            return;
          }

          setToolStatus(null);
        })
        .finally(() => {
          if (isDisposed) {
            return;
          }

          setIsCheckingToolStatus(false);
        });
    }, 120);

    return () => {
      isDisposed = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (preset === 'Lossless Trim') {
      setVideoCodec('copy');
      setAudioCodec('copy');
    }

    if (preset === 'Audio Only') {
      setVideoCodec('copy');
      setAudioCodec('aac');
    }
  }, [preset]);

  useEffect(() => {
    const selectedPreset = convertPresets.find((entry) => entry.name === convertPreset);
    if (!selectedPreset) {
      return;
    }

    setConvertContainer(selectedPreset.container);
    setConvertVideoCodec(selectedPreset.videoCodec);
    setConvertAudioCodec(selectedPreset.audioCodec);
    setConvertVideoBitrate(selectedPreset.videoBitrate);
    setConvertAudioBitrate(selectedPreset.audioBitrate);

    if (convertSourcePath) {
      setConvertOutputPath(replaceExtension(convertSourcePath, '_convert', selectedPreset.container));
    }
  }, [convertPreset, convertSourcePath]);

  useEffect(() => {
    const selectedPreset = convertPresets.find((entry) => entry.name === batchPreset);
    if (!selectedPreset) {
      return;
    }

    setBatchContainer(selectedPreset.container);
    setBatchVideoCodec(selectedPreset.videoCodec);
    setBatchAudioCodec(selectedPreset.audioCodec);
    setBatchVideoBitrate(selectedPreset.videoBitrate);
    setBatchAudioBitrate(selectedPreset.audioBitrate);
  }, [batchPreset]);

  useEffect(() => {
    if (!audioSourcePath) {
      return;
    }

    const audioExtension =
      audioCodecSetting === 'copy'
        ? extensionFromPath(audioSourcePath)
        : audioCodecSetting === 'flac'
          ? 'flac'
          : audioCodecSetting === 'mp3'
            ? 'mp3'
            : audioCodecSetting === 'pcm_s16le'
              ? 'wav'
              : 'm4a';

    setAudioOutputPath(replaceExtension(audioSourcePath, '_audio', audioExtension));
  }, [audioCodecSetting, audioSourcePath]);

  useEffect(() => {
    activeToolRef.current = activeTool;
  }, [activeTool]);

  useEffect(() => {
    convertContainerRef.current = convertContainer;
  }, [convertContainer]);

  useEffect(() => {
    if (!videoRef.current || !sourcePath) {
      return;
    }

    const nextTime = clamp(selectionStartSeconds, 0, durationSeconds || selectionStartSeconds);
    if (Number.isFinite(nextTime)) {
      try {
        videoRef.current.currentTime = nextTime;
        setPreviewTime(nextTime);
      } catch {
      }
    }
  }, [sourcePath, selectionStartSeconds, durationSeconds]);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      if (!dragRef.current.active || !timelineTrackRef.current || durationSeconds <= 0) {
        return;
      }

      const trackRect = timelineTrackRef.current.getBoundingClientRect();
      if (trackRect.width <= 0) {
        return;
      }

      const deltaFraction = (event.clientX - dragRef.current.startX) / trackRect.width;
      const deltaSeconds = deltaFraction * durationSeconds;

      if (dragRef.current.mode === 'move') {
        const span = dragRef.current.startEnd - dragRef.current.startStart;
        const nextStart = clamp(dragRef.current.startStart + deltaSeconds, 0, Math.max(durationSeconds - span, 0));
        const nextEnd = nextStart + span;

        setStart(secondsToTimestamp(nextStart));
        setEnd(secondsToTimestamp(nextEnd));
        return;
      }

      if (dragRef.current.mode === 'start') {
        const nextStart = clamp(dragRef.current.startStart + deltaSeconds, 0, Math.max(dragRef.current.startEnd - 0.1, 0));
        setStart(secondsToTimestamp(nextStart));
        return;
      }

      const nextEnd = clamp(dragRef.current.startEnd + deltaSeconds, dragRef.current.startStart + 0.1, durationSeconds);
      setEnd(secondsToTimestamp(nextEnd));
    }

    function handlePointerUp() {
      if (!dragRef.current.active) {
        return;
      }

      dragRef.current = { active: false };

      if (snapToKeyframes && videoCodec === 'copy' && keyframes.length) {
        snapSelectionToKeyframes();
      }
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [durationSeconds, keyframes, snapToKeyframes, videoCodec, selectionStartSeconds, selectionEndSeconds]);

  useEffect(() => {
    const nativeUnlistenFns: Array<() => void> = [];

    function applyDropDebug(
      source: DropDebugState['source'],
      lastEvent: DropDebugState['lastEvent'],
      paths: string[] = [],
      detail = ''
    ) {
      setDropDebug({
        lastEvent,
        pathCount: paths.length,
        firstPath: paths[0] || '',
        timestamp: new Date().toISOString(),
        source,
        detail
      });
    }

    function processDroppedPaths(paths: string[]) {
      const uniqueDroppedPaths = uniquePaths(paths);
      if (!uniqueDroppedPaths.length) {
        return;
      }

      const now = Date.now();
      const signature = uniqueDroppedPaths.join('|');
      if (lastDropRef.current.signature === signature && now - lastDropRef.current.at < 1200) {
        return;
      }

      lastDropRef.current = { signature, at: now };
      handleDroppedPaths(uniqueDroppedPaths);
    }

    function handleNativeEvent(eventType: DropDebugState['lastEvent'], payload?: DragDropPayload, detail = '') {
      const paths = payload?.paths ?? [];

      if (eventType === 'enter') {
        setIsDropTargetActive(true);
        applyDropDebug('window', 'enter', paths, detail);
        return;
      }

      if (eventType === 'over') {
        setDropDebug((current) => ({
          ...current,
          lastEvent: 'over',
          timestamp: new Date().toISOString(),
          source: 'window',
          detail
        }));
        return;
      }

      if (eventType === 'leave') {
        setIsDropTargetActive(false);
        applyDropDebug('window', 'leave', [], detail);
        return;
      }

      setIsDropTargetActive(false);
      applyDropDebug('window', 'drop', paths, detail);

      processDroppedPaths(paths);
    }

    async function bindDragDropListener() {
      const currentWindow = getCurrentWindow();

      const bindings = await Promise.allSettled([
        currentWindow.onDragDropEvent((event) => {
          handleNativeEvent(event.payload.type, event.payload.type === 'leave' ? undefined : event.payload, 'Tauri Window drag/drop event');
        })
      ]);

      const bindingNames = ['window'];
      const successBindings: string[] = [];
      const failedBindings: string[] = [];

      bindings.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          nativeUnlistenFns.push(result.value);
          successBindings.push(bindingNames[index]);
          return;
        }

        failedBindings.push(`${bindingNames[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      });

      nativeDropEnabledRef.current = successBindings.length > 0;

      setDropDebug((current) => ({
        ...current,
        timestamp: new Date().toISOString(),
        detail: [
          successBindings.length ? `Bound native listeners: ${successBindings.join(', ')}` : '',
          failedBindings.length ? `Failed listeners: ${failedBindings.join(' | ')}` : ''
        ]
          .filter(Boolean)
          .join(' || ') || 'No native drag/drop listeners were bound.'
      }));
    }

    void bindDragDropListener().catch((error) => {
      setDropDebug((current) => ({
        ...current,
        timestamp: new Date().toISOString(),
        detail: `Native drag/drop setup failed: ${error instanceof Error ? error.message : String(error)}`
      }));
    });

    function handleDomDragEnter(event: DragEvent) {
      if (!isFileDrag(event.dataTransfer)) {
        return;
      }

      event.preventDefault();

      if (nativeDropEnabledRef.current) {
        return;
      }

      domDragDepthRef.current += 1;
      setIsDropTargetActive(true);
      applyDropDebug('dom', 'enter', [], describeDataTransfer(event.dataTransfer));
    }

    function handleDomDragOver(event: DragEvent) {
      if (!isFileDrag(event.dataTransfer)) {
        return;
      }

      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }

      if (nativeDropEnabledRef.current) {
        return;
      }

      setDropDebug((current) => ({
        ...current,
        lastEvent: 'over',
        timestamp: new Date().toISOString(),
        source: 'dom',
        detail: describeDataTransfer(event.dataTransfer)
      }));
    }

    function handleDomDragLeave(event: DragEvent) {
      if (!isFileDrag(event.dataTransfer)) {
        return;
      }

      event.preventDefault();

      if (nativeDropEnabledRef.current) {
        return;
      }

      domDragDepthRef.current = Math.max(0, domDragDepthRef.current - 1);

      if (domDragDepthRef.current === 0) {
        setIsDropTargetActive(false);
        applyDropDebug('dom', 'leave', [], describeDataTransfer(event.dataTransfer));
      }
    }

    function handleDomDrop(event: DragEvent) {
      if (!isFileDrag(event.dataTransfer)) {
        return;
      }

      event.preventDefault();
      domDragDepthRef.current = 0;
      setIsDropTargetActive(false);

      if (nativeDropEnabledRef.current) {
        return;
      }

      const paths = extractDroppedPaths(event.dataTransfer);
      applyDropDebug('dom', 'drop', paths, describeDataTransfer(event.dataTransfer));
      processDroppedPaths(paths);
    }

    window.addEventListener('dragenter', handleDomDragEnter, true);
    window.addEventListener('dragover', handleDomDragOver, true);
    window.addEventListener('dragleave', handleDomDragLeave, true);
    window.addEventListener('drop', handleDomDrop, true);

    return () => {
      domDragDepthRef.current = 0;
      setIsDropTargetActive(false);
      nativeUnlistenFns.forEach((unlisten) => {
        try {
          unlisten();
        } catch {
        }
      });
      window.removeEventListener('dragenter', handleDomDragEnter, true);
      window.removeEventListener('dragover', handleDomDragOver, true);
      window.removeEventListener('dragleave', handleDomDragLeave, true);
      window.removeEventListener('drop', handleDomDrop, true);
    };
  }, []);

  function addJob(kind: JobRecord['kind'], source: string, output: string, detail: string) {
    const id = `${kind}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const nextJob: JobRecord = {
      id,
      kind,
      source,
      output,
      status: 'Running',
      startedAt: new Date().toISOString(),
      detail
    };

    setJobs((current) => [nextJob, ...current].slice(0, 12));
    return id;
  }

  function updateJob(id: string, statusValue: JobRecord['status'], detail: string) {
    setJobs((current) =>
      current.map((job) =>
        job.id === id
          ? {
              ...job,
              status: statusValue,
              detail
            }
          : job
      )
    );
  }

  function addBatchFiles(paths: string[]) {
    setBatchFiles((current) => uniquePaths([...current, ...paths]));
  }

  function handleDroppedPaths(paths: string[]) {
    const [firstPath] = paths;
    if (!firstPath) {
      return;
    }

    switch (activeToolRef.current) {
      case 'smart-convert':
        void loadConvertFile(firstPath);
        return;
      case 'audio-lab':
        void loadAudioFile(firstPath);
        return;
      case 'image-sequence':
        void loadFrameFile(firstPath);
        return;
      case 'batch-pipeline':
        addBatchFiles(paths);
        return;
      default:
        void loadLosslessFile(firstPath);
    }
  }

  function resetLosslessPreviewElement() {
    if (!videoRef.current) {
      return;
    }

    try {
      videoRef.current.pause();
      videoRef.current.removeAttribute('src');
      videoRef.current.load();
    } catch {
    }
  }

  async function loadLosslessFile(selectedPath: string) {
    const requestId = ++losslessLoadRequestRef.current;
    const extension = extensionFromPath(selectedPath);
    const suggestedOutput = replaceExtension(selectedPath, '_trim', extension);

    setError('');
    setIsBusy(true);
    setStatus('Loading...');
    setLastLog('');
    setProbe(null);
    setKeyframes([]);
    setPreviewTime(0);
    setStart('00:00:00');
    setEnd('00:00:00');
    resetLosslessPreviewElement();
    setSourcePath(selectedPath);
    setOutputPath(suggestedOutput);
    setManualSourcePath(selectedPath);

    try {
      const result = await invoke<ProbeResult>('probe_media', { filePath: selectedPath });

      if (requestId !== losslessLoadRequestRef.current) {
        return;
      }

      const duration = Number(result.format?.duration || 0);
      const initialEnd = secondsToTimestamp(duration);

      setProbe(result);
      setStart('00:00:00');
      setEnd(initialEnd);
      setPreviewTime(0);
      setStatus('Ready');
    } catch (caughtError) {
      if (requestId !== losslessLoadRequestRef.current) {
        return;
      }

      const message = errorMessageFromUnknown(caughtError, 'Analysis failed');
      setError(message);
      setStatus('Error');
    } finally {
      if (requestId === losslessLoadRequestRef.current) {
        setIsBusy(false);
      }
    }

    void invoke<{ keyframes: number[] }>('probe_keyframes', { filePath: selectedPath })
      .then((keyframeProbe) => {
        if (requestId !== losslessLoadRequestRef.current) {
          return;
        }

        setKeyframes(keyframeProbe.keyframes || []);
      })
      .catch(() => {
        if (requestId !== losslessLoadRequestRef.current) {
          return;
        }

        setKeyframes([]);
      });
  }

  async function loadConvertFile(selectedPath: string) {
    setConvertError('');
    setIsConvertBusy(true);
    setConvertStatus('Loading...');

    try {
      const result = await invoke<ProbeResult>('probe_media', { filePath: selectedPath });
      setConvertSourcePath(selectedPath);
      setConvertProbe(result);
      setConvertOutputPath(replaceExtension(selectedPath, '_convert', convertContainerRef.current));
      setConvertStatus('Ready');
      setConvertLog('');
    } catch (caughtError) {
      const message = errorMessageFromUnknown(caughtError, 'Analysis failed');
      setConvertError(message);
      setConvertStatus('Error');
    } finally {
      setIsConvertBusy(false);
    }
  }

  async function loadAudioFile(selectedPath: string) {
    setAudioError('');
    setIsAudioBusy(true);
    setAudioStatus('Loading...');

    try {
      const result = await invoke<ProbeResult>('probe_media', { filePath: selectedPath });
      const preferredExtension = audioCodecSetting === 'copy' ? extensionFromPath(selectedPath) : audioCodecSetting === 'flac' ? 'flac' : audioCodecSetting === 'mp3' ? 'mp3' : audioCodecSetting === 'pcm_s16le' ? 'wav' : 'm4a';
      setAudioSourcePath(selectedPath);
      setAudioProbe(result);
      setAudioOutputPath(replaceExtension(selectedPath, '_audio', preferredExtension));
      setManualAudioPath(selectedPath);
      setAudioStatus('Ready');
      setAudioLog('');
    } catch (caughtError) {
      const message = errorMessageFromUnknown(caughtError, 'Analysis failed');
      setAudioError(message);
      setAudioStatus('Error');
    } finally {
      setIsAudioBusy(false);
    }
  }

  async function loadFrameFile(selectedPath: string) {
    setFrameError('');
    setIsFrameBusy(true);
    setFrameStatus('Loading...');

    try {
      const result = await invoke<ProbeResult>('probe_media', { filePath: selectedPath });
      const baseDirectory = directoryFromPath(selectedPath);
      const baseName = stripExtension(fileNameFromPath(selectedPath));
      setFrameSourcePath(selectedPath);
      setFrameProbe(result);
      setFrameOutputDir(joinPath(baseDirectory, `${baseName}_frames`, selectedPath));
      setManualFramePath(selectedPath);
      setFrameStatus('Ready');
      setFrameLog('');
    } catch (caughtError) {
      const message = errorMessageFromUnknown(caughtError, 'Analysis failed');
      setFrameError(message);
      setFrameStatus('Error');
    } finally {
      setIsFrameBusy(false);
    }
  }

  async function handleOpenFile() {
    try {
      const selectedPath = await invoke<string | null>('open_file');

      if (!selectedPath) {
        return;
      }

      void loadLosslessFile(selectedPath);
    } catch {
    }
  }

  async function handleLoadManualSourcePath() {
    if (!manualSourcePath.trim()) {
      setError('Please enter a file path first.');
      return;
    }

    void loadLosslessFile(manualSourcePath.trim());
  }

  async function handlePickOutput() {
    if (!sourcePath) {
      return;
    }

    const selectedOutput = await invoke<string | null>('save_file', { sourcePath, extension: outputExtension, suffix: '_trim' });
    if (selectedOutput) {
      setOutputPath(selectedOutput);
    }
  }

  async function handleRunLosslessCut() {
    if (!ffmpegReady) {
      setError('ffmpeg and ffprobe must be available before running jobs.');
      return;
    }

    if (!sourcePath || !outputPath) {
      setError('Please choose a source file and an output path first.');
      return;
    }

    const startSeconds = timestampToSeconds(start);
    const endSeconds = timestampToSeconds(end);

    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      setError('In and out values are invalid.');
      return;
    }

    setError('');
    setIsBusy(true);
    setStatus('Running...');
    const jobId = addJob('cut', sourcePath, outputPath, `${start} -> ${end}`);

    try {
      const result = await invoke<{ command: string; log: string }>('run_lossless_cut', {
        sourcePath,
        outputPath,
        start,
        end,
        videoCodec,
        audioCodec
      });

      setStatus('Done');
      setLastLog(`${result.command}\n\n${result.log}`.trim());
      updateJob(jobId, 'Done', `${start} -> ${end}`);
    } catch (caughtError) {
      const message = errorMessageFromUnknown(caughtError, 'FFmpeg failed');
      setError(message);
      setStatus('Error');
      updateJob(jobId, 'Error', message);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleOpenConvertFile() {
    try {
      const selectedPath = await invoke<string | null>('open_file');
      if (!selectedPath) {
        return;
      }

      void loadConvertFile(selectedPath);
    } catch {
    }
  }

  async function handleLoadManualConvertPath() {
    if (!manualConvertPath.trim()) {
      setConvertError('Please enter a file path first.');
      return;
    }

    void loadConvertFile(manualConvertPath.trim());
  }

  async function handlePickConvertOutput() {
    if (!convertSourcePath) {
      return;
    }

    const selectedOutput = await invoke<string | null>('save_file', {
      sourcePath: convertSourcePath,
      extension: convertContainer,
      suffix: '_convert'
    });

    if (selectedOutput) {
      setConvertOutputPath(selectedOutput);
    }
  }

  async function handleRunConvert() {
    if (!ffmpegReady) {
      setConvertError('ffmpeg and ffprobe must be available before running jobs.');
      return;
    }

    if (!convertSourcePath || !convertOutputPath) {
      setConvertError('Please choose a source file and an output path first.');
      return;
    }

    setConvertError('');
    setIsConvertBusy(true);
    setConvertStatus('Running...');
    const jobId = addJob('convert', convertSourcePath, convertOutputPath, `${convertContainer} ${convertVideoCodec}/${convertAudioCodec}`);

    try {
      const result = await invoke<{ command: string; log: string }>('run_convert', {
        sourcePath: convertSourcePath,
        outputPath: convertOutputPath,
        videoCodec: convertVideoCodec,
        audioCodec: convertAudioCodec,
        videoBitrate: convertVideoBitrate,
        audioBitrate: convertAudioBitrate
      });

      setConvertStatus('Done');
      setConvertLog(`${result.command}\n\n${result.log}`.trim());
      updateJob(jobId, 'Done', `${convertContainer} ${convertVideoCodec}/${convertAudioCodec}`);
    } catch (caughtError) {
      const message = errorMessageFromUnknown(caughtError, 'FFmpeg failed');
      setConvertError(message);
      setConvertStatus('Error');
      updateJob(jobId, 'Error', message);
    } finally {
      setIsConvertBusy(false);
    }
  }

  async function handleOpenAudioFile() {
    try {
      const selectedPath = await invoke<string | null>('open_file');
      if (!selectedPath) {
        return;
      }

      void loadAudioFile(selectedPath);
    } catch {
    }
  }

  async function handleLoadManualAudioPath() {
    if (!manualAudioPath.trim()) {
      setAudioError('Please enter a file path first.');
      return;
    }

    void loadAudioFile(manualAudioPath.trim());
  }

  async function handlePickAudioOutput() {
    if (!audioSourcePath) {
      return;
    }

    const audioExtension =
      audioCodecSetting === 'copy'
        ? extensionFromPath(audioSourcePath)
        : audioCodecSetting === 'flac'
          ? 'flac'
          : audioCodecSetting === 'mp3'
            ? 'mp3'
            : audioCodecSetting === 'pcm_s16le'
              ? 'wav'
              : 'm4a';

    const selectedOutput = await invoke<string | null>('save_file', {
      sourcePath: audioSourcePath,
      extension: audioExtension,
      suffix: '_audio'
    });

    if (selectedOutput) {
      setAudioOutputPath(selectedOutput);
    }
  }

  async function handleRunAudioExport() {
    if (!ffmpegReady) {
      setAudioError('ffmpeg and ffprobe must be available before running jobs.');
      return;
    }

    if (!audioSourcePath || !audioOutputPath) {
      setAudioError('Please choose a source file and an output path first.');
      return;
    }

    setAudioError('');
    setIsAudioBusy(true);
    setAudioStatus('Running...');
    const jobId = addJob('audio', audioSourcePath, audioOutputPath, `${audioCodecSetting} ${audioBitrateSetting || 'default'}`);

    try {
      const result = await invoke<{ command: string; log: string }>('run_audio_export', {
        sourcePath: audioSourcePath,
        outputPath: audioOutputPath,
        audioCodec: audioCodecSetting,
        audioBitrate: audioBitrateSetting,
        sampleRate: audioSampleRate,
        channels: audioChannels
      });

      setAudioStatus('Done');
      setAudioLog(`${result.command}\n\n${result.log}`.trim());
      updateJob(jobId, 'Done', `${audioCodecSetting} ${audioBitrateSetting || 'default'}`);
    } catch (caughtError) {
      const message = errorMessageFromUnknown(caughtError, 'FFmpeg failed');
      setAudioError(message);
      setAudioStatus('Error');
      updateJob(jobId, 'Error', message);
    } finally {
      setIsAudioBusy(false);
    }
  }

  async function handleOpenFrameFile() {
    try {
      const selectedPath = await invoke<string | null>('open_file');
      if (!selectedPath) {
        return;
      }

      void loadFrameFile(selectedPath);
    } catch {
    }
  }

  async function handleLoadManualFramePath() {
    if (!manualFramePath.trim()) {
      setFrameError('Please enter a file path first.');
      return;
    }

    void loadFrameFile(manualFramePath.trim());
  }

  async function handlePickFrameOutputDir() {
    const selectedFolder = await invoke<string | null>('pick_folder');
    if (selectedFolder) {
      setFrameOutputDir(selectedFolder);
    }
  }

  async function handleRunFrameExport() {
    if (!ffmpegReady) {
      setFrameError('ffmpeg and ffprobe must be available before running jobs.');
      return;
    }

    if (!frameSourcePath || !frameOutputDir) {
      setFrameError('Please choose a source file and an output folder first.');
      return;
    }

    setFrameError('');
    setIsFrameBusy(true);
    setFrameStatus('Running...');
    const jobId = addJob('frames', frameSourcePath, frameOutputDir, `${frameImageFormat} @ ${frameFps || 'native'} fps`);

    try {
      const result = await invoke<{ command: string; log: string }>('run_frame_export', {
        sourcePath: frameSourcePath,
        outputDir: frameOutputDir,
        imageFormat: frameImageFormat,
        fps: frameFps,
        quality: frameQuality,
        startNumber: Number(frameStartNumber || 1)
      });

      setFrameStatus('Done');
      setFrameLog(`${result.command}\n\n${result.log}`.trim());
      updateJob(jobId, 'Done', `${frameImageFormat} @ ${frameFps || 'native'} fps`);
    } catch (caughtError) {
      const message = errorMessageFromUnknown(caughtError, 'FFmpeg failed');
      setFrameError(message);
      setFrameStatus('Error');
      updateJob(jobId, 'Error', message);
    } finally {
      setIsFrameBusy(false);
    }
  }

  async function handleAddBatchFiles() {
    try {
      const selectedPaths = await invoke<string[]>('open_files');
      if (!selectedPaths.length) {
        return;
      }

      addBatchFiles(selectedPaths);
      setBatchError('');
    } catch {
    }
  }

  function handleClearBatchFiles() {
    setBatchFiles([]);
    setBatchLog('');
    setBatchError('');
    setBatchStatus('Idle');
  }

  async function handleRunBatchConvert() {
    if (!ffmpegReady) {
      setBatchError('ffmpeg and ffprobe must be available before running jobs.');
      return;
    }

    if (!batchFiles.length) {
      setBatchError('Please add at least one file to the batch list.');
      return;
    }

    setBatchError('');
    setIsBatchBusy(true);
    setBatchStatus('Running...');
    const firstFile = batchFiles[0];
    const batchOutputPreview = replaceExtension(firstFile, '_batch_convert', batchContainer);
    const jobId = addJob('batch', firstFile, batchOutputPreview, `${batchFiles.length} files`);

    try {
      const result = await invoke<{ commands: string[]; outputs: string[]; log: string }>('run_batch_convert', {
        sourcePaths: batchFiles,
        container: batchContainer,
        videoCodec: batchVideoCodec,
        audioCodec: batchAudioCodec,
        videoBitrate: batchVideoBitrate,
        audioBitrate: batchAudioBitrate
      });

      const combinedCommands = result.commands.join('\n\n');
      setBatchStatus('Done');
      setBatchLog(`${combinedCommands}\n\n${result.log}`.trim());
      updateJob(jobId, 'Done', `${result.outputs.length} outputs`);
    } catch (caughtError) {
      const message = errorMessageFromUnknown(caughtError, 'FFmpeg failed');
      setBatchError(message);
      setBatchStatus('Error');
      updateJob(jobId, 'Error', message);
    } finally {
      setIsBatchBusy(false);
    }
  }

  function startDrag(mode: 'move' | 'start' | 'end', clientX: number) {
    if (durationSeconds <= 0) {
      return;
    }

    dragRef.current = {
      active: true,
      mode,
      startX: clientX,
      startStart: selectionStartSeconds,
      startEnd: selectionEndSeconds
    };
  }

  function handleSelectionPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    startDrag('move', event.clientX);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleHandlePointerDown(mode: 'start' | 'end', event: React.PointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    startDrag(mode, event.clientX);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleTimelineClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!timelineTrackRef.current || durationSeconds <= 0) {
      return;
    }

    const trackRect = timelineTrackRef.current.getBoundingClientRect();
    const clickFraction = clamp((event.clientX - trackRect.left) / trackRect.width, 0, 1);
    const clickTime = clickFraction * durationSeconds;
    const span = selectionSpan || durationSeconds;
    const nextStart = clamp(clickTime - span / 2, 0, Math.max(durationSeconds - span, 0));
    const nextEnd = clamp(nextStart + span, 0, durationSeconds);

    setStart(secondsToTimestamp(nextStart));
    setEnd(secondsToTimestamp(nextEnd));
  }

  function snapSelectionToKeyframes() {
    if (!keyframes.length || durationSeconds <= 0) {
      return;
    }

    const snappedStart = clamp(nearestKeyframe(selectionStartSeconds, keyframes), 0, durationSeconds);
    const snappedEnd = clamp(nearestKeyframe(selectionEndSeconds, keyframes), snappedStart + 0.1, durationSeconds);
    setStart(secondsToTimestamp(snappedStart));
    setEnd(secondsToTimestamp(snappedEnd));
  }

  function setPreviewAsBoundary(boundary: 'start' | 'end') {
    if (durationSeconds <= 0) {
      return;
    }

    const clampedPreview = clamp(previewTime, 0, durationSeconds);
    if (boundary === 'start') {
      const rawStart = Math.min(clampedPreview, Math.max(selectionEndSeconds - 0.1, 0));
      const nextStart = snapToKeyframes && keyframes.length ? nearestKeyframe(rawStart, keyframes) : rawStart;
      setStart(secondsToTimestamp(clamp(nextStart, 0, Math.max(selectionEndSeconds - 0.1, 0))));
      return;
    }

    const rawEnd = Math.max(clampedPreview, selectionStartSeconds + 0.1);
    const nextEnd = snapToKeyframes && keyframes.length ? nearestKeyframe(rawEnd, keyframes) : rawEnd;
    setEnd(secondsToTimestamp(clamp(nextEnd, selectionStartSeconds + 0.1, durationSeconds)));
  }

  function renderToolStatus() {
    if (isCheckingToolStatus) {
      return null;
    }

    const ffmpegStatus = toolStatus?.ffmpeg;
    const ffprobeStatus = toolStatus?.ffprobe;
    const ready = Boolean(ffmpegStatus?.available && ffprobeStatus?.available);

    if (ready) {
      return null;
    }

    return (
      <section className={`startup-panel${ready ? '' : ' warning'}`}>
        <div className="startup-row">
          <strong>Environment</strong>
          <span>{ready ? 'Ready' : 'Setup required'}</span>
        </div>
        <div className="startup-grid">
          <div>
            <span>ffmpeg</span>
            <strong>{ffmpegStatus?.available ? ffmpegStatus.version : ffmpegStatus?.error || 'Not found'}</strong>
          </div>
          <div>
            <span>ffprobe</span>
            <strong>{ffprobeStatus?.available ? ffprobeStatus.version : ffprobeStatus?.error || 'Not found'}</strong>
          </div>
        </div>
        {!ready ? (
          <p className="setup-note">
            Install FFmpeg so both <code>ffmpeg</code> and <code>ffprobe</code> are available on the system PATH, then restart the app.
          </p>
        ) : null}
      </section>
    );
  }

  function renderJobs() {
    const jobLabel: Record<JobRecord['kind'], string> = {
      cut: 'Lossless Cut',
      convert: 'Convert',
      audio: 'Audio',
      frames: 'Frames',
      batch: 'Batch'
    };

    return (
      <section className="jobs-panel">
        <div className="section-header">
          <h3>Jobs</h3>
          <span>{jobs.length}</span>
        </div>
        {jobs.length ? (
          <div className="job-list">
            {jobs.map((job) => (
              <div key={job.id} className={`job-row status-${job.status.toLowerCase()}`}>
                <div>
                  <strong>{jobLabel[job.kind]}</strong>
                  <span>{fileNameFromPath(job.source)}</span>
                </div>
                <div>
                  <strong>{job.status}</strong>
                  <span>{job.detail}</span>
                </div>
                <div>
                  <strong>{fileNameFromPath(job.output)}</strong>
                  <span>{formatDateTime(job.startedAt)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-jobs">No jobs yet.</div>
        )}
      </section>
    );
  }

  function renderDropDebug() {
    return (
      <section className="debug-panel">
          <div className="section-header">
            <h3>Drop Debug</h3>
            <span>{dropDebug.lastEvent}</span>
          </div>
        <div className="debug-grid">
          <div>
            <span>Last event</span>
            <strong>{dropDebug.lastEvent}</strong>
          </div>
          <div>
            <span>Source</span>
            <strong>{dropDebug.source}</strong>
          </div>
          <div>
            <span>Paths</span>
            <strong>{dropDebug.pathCount}</strong>
          </div>
          <div>
            <span>First path</span>
            <strong>{dropDebug.firstPath || '-'}</strong>
          </div>
          <div>
            <span>Timestamp</span>
            <strong>{dropDebug.timestamp ? formatDateTime(dropDebug.timestamp) : '-'}</strong>
          </div>
          <div>
            <span>Detail</span>
            <strong>{dropDebug.detail || '-'}</strong>
          </div>
          <div>
            <span>Build</span>
            <strong>{buildId}</strong>
          </div>
        </div>
      </section>
    );
  }

  function renderLosslessCut() {
    return (
      <>
        <section className="panel panel-grid">
          <div className="panel-block viewer-block">
            <div className="section-header">
              <h3>Source</h3>
              <span>{sourcePath ? fileNameFromPath(sourcePath) : 'No file loaded'}</span>
            </div>

            <div className="video-preview-shell">
              {sourcePath ? (
                <video
                  key={videoPreviewUrl}
                  ref={videoRef}
                  className="video-preview"
                  src={videoPreviewUrl}
                  controls
                  preload="metadata"
                  onLoadedMetadata={(event) => {
                    const nextTime = clamp(selectionStartSeconds, 0, event.currentTarget.duration || selectionStartSeconds);
                    event.currentTarget.currentTime = nextTime;
                    setPreviewTime(nextTime);
                  }}
                  onTimeUpdate={(event) => setPreviewTime(event.currentTarget.currentTime)}
                  onError={() => {
                    setError('Preview could not be loaded for this file.');
                    setStatus('Preview error');
                  }}
                />
              ) : (
                <button type="button" className="viewer-placeholder quick-load" onClick={handleOpenFile}>
                  <strong>Click to open a file</strong>
                  <span>Drag and drop may be blocked by Windows. Use click or paste a path below.</span>
                </button>
              )}
            </div>

            <div className="manual-load-row">
              <input
                value={manualSourcePath}
                onChange={(event) => setManualSourcePath(event.target.value)}
                placeholder="Paste a local file path"
              />
              <button type="button" className="button" onClick={handleLoadManualSourcePath} disabled={isBusy}>
                Load Path
              </button>
            </div>

            <div className="preview-toolbar">
              <strong>{secondsToTimestamp(previewTime)}</strong>
              <div className="preview-actions">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={snapToKeyframes}
                    onChange={(event) => setSnapToKeyframes(event.target.checked)}
                    disabled={!keyframes.length}
                  />
                  <span>Snap to keyframes</span>
                </label>
                <button type="button" className="button" onClick={() => setPreviewAsBoundary('start')} disabled={!sourcePath}>
                  Set In
                </button>
                <button type="button" className="button" onClick={() => setPreviewAsBoundary('end')} disabled={!sourcePath}>
                  Set Out
                </button>
                <button type="button" className="button" onClick={snapSelectionToKeyframes} disabled={!keyframes.length}>
                  Snap Now
                </button>
              </div>
            </div>

            <div ref={timelineTrackRef} className="timeline-strip interactive" onClick={handleTimelineClick}>
              <div className="timeline-playhead" style={{ left: `${previewPercent}%` }} />
              {durationSeconds > 0
                ? keyframes.map((keyframe) => (
                    <div key={keyframe} className="timeline-keyframe" style={{ left: `${(keyframe / durationSeconds) * 100}%` }} />
                  ))
                : null}
              <div
                className="timeline-selection draggable"
                style={{ left: `${selectionLeftPercent}%`, width: `${selectionWidthPercent}%` }}
                onPointerDown={handleSelectionPointerDown}
              >
                <div className="timeline-handle start" onPointerDown={(event) => handleHandlePointerDown('start', event)} />
                <div className="timeline-selection-body" />
                <div className="timeline-handle end" onPointerDown={(event) => handleHandlePointerDown('end', event)} />
              </div>
            </div>

            <div className="time-fields">
              <label>
                <span>In</span>
                <input value={start} onChange={(event) => setStart(event.target.value)} placeholder="00:00:00" />
              </label>
              <label>
                <span>Out</span>
                <input value={end} onChange={(event) => setEnd(event.target.value)} placeholder="00:00:00" />
              </label>
              <label>
                <span>Duration</span>
                <input value={durationLabel} readOnly />
              </label>
            </div>

            <div className="path-list">
              <div>
                <span>Source</span>
                <strong>{sourcePath || '-'}</strong>
              </div>
              <div>
                <span>Output</span>
                <strong>{outputPath || '-'}</strong>
              </div>
            </div>
          </div>

          <div className="panel-block settings-block">
            <div className="section-header">
              <h3>Settings</h3>
              <span>{status}</span>
            </div>

            <div className="form-grid">
              <label>
                <span>Preset</span>
                <select value={preset} onChange={(event) => setPreset(event.target.value)}>
                  {presets.map((entry) => (
                    <option key={entry.id} value={entry.name}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Container</span>
                <input value={outputExtension} readOnly />
              </label>
              <label>
                <span>Video</span>
                <select value={videoCodec} onChange={(event) => setVideoCodec(event.target.value)}>
                  <option value="copy">copy</option>
                </select>
              </label>
              <label>
                <span>Audio</span>
                <select value={audioCodec} onChange={(event) => setAudioCodec(event.target.value)}>
                  <option value="copy">copy</option>
                  <option value="aac">aac</option>
                </select>
              </label>
            </div>

            <div className="status-list compact-list">
              <div>
                <span>Format</span>
                <strong>{probe?.format?.format_long_name || '-'}</strong>
              </div>
              <div>
                <span>Video</span>
                <strong>
                  {videoStream?.codec_name
                    ? `${videoStream.codec_name}${videoStream.width ? ` ${videoStream.width}x${videoStream.height}` : ''}`
                    : '-'}
                </strong>
              </div>
              <div>
                <span>Audio</span>
                <strong>
                  {audioStream?.codec_name
                    ? `${audioStream.codec_name}${audioStream.channels ? ` ${audioStream.channels}ch` : ''}`
                    : '-'}
                </strong>
              </div>
              <div>
                <span>Keyframes</span>
                <strong>{keyframes.length ? `${keyframes.length} indexed` : 'No video keyframes loaded'}</strong>
              </div>
            </div>

            <div className="command-box">{commandPreview}</div>

            {error ? <div className="message error">{error}</div> : null}
            {lastLog ? <pre className="log-box">{lastLog}</pre> : null}
          </div>
        </section>
      </>
    );
  }

  function renderConvert() {
    return (
      <>
        <section className="panel panel-grid">
          <div className="panel-block viewer-block">
            <div className="section-header">
              <h3>Source</h3>
              <span>{convertSourcePath ? fileNameFromPath(convertSourcePath) : 'No file loaded'}</span>
            </div>

            <div className="viewer-placeholder compact-placeholder">
              {convertSourcePath ? (
                <span>File loaded</span>
              ) : (
                <button type="button" className="viewer-placeholder quick-load" onClick={handleOpenConvertFile}>
                  <strong>Click to open a file</strong>
                  <span>Drag and drop may be blocked by Windows. Use click or paste a path below.</span>
                </button>
              )}
            </div>

            <div className="manual-load-row">
              <input
                value={manualConvertPath}
                onChange={(event) => setManualConvertPath(event.target.value)}
                placeholder="Paste a local file path"
              />
              <button type="button" className="button" onClick={handleLoadManualConvertPath} disabled={isConvertBusy}>
                Load Path
              </button>
            </div>

            <div className="time-fields compact-fields">
              <label>
                <span>Duration</span>
                <input value={convertDurationLabel} readOnly />
              </label>
              <label>
                <span>Format</span>
                <input value={convertProbe?.format?.format_long_name || '-'} readOnly />
              </label>
              <label>
                <span>Container</span>
                <input value={convertContainer} readOnly />
              </label>
            </div>

            <div className="path-list">
              <div>
                <span>Source</span>
                <strong>{convertSourcePath || '-'}</strong>
              </div>
              <div>
                <span>Output</span>
                <strong>{convertOutputPath || '-'}</strong>
              </div>
            </div>
          </div>

          <div className="panel-block settings-block">
            <div className="section-header">
              <h3>Settings</h3>
              <span>{convertStatus}</span>
            </div>

            <div className="form-grid">
              <label>
                <span>Preset</span>
                <select value={convertPreset} onChange={(event) => setConvertPreset(event.target.value)}>
                  {convertPresets.map((entry) => (
                    <option key={entry.id} value={entry.name}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Container</span>
                <select value={convertContainer} onChange={(event) => setConvertContainer(event.target.value)}>
                  <option value="mp4">mp4</option>
                  <option value="mkv">mkv</option>
                  <option value="mov">mov</option>
                  <option value="flac">flac</option>
                  <option value="wav">wav</option>
                </select>
              </label>
              <label>
                <span>Video</span>
                <select value={convertVideoCodec} onChange={(event) => setConvertVideoCodec(event.target.value)}>
                  <option value="mpeg4">mpeg4</option>
                  <option value="ffv1">ffv1</option>
                  <option value="copy">copy</option>
                  <option value="none">none</option>
                </select>
              </label>
              <label>
                <span>Audio</span>
                <select value={convertAudioCodec} onChange={(event) => setConvertAudioCodec(event.target.value)}>
                  <option value="aac">aac</option>
                  <option value="flac">flac</option>
                  <option value="pcm_s16le">pcm_s16le</option>
                  <option value="copy">copy</option>
                  <option value="none">none</option>
                </select>
              </label>
              <label>
                <span>Video bitrate</span>
                <input
                  value={convertVideoBitrate}
                  onChange={(event) => setConvertVideoBitrate(event.target.value)}
                  placeholder="5M"
                  disabled={convertVideoCodec === 'copy' || convertVideoCodec === 'none'}
                />
              </label>
              <label>
                <span>Audio bitrate</span>
                <input
                  value={convertAudioBitrate}
                  onChange={(event) => setConvertAudioBitrate(event.target.value)}
                  placeholder="192k"
                  disabled={convertAudioCodec === 'copy' || convertAudioCodec === 'none'}
                />
              </label>
            </div>

            <div className="status-list compact-list">
              <div>
                <span>Video</span>
                <strong>
                  {convertVideoStream?.codec_name
                    ? `${convertVideoStream.codec_name}${convertVideoStream.width ? ` ${convertVideoStream.width}x${convertVideoStream.height}` : ''}`
                    : '-'}
                </strong>
              </div>
              <div>
                <span>Audio</span>
                <strong>
                  {convertAudioStream?.codec_name
                    ? `${convertAudioStream.codec_name}${convertAudioStream.channels ? ` ${convertAudioStream.channels}ch` : ''}`
                    : '-'}
                </strong>
              </div>
              <div>
                <span>FFmpeg</span>
                <strong>External system installation</strong>
              </div>
            </div>

            <div className="command-box">{convertCommandPreview}</div>

            {convertError ? <div className="message error">{convertError}</div> : null}
            {convertLog ? <pre className="log-box">{convertLog}</pre> : null}
          </div>
        </section>
      </>
    );
  }

  function renderAudio() {
    return (
      <section className="panel panel-grid">
        <div className="panel-block viewer-block">
          <div className="section-header">
            <h3>Source</h3>
            <span>{audioSourcePath ? fileNameFromPath(audioSourcePath) : 'No file loaded'}</span>
          </div>

          <div className="viewer-placeholder compact-placeholder">
            {audioSourcePath ? <span>File loaded</span> : <span>Load a media file to extract or convert audio.</span>}
          </div>

          <div className="manual-load-row">
            <input
              value={manualAudioPath}
              onChange={(event) => setManualAudioPath(event.target.value)}
              placeholder="Paste a local file path"
            />
            <button type="button" className="button" onClick={handleLoadManualAudioPath} disabled={isAudioBusy}>
              Load Path
            </button>
          </div>

          <div className="time-fields compact-fields">
            <label>
              <span>Duration</span>
              <input value={audioDurationLabel} readOnly />
            </label>
            <label>
              <span>Codec</span>
              <input value={audioSourceStream?.codec_name || '-'} readOnly />
            </label>
            <label>
              <span>Rate</span>
              <input value={audioSourceStream?.sample_rate || '-'} readOnly />
            </label>
            <label>
              <span>Channels</span>
              <input value={audioSourceStream?.channels ? String(audioSourceStream.channels) : '-'} readOnly />
            </label>
          </div>

          <div className="path-list">
            <div>
              <span>Source</span>
              <strong>{audioSourcePath || '-'}</strong>
            </div>
            <div>
              <span>Output</span>
              <strong>{audioOutputPath || '-'}</strong>
            </div>
          </div>
        </div>

        <div className="panel-block settings-block">
          <div className="section-header">
            <h3>Settings</h3>
            <span>{audioStatus}</span>
          </div>

          <div className="form-grid">
            <label>
              <span>Codec</span>
              <select value={audioCodecSetting} onChange={(event) => setAudioCodecSetting(event.target.value)}>
                <option value="aac">aac</option>
                <option value="mp3">mp3</option>
                <option value="flac">flac</option>
                <option value="pcm_s16le">pcm_s16le</option>
                <option value="copy">copy</option>
              </select>
            </label>
            <label>
              <span>Bitrate</span>
              <input
                value={audioBitrateSetting}
                onChange={(event) => setAudioBitrateSetting(event.target.value)}
                placeholder="192k"
                disabled={audioCodecSetting === 'copy'}
              />
            </label>
            <label>
              <span>Sample rate</span>
              <input value={audioSampleRate} onChange={(event) => setAudioSampleRate(event.target.value)} placeholder="48000" />
            </label>
            <label>
              <span>Channels</span>
              <select value={audioChannels} onChange={(event) => setAudioChannels(event.target.value)}>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="">keep source</option>
              </select>
            </label>
          </div>

          <div className="command-box">{audioCommandPreview}</div>

          {audioError ? <div className="message error">{audioError}</div> : null}
          {audioLog ? <pre className="log-box">{audioLog}</pre> : null}
        </div>
      </section>
    );
  }

  function renderFrames() {
    return (
      <section className="panel panel-grid">
        <div className="panel-block viewer-block">
          <div className="section-header">
            <h3>Source</h3>
            <span>{frameSourcePath ? fileNameFromPath(frameSourcePath) : 'No file loaded'}</span>
          </div>

          <div className="viewer-placeholder compact-placeholder">
            {frameSourcePath ? <span>Video ready for frame export</span> : <span>Load a video file to export frames.</span>}
          </div>

          <div className="manual-load-row">
            <input
              value={manualFramePath}
              onChange={(event) => setManualFramePath(event.target.value)}
              placeholder="Paste a local file path"
            />
            <button type="button" className="button" onClick={handleLoadManualFramePath} disabled={isFrameBusy}>
              Load Path
            </button>
          </div>

          <div className="time-fields compact-fields">
            <label>
              <span>Duration</span>
              <input value={frameDurationLabel} readOnly />
            </label>
            <label>
              <span>Video</span>
              <input
                value={
                  frameVideoStream?.codec_name
                    ? `${frameVideoStream.codec_name}${frameVideoStream.width ? ` ${frameVideoStream.width}x${frameVideoStream.height}` : ''}`
                    : '-'
                }
                readOnly
              />
            </label>
          </div>

          <div className="path-list">
            <div>
              <span>Source</span>
              <strong>{frameSourcePath || '-'}</strong>
            </div>
            <div>
              <span>Output folder</span>
              <strong>{frameOutputDir || '-'}</strong>
            </div>
          </div>
        </div>

        <div className="panel-block settings-block">
          <div className="section-header">
            <h3>Settings</h3>
            <span>{frameStatus}</span>
          </div>

          <div className="form-grid">
            <label>
              <span>Format</span>
              <select value={frameImageFormat} onChange={(event) => setFrameImageFormat(event.target.value)}>
                <option value="png">png</option>
                <option value="jpg">jpg</option>
                <option value="webp">webp</option>
              </select>
            </label>
            <label>
              <span>FPS</span>
              <input value={frameFps} onChange={(event) => setFrameFps(event.target.value)} placeholder="1" />
            </label>
            <label>
              <span>Quality</span>
              <input
                value={frameQuality}
                onChange={(event) => setFrameQuality(event.target.value)}
                placeholder="2"
                disabled={frameImageFormat === 'png'}
              />
            </label>
            <label>
              <span>Start number</span>
              <input value={frameStartNumber} onChange={(event) => setFrameStartNumber(event.target.value)} placeholder="1" />
            </label>
          </div>

          <div className="command-box">{frameCommandPreview}</div>

          {frameError ? <div className="message error">{frameError}</div> : null}
          {frameLog ? <pre className="log-box">{frameLog}</pre> : null}
        </div>
      </section>
    );
  }

  function renderBatch() {
    return (
      <section className="panel panel-grid">
        <div className="panel-block viewer-block">
          <div className="section-header">
            <h3>Files</h3>
            <span>{batchFiles.length} loaded</span>
          </div>

          {batchFiles.length ? (
            <div className="file-list">
              {batchFiles.map((filePath) => (
                <div key={filePath} className="file-row">
                  <strong>{fileNameFromPath(filePath)}</strong>
                  <span>{filePath}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="viewer-placeholder compact-placeholder">
              <span>Add multiple files to run one shared convert preset.</span>
            </div>
          )}

          <div className="path-list">
            <div>
              <span>Outputs</span>
              <strong>{batchFiles.length ? `${batchFiles.length} files will be written next to the sources` : '-'}</strong>
            </div>
          </div>
        </div>

        <div className="panel-block settings-block">
          <div className="section-header">
            <h3>Settings</h3>
            <span>{batchStatus}</span>
          </div>

          <div className="form-grid">
            <label>
              <span>Preset</span>
              <select value={batchPreset} onChange={(event) => setBatchPreset(event.target.value)}>
                {convertPresets.map((entry) => (
                  <option key={entry.id} value={entry.name}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Container</span>
              <select value={batchContainer} onChange={(event) => setBatchContainer(event.target.value)}>
                <option value="mp4">mp4</option>
                <option value="mkv">mkv</option>
                <option value="mov">mov</option>
                <option value="flac">flac</option>
                <option value="wav">wav</option>
              </select>
            </label>
            <label>
              <span>Video</span>
              <select value={batchVideoCodec} onChange={(event) => setBatchVideoCodec(event.target.value)}>
                <option value="mpeg4">mpeg4</option>
                <option value="ffv1">ffv1</option>
                <option value="copy">copy</option>
                <option value="none">none</option>
              </select>
            </label>
            <label>
              <span>Audio</span>
              <select value={batchAudioCodec} onChange={(event) => setBatchAudioCodec(event.target.value)}>
                <option value="aac">aac</option>
                <option value="flac">flac</option>
                <option value="pcm_s16le">pcm_s16le</option>
                <option value="copy">copy</option>
                <option value="none">none</option>
              </select>
            </label>
            <label>
              <span>Video bitrate</span>
              <input
                value={batchVideoBitrate}
                onChange={(event) => setBatchVideoBitrate(event.target.value)}
                placeholder="5M"
                disabled={batchVideoCodec === 'copy' || batchVideoCodec === 'none'}
              />
            </label>
            <label>
              <span>Audio bitrate</span>
              <input
                value={batchAudioBitrate}
                onChange={(event) => setBatchAudioBitrate(event.target.value)}
                placeholder="192k"
                disabled={batchAudioCodec === 'copy' || batchAudioCodec === 'none'}
              />
            </label>
          </div>

          {batchError ? <div className="message error">{batchError}</div> : null}
          {batchLog ? <pre className="log-box">{batchLog}</pre> : null}
        </div>
      </section>
    );
  }

  function renderPlaceholder() {
    return (
      <section className="panel placeholder-panel">
        <div className="panel-block placeholder-block">
          <div className="section-header">
            <h3>{activeModule.title}</h3>
            <span>Not implemented</span>
          </div>
          <p>{activeModule.description}</p>
        </div>
      </section>
    );
  }

  return (
    <div className="app-shell">
      {isDropTargetActive ? (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-card">
            <strong>Drop file to open</strong>
            <span>
              {activeTool === 'smart-convert'
                ? 'Load into Convert'
                : activeTool === 'audio-lab'
                  ? 'Load into Audio'
                  : activeTool === 'image-sequence'
                    ? 'Load into Frames'
                    : activeTool === 'batch-pipeline'
                      ? 'Add to Batch'
                      : 'Load into Lossless Cut'}
            </span>
          </div>
        </div>
      ) : null}

      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>FFmpeg Forge</h1>
        </div>

        <nav className="module-list" aria-label="Modules">
          {tools.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className={`module-button${tool.id === activeTool ? ' active' : ''}`}
              onClick={() => setActiveTool(tool.id)}
            >
              <span className="module-title">{tool.title}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span>{ffmpegReady ? 'FFmpeg environment ready.' : 'FFmpeg setup required.'}</span>
          <strong>Made with ❤️ by Nordik</strong>
          <span>{buildId}</span>
        </div>
      </aside>

      <main className="workspace">
        {renderToolStatus()}

        <header className="workspace-header">
          <h2>{activeModule.title}</h2>

          <div className="header-actions">
            {activeTool === 'lossless-cut' ? (
              <>
                <button type="button" className="button button-primary" onClick={handleOpenFile} disabled={isBusy}>
                  Open
                </button>
                <button type="button" className="button" onClick={handlePickOutput} disabled={!sourcePath || isBusy}>
                  Output
                </button>
                <button type="button" className="button" onClick={handleRunLosslessCut} disabled={!sourcePath || isBusy || !ffmpegReady}>
                  Run
                </button>
              </>
            ) : null}

            {activeTool === 'smart-convert' ? (
              <>
                <button type="button" className="button button-primary" onClick={handleOpenConvertFile} disabled={isConvertBusy}>
                  Open
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={handlePickConvertOutput}
                  disabled={!convertSourcePath || isConvertBusy}
                >
                  Output
                </button>
                <button type="button" className="button" onClick={handleRunConvert} disabled={!convertSourcePath || isConvertBusy || !ffmpegReady}>
                  Run
                </button>
              </>
            ) : null}

            {activeTool === 'audio-lab' ? (
              <>
                <button type="button" className="button button-primary" onClick={handleOpenAudioFile} disabled={isAudioBusy}>
                  Open
                </button>
                <button type="button" className="button" onClick={handlePickAudioOutput} disabled={!audioSourcePath || isAudioBusy}>
                  Output
                </button>
                <button type="button" className="button" onClick={handleRunAudioExport} disabled={!audioSourcePath || isAudioBusy || !ffmpegReady}>
                  Run
                </button>
              </>
            ) : null}

            {activeTool === 'image-sequence' ? (
              <>
                <button type="button" className="button button-primary" onClick={handleOpenFrameFile} disabled={isFrameBusy}>
                  Open
                </button>
                <button type="button" className="button" onClick={handlePickFrameOutputDir} disabled={isFrameBusy}>
                  Folder
                </button>
                <button type="button" className="button" onClick={handleRunFrameExport} disabled={!frameSourcePath || isFrameBusy || !ffmpegReady}>
                  Run
                </button>
              </>
            ) : null}

            {activeTool === 'batch-pipeline' ? (
              <>
                <button type="button" className="button button-primary" onClick={handleAddBatchFiles} disabled={isBatchBusy}>
                  Add Files
                </button>
                <button type="button" className="button" onClick={handleClearBatchFiles} disabled={!batchFiles.length || isBatchBusy}>
                  Clear
                </button>
                <button type="button" className="button" onClick={handleRunBatchConvert} disabled={!batchFiles.length || isBatchBusy || !ffmpegReady}>
                  Run
                </button>
              </>
            ) : null}
          </div>
        </header>

        {activeTool === 'lossless-cut' ? renderLosslessCut() : null}
        {activeTool === 'smart-convert' ? renderConvert() : null}
        {activeTool === 'audio-lab' ? renderAudio() : null}
        {activeTool === 'image-sequence' ? renderFrames() : null}
        {activeTool === 'batch-pipeline' ? renderBatch() : null}
        {activeTool !== 'lossless-cut' && activeTool !== 'smart-convert' && activeTool !== 'audio-lab' && activeTool !== 'image-sequence' && activeTool !== 'batch-pipeline'
          ? renderPlaceholder()
          : null}

        {renderDropDebug()}
        {renderJobs()}
      </main>
    </div>
  );
}

export default App;
