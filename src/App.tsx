import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
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
  kind: 'cut' | 'convert';
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
  source: 'none' | 'webview' | 'win32';
};

type NativeFileDropPayload = {
  kind: DropDebugState['lastEvent'];
  paths: string[];
  position?: {
    x: number;
    y: number;
  } | null;
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
    description: 'Audio tools are not implemented yet.'
  },
  'image-sequence': {
    title: 'Frames',
    description: 'Frame export tools are not implemented yet.'
  },
  'batch-pipeline': {
    title: 'Batch',
    description: 'Batch processing is not implemented yet.'
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

function extensionFromPath(filePath: string) {
  const match = /\.([^.]+)$/.exec(filePath);
  return match?.[1]?.toLowerCase() || 'mp4';
}

function replaceExtension(filePath: string, suffix: string, extension: string) {
  return filePath.replace(/\.[^.]+$/, `${suffix}.${extension}`);
}

function filePathToVideoUrl(filePath: string) {
  if (!filePath) {
    return '';
  }

  const normalized = filePath.replaceAll('\\', '/');
  return `file:///${encodeURI(normalized)}`;
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

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }

  return date.toLocaleString();
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
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [isDropTargetActive, setIsDropTargetActive] = useState(false);
  const [dropDebug, setDropDebug] = useState<DropDebugState>({
    lastEvent: 'idle',
    pathCount: 0,
    firstPath: '',
    timestamp: '',
    source: 'none'
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timelineTrackRef = useRef<HTMLDivElement | null>(null);
  const lastDropRef = useRef<{ path: string; at: number }>({ path: '', at: 0 });
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

  useEffect(() => {
    void invoke<ToolStatus>('check_tool_status').then(setToolStatus).catch(() => {
      setToolStatus(null);
    });
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
    let unlistenWebview: undefined | (() => void);
    let unlistenFallback: undefined | (() => void);

    function applyDropDebug(
      source: DropDebugState['source'],
      lastEvent: DropDebugState['lastEvent'],
      paths: string[] = []
    ) {
      setDropDebug({
        lastEvent,
        pathCount: paths.length,
        firstPath: paths[0] || '',
        timestamp: new Date().toISOString(),
        source
      });
    }

    function processDroppedPath(filePath: string) {
      if (!filePath) {
        return;
      }

      const now = Date.now();
      if (lastDropRef.current.path === filePath && now - lastDropRef.current.at < 1200) {
        return;
      }

      lastDropRef.current = { path: filePath, at: now };
      handleDroppedPath(filePath);
    }

    async function bindDragDropListener() {
      const currentWebview = getCurrentWebview();
      const currentWebviewWindow = getCurrentWebviewWindow();

      unlistenWebview = await currentWebview.onDragDropEvent((event) => {
        if (event.payload.type === 'enter') {
          setIsDropTargetActive(true);
          applyDropDebug('webview', 'enter', event.payload.paths);
          return;
        }

        if (event.payload.type === 'over') {
          setDropDebug((current) => ({
            ...current,
            lastEvent: 'over',
            timestamp: new Date().toISOString(),
            source: 'webview'
          }));
          return;
        }

        if (event.payload.type === 'leave') {
          setIsDropTargetActive(false);
          applyDropDebug('webview', 'leave');
          return;
        }

        if (event.payload.type === 'drop') {
          setIsDropTargetActive(false);
          applyDropDebug('webview', 'drop', event.payload.paths);
          const [firstPath] = event.payload.paths;

          if (firstPath) {
            processDroppedPath(firstPath);
          }
        }
      });

      unlistenFallback = await currentWebviewWindow.listen<NativeFileDropPayload>('native-file-drop', (event) => {
        if (event.payload.kind !== 'drop') {
          return;
        }

        setIsDropTargetActive(false);
        applyDropDebug('win32', 'drop', event.payload.paths);
        const [firstPath] = event.payload.paths;

        if (firstPath) {
          processDroppedPath(firstPath);
        }
      });
    }

    void bindDragDropListener();

    return () => {
      setIsDropTargetActive(false);
      unlistenWebview?.();
      unlistenFallback?.();
    };
  }, [activeTool, convertContainer]);

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

  function handleDroppedPath(filePath: string) {
    if (!filePath) {
      return;
    }

    if (activeTool === 'smart-convert') {
      void loadConvertFile(filePath);
      return;
    }

    void loadLosslessFile(filePath);
  }

  async function loadLosslessFile(selectedPath: string) {
    setError('');
    setIsBusy(true);
    setStatus('Loading...');

    try {
      const [result, keyframeProbe] = await Promise.all([
        invoke<ProbeResult>('probe_media', { filePath: selectedPath }),
        invoke<{ keyframes: number[] }>('probe_keyframes', { filePath: selectedPath })
      ]);
      const duration = Number(result.format?.duration || 0);
      const initialEnd = secondsToTimestamp(duration);
      const extension = extensionFromPath(selectedPath);
      const suggestedOutput = selectedPath.replace(/\.[^.]+$/, `_trim.${extension}`);

      setSourcePath(selectedPath);
      setOutputPath(suggestedOutput);
      setProbe(result);
      setKeyframes(keyframeProbe.keyframes || []);
      setStart('00:00:00');
      setEnd(initialEnd);
      setPreviewTime(0);
      setStatus('Ready');
      setLastLog('');
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Analysis failed';
      setError(message);
      setStatus('Error');
    } finally {
      setIsBusy(false);
    }
  }

  async function loadConvertFile(selectedPath: string) {
    setConvertError('');
    setIsConvertBusy(true);
    setConvertStatus('Loading...');

    try {
      const result = await invoke<ProbeResult>('probe_media', { filePath: selectedPath });
      setConvertSourcePath(selectedPath);
      setConvertProbe(result);
      setConvertOutputPath(replaceExtension(selectedPath, '_convert', convertContainer));
      setConvertStatus('Ready');
      setConvertLog('');
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Analysis failed';
      setConvertError(message);
      setConvertStatus('Error');
    } finally {
      setIsConvertBusy(false);
    }
  }

  async function handleOpenFile() {
    try {
      const selectedPath = await invoke<string | null>('open_file');

      if (!selectedPath) {
        return;
      }

      await loadLosslessFile(selectedPath);
    } catch {
    }
  }

  async function handleLoadManualSourcePath() {
    if (!manualSourcePath.trim()) {
      setError('Please enter a file path first.');
      return;
    }

    await loadLosslessFile(manualSourcePath.trim());
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
      const message = caughtError instanceof Error ? caughtError.message : 'FFmpeg failed';
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

      await loadConvertFile(selectedPath);
    } catch {
    }
  }

  async function handleLoadManualConvertPath() {
    if (!manualConvertPath.trim()) {
      setConvertError('Please enter a file path first.');
      return;
    }

    await loadConvertFile(manualConvertPath.trim());
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
      const message = caughtError instanceof Error ? caughtError.message : 'FFmpeg failed';
      setConvertError(message);
      setConvertStatus('Error');
      updateJob(jobId, 'Error', message);
    } finally {
      setIsConvertBusy(false);
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
                  <strong>{job.kind === 'cut' ? 'Lossless Cut' : 'Convert'}</strong>
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
            <span>{activeTool === 'smart-convert' ? 'Load into Convert' : 'Load into Lossless Cut'}</span>
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
          </div>
        </header>

        {activeTool === 'lossless-cut' ? renderLosslessCut() : null}
        {activeTool === 'smart-convert' ? renderConvert() : null}
        {activeTool !== 'lossless-cut' && activeTool !== 'smart-convert' ? renderPlaceholder() : null}

        {renderDropDebug()}
        {renderJobs()}
      </main>
    </div>
  );
}

export default App;
