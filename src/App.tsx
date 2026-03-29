import { useEffect, useState } from 'react';
import { convertPresets, presets, queueJobs, tools } from './data/appData';

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

const moduleDescriptions: Record<ToolId, { title: string; description: string }> = {
  'lossless-cut': {
    title: 'Lossless Cut',
    description: 'Load a file, inspect it with ffprobe, set in/out points, and run ffmpeg directly.'
  },
  'smart-convert': {
    title: 'Convert',
    description: 'Convert media with built-in presets that avoid assuming GPL-only or nonfree FFmpeg builds.'
  },
  'audio-lab': {
    title: 'Audio',
    description: 'Audio extraction, transcoding, and cleanup tools will live here.'
  },
  'image-sequence': {
    title: 'Frames',
    description: 'Frame export, thumbnails, and image sequence tools will live here.'
  },
  'batch-pipeline': {
    title: 'Batch',
    description: 'Reusable queues and multi-file processing workflows will live here.'
  }
};

function padTime(value: number) {
  return String(value).padStart(2, '0');
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

function buildLosslessCommandPreview(
  sourcePath: string,
  outputPath: string,
  start: string,
  end: string,
  videoCodec: string,
  audioCodec: string
) {
  if (!sourcePath || !outputPath) {
    return 'ffmpeg -ss 00:00:00 -to 00:00:00 -i input.mp4 -c:v copy -c:a copy output.mp4';
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
    return 'ffmpeg -i input.mov -c:v mpeg4 -b:v 5M -c:a aac -b:a 192k output.mp4';
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

function App() {
  const [activeTool, setActiveTool] = useState<ToolId>('lossless-cut');

  const [sourcePath, setSourcePath] = useState('');
  const [outputPath, setOutputPath] = useState('');
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [start, setStart] = useState('00:00:00');
  const [end, setEnd] = useState('00:00:00');
  const [videoCodec, setVideoCodec] = useState('copy');
  const [audioCodec, setAudioCodec] = useState('copy');
  const [preset, setPreset] = useState('Lossless Trim');
  const [status, setStatus] = useState('No file loaded');
  const [error, setError] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [lastLog, setLastLog] = useState('');

  const [convertSourcePath, setConvertSourcePath] = useState('');
  const [convertOutputPath, setConvertOutputPath] = useState('');
  const [convertProbe, setConvertProbe] = useState<ProbeResult | null>(null);
  const [convertPreset, setConvertPreset] = useState('MP4 Safe Convert');
  const [convertContainer, setConvertContainer] = useState('mp4');
  const [convertVideoCodec, setConvertVideoCodec] = useState('mpeg4');
  const [convertAudioCodec, setConvertAudioCodec] = useState('aac');
  const [convertVideoBitrate, setConvertVideoBitrate] = useState('5M');
  const [convertAudioBitrate, setConvertAudioBitrate] = useState('192k');
  const [convertStatus, setConvertStatus] = useState('No file loaded');
  const [convertError, setConvertError] = useState('');
  const [isConvertBusy, setIsConvertBusy] = useState(false);
  const [convertLog, setConvertLog] = useState('');

  const durationSeconds = Number(probe?.format?.duration || 0);
  const durationLabel = secondsToTimestamp(durationSeconds);
  const videoStream = probe?.streams?.find((stream) => stream.codec_type === 'video');
  const audioStream = probe?.streams?.find((stream) => stream.codec_type === 'audio');
  const outputExtension = extensionFromPath(outputPath || sourcePath || 'output.mp4');
  const commandPreview = buildLosslessCommandPreview(sourcePath, outputPath, start, end, videoCodec, audioCodec);

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

  useEffect(() => {
    if (preset === 'Lossless Trim') {
      setVideoCodec('copy');
      setAudioCodec('copy');
    }

    if (preset === 'H.264 + AAC') {
      setVideoCodec('libx264');
      setAudioCodec('aac');
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
  }, [convertPreset]);

  async function handleOpenFile() {
    if (!window.desktop) {
      setError('Desktop API is not available.');
      return;
    }

    setError('');
    setIsBusy(true);
    setStatus('Loading file...');

    try {
      const selectedPath = await window.desktop.openFile();

      if (!selectedPath) {
        setStatus('File selection cancelled');
        return;
      }

      const result = await window.desktop.probeMedia(selectedPath);
      const duration = Number(result.format?.duration || 0);
      const initialEnd = secondsToTimestamp(duration);
      const extension = extensionFromPath(selectedPath);
      const suggestedOutput = selectedPath.replace(/\.[^.]+$/, `_trim.${extension}`);

      setSourcePath(selectedPath);
      setOutputPath(suggestedOutput);
      setProbe(result);
      setStart('00:00:00');
      setEnd(initialEnd);
      setStatus('File analyzed');
      setLastLog('');
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Analysis failed';
      setError(message);
      setStatus('Error');
    } finally {
      setIsBusy(false);
    }
  }

  async function handlePickOutput() {
    if (!window.desktop || !sourcePath) {
      return;
    }

    const selectedOutput = await window.desktop.saveFile(sourcePath, outputExtension, '_trim');
    if (selectedOutput) {
      setOutputPath(selectedOutput);
    }
  }

  async function handleRunLosslessCut() {
    if (!window.desktop) {
      setError('Desktop API is not available.');
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
    setStatus('Running ffmpeg...');

    try {
      const result = await window.desktop.runLosslessCut({
        sourcePath,
        outputPath,
        start,
        end,
        videoCodec,
        audioCodec
      });

      setStatus('Job finished');
      setLastLog(`${result.command}\n\n${result.log}`.trim());
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'FFmpeg failed';
      setError(message);
      setStatus('Error');
    } finally {
      setIsBusy(false);
    }
  }

  async function handleOpenConvertFile() {
    if (!window.desktop) {
      setConvertError('Desktop API is not available.');
      return;
    }

    setConvertError('');
    setIsConvertBusy(true);
    setConvertStatus('Loading file...');

    try {
      const selectedPath = await window.desktop.openFile();
      if (!selectedPath) {
        setConvertStatus('File selection cancelled');
        return;
      }

      const result = await window.desktop.probeMedia(selectedPath);
      setConvertSourcePath(selectedPath);
      setConvertProbe(result);
      setConvertOutputPath(replaceExtension(selectedPath, '_convert', convertContainer));
      setConvertStatus('File analyzed');
      setConvertLog('');
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Analysis failed';
      setConvertError(message);
      setConvertStatus('Error');
    } finally {
      setIsConvertBusy(false);
    }
  }

  async function handlePickConvertOutput() {
    if (!window.desktop || !convertSourcePath) {
      return;
    }

    const selectedOutput = await window.desktop.saveFile(convertSourcePath, convertContainer, '_convert');
    if (selectedOutput) {
      setConvertOutputPath(selectedOutput);
    }
  }

  async function handleRunConvert() {
    if (!window.desktop) {
      setConvertError('Desktop API is not available.');
      return;
    }

    if (!convertSourcePath || !convertOutputPath) {
      setConvertError('Please choose a source file and an output path first.');
      return;
    }

    setConvertError('');
    setIsConvertBusy(true);
    setConvertStatus('Running ffmpeg...');

    try {
      const result = await window.desktop.runConvert({
        sourcePath: convertSourcePath,
        outputPath: convertOutputPath,
        videoCodec: convertVideoCodec,
        audioCodec: convertAudioCodec,
        videoBitrate: convertVideoBitrate,
        audioBitrate: convertAudioBitrate
      });

      setConvertStatus('Job finished');
      setConvertLog(`${result.command}\n\n${result.log}`.trim());
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'FFmpeg failed';
      setConvertError(message);
      setConvertStatus('Error');
    } finally {
      setIsConvertBusy(false);
    }
  }

  function renderComplianceNotice() {
    return (
      <div className="compliance-box">
        <strong>FFmpeg compliance notice</strong>
        <p>
          This app currently calls external <code>ffmpeg</code> and <code>ffprobe</code> binaries from the local system PATH.
          This build does not bundle FFmpeg binaries, and the default convert presets avoid assuming GPL-only or nonfree codec builds.
        </p>
      </div>
    );
  }

  function renderLosslessCut() {
    return (
      <>
        <section className="panel panel-grid">
          <div className="panel-block viewer-block">
            <div className="panel-title-row">
              <h3>Source</h3>
              <span>{sourcePath ? fileNameFromPath(sourcePath) : 'No file'}</span>
            </div>

            <div className="viewer-placeholder">
              <span>{sourcePath ? 'Preview will be added later' : 'No file loaded'}</span>
            </div>

            <div className="timeline-strip">
              <div className="timeline-selection" />
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
                <span>Source path</span>
                <strong>{sourcePath || '-'}</strong>
              </div>
              <div>
                <span>Output path</span>
                <strong>{outputPath || '-'}</strong>
              </div>
            </div>
          </div>

          <div className="panel-block settings-block">
            <div className="panel-title-row">
              <h3>Job</h3>
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
                  <option value="libx264">libx264</option>
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

            <div className="status-list">
              <div>
                <span>Format</span>
                <strong>{probe?.format?.format_long_name || '-'}</strong>
              </div>
              <div>
                <span>Video stream</span>
                <strong>
                  {videoStream?.codec_name
                    ? `${videoStream.codec_name}${videoStream.width ? ` ${videoStream.width}x${videoStream.height}` : ''}`
                    : '-'}
                </strong>
              </div>
              <div>
                <span>Audio stream</span>
                <strong>
                  {audioStream?.codec_name
                    ? `${audioStream.codec_name}${audioStream.channels ? ` ${audioStream.channels}ch` : ''}`
                    : '-'}
                </strong>
              </div>
              <div>
                <span>Bitrate</span>
                <strong>{probe?.format?.bit_rate || '-'}</strong>
              </div>
            </div>

            <div className="command-box">{commandPreview}</div>

            {error ? <div className="message error">{error}</div> : null}
            {lastLog ? <pre className="log-box">{lastLog}</pre> : null}
          </div>
        </section>

        <section className="bottom-grid">
          <div className="panel panel-block">
            <div className="panel-title-row">
              <h3>Queue</h3>
              <span>{queueJobs.length} entries</span>
            </div>

            <div className="queue-list">
              {queueJobs.map((job) => (
                <div key={job.id} className="queue-row">
                  <div>
                    <strong>{job.label}</strong>
                    <p>{job.detail}</p>
                  </div>
                  <div className="queue-meta">
                    <span>{job.state}</span>
                    <span>{job.progress}%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel panel-block">
            <div className="panel-title-row">
              <h3>Available modules</h3>
              <span>{tools.length}</span>
            </div>

            <div className="tool-table">
              {tools.map((tool) => (
                <div key={tool.id} className="tool-row">
                  <strong>{tool.title}</strong>
                  <span>{tool.tagline}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {renderComplianceNotice()}
      </>
    );
  }

  function renderConvert() {
    return (
      <>
        <section className="panel panel-grid">
          <div className="panel-block viewer-block">
            <div className="panel-title-row">
              <h3>Source</h3>
              <span>{convertSourcePath ? fileNameFromPath(convertSourcePath) : 'No file'}</span>
            </div>

            <div className="viewer-placeholder">
              <span>{convertSourcePath ? 'Conversion source loaded' : 'No file loaded'}</span>
            </div>

            <div className="time-fields compact-fields">
              <label>
                <span>Duration</span>
                <input value={convertDurationLabel} readOnly />
              </label>
              <label>
                <span>Source format</span>
                <input value={convertProbe?.format?.format_long_name || '-'} readOnly />
              </label>
              <label>
                <span>Target container</span>
                <input value={convertContainer} readOnly />
              </label>
            </div>

            <div className="path-list">
              <div>
                <span>Source path</span>
                <strong>{convertSourcePath || '-'}</strong>
              </div>
              <div>
                <span>Output path</span>
                <strong>{convertOutputPath || '-'}</strong>
              </div>
            </div>
          </div>

          <div className="panel-block settings-block">
            <div className="panel-title-row">
              <h3>Convert job</h3>
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
                <span>Video codec</span>
                <select value={convertVideoCodec} onChange={(event) => setConvertVideoCodec(event.target.value)}>
                  <option value="mpeg4">mpeg4</option>
                  <option value="ffv1">ffv1</option>
                  <option value="copy">copy</option>
                  <option value="none">none</option>
                </select>
              </label>
              <label>
                <span>Audio codec</span>
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

            <div className="status-list">
              <div>
                <span>Source video</span>
                <strong>
                  {convertVideoStream?.codec_name
                    ? `${convertVideoStream.codec_name}${convertVideoStream.width ? ` ${convertVideoStream.width}x${convertVideoStream.height}` : ''}`
                    : '-'}
                </strong>
              </div>
              <div>
                <span>Source audio</span>
                <strong>
                  {convertAudioStream?.codec_name
                    ? `${convertAudioStream.codec_name}${convertAudioStream.channels ? ` ${convertAudioStream.channels}ch` : ''}`
                    : '-'}
                </strong>
              </div>
              <div>
                <span>Safety profile</span>
                <strong>Defaults avoid GPL-only and nonfree assumptions</strong>
              </div>
              <div>
                <span>FFmpeg source</span>
                <strong>External system installation</strong>
              </div>
            </div>

            <div className="command-box">{convertCommandPreview}</div>

            {convertError ? <div className="message error">{convertError}</div> : null}
            {convertLog ? <pre className="log-box">{convertLog}</pre> : null}
          </div>
        </section>

        <section className="bottom-grid">
          <div className="panel panel-block">
            <div className="panel-title-row">
              <h3>Safe default presets</h3>
              <span>{convertPresets.length}</span>
            </div>

            <div className="tool-table">
              {convertPresets.map((entry) => (
                <div key={entry.id} className="tool-row">
                  <strong>{entry.name}</strong>
                  <span>{`${entry.container} | ${entry.videoCodec} | ${entry.audioCodec}`}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="panel panel-block">
            <div className="panel-title-row">
              <h3>Compliance design</h3>
              <span>Current build</span>
            </div>

            <div className="tool-table">
              <div className="tool-row">
                <strong>No bundled FFmpeg binaries</strong>
                <span>This desktop build calls the local system installation instead.</span>
              </div>
              <div className="tool-row">
                <strong>Official notice included</strong>
                <span>See README and THIRD_PARTY_NOTICES for licensing notes and source links.</span>
              </div>
              <div className="tool-row">
                <strong>Safer defaults</strong>
                <span>Preset codecs avoid relying on GPL-only or nonfree FFmpeg configurations.</span>
              </div>
            </div>
          </div>
        </section>

        {renderComplianceNotice()}
      </>
    );
  }

  function renderPlaceholder() {
    return (
      <section className="panel placeholder-panel">
        <div className="panel-block placeholder-block">
          <div className="panel-title-row">
            <h3>{activeModule.title}</h3>
            <span>{activeTool}</span>
          </div>
          <p>{activeModule.description}</p>
          <div className="placeholder-notes">
            <div>
              <span>Status</span>
              <strong>Planned</strong>
            </div>
            <div>
              <span>Next step</span>
              <strong>Implement real FFmpeg actions for this module</strong>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>FFmpeg Forge</h1>
          <p>Desktop tools</p>
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
              <span className="module-meta">{tool.category}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <strong>Licensing</strong>
          <p>FFmpeg is not bundled in this build. See README and THIRD_PARTY_NOTICES.</p>
        </div>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div>
            <h2>{activeModule.title}</h2>
            <p>{activeModule.description}</p>
          </div>

          <div className="header-actions">
            {activeTool === 'lossless-cut' ? (
              <>
                <button type="button" className="button button-primary" onClick={handleOpenFile} disabled={isBusy}>
                  Open file
                </button>
                <button type="button" className="button" onClick={handlePickOutput} disabled={!sourcePath || isBusy}>
                  Choose output
                </button>
                <button type="button" className="button" onClick={handleRunLosslessCut} disabled={!sourcePath || isBusy}>
                  Run
                </button>
              </>
            ) : null}

            {activeTool === 'smart-convert' ? (
              <>
                <button type="button" className="button button-primary" onClick={handleOpenConvertFile} disabled={isConvertBusy}>
                  Open file
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={handlePickConvertOutput}
                  disabled={!convertSourcePath || isConvertBusy}
                >
                  Choose output
                </button>
                <button type="button" className="button" onClick={handleRunConvert} disabled={!convertSourcePath || isConvertBusy}>
                  Run
                </button>
              </>
            ) : null}
          </div>
        </header>

        {activeTool === 'lossless-cut' ? renderLosslessCut() : null}
        {activeTool === 'smart-convert' ? renderConvert() : null}
        {activeTool !== 'lossless-cut' && activeTool !== 'smart-convert' ? renderPlaceholder() : null}
      </main>
    </div>
  );
}

export default App;
