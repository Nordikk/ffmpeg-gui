export type ToolCategory = 'Convert' | 'Cut' | 'Audio' | 'Image' | 'Batch';

export type ToolDefinition = {
  id: string;
  title: string;
  category: ToolCategory;
  tagline: string;
};

export type QueueJob = {
  id: string;
  label: string;
  progress: number;
  state: 'Queued' | 'Running' | 'Done';
  detail: string;
};

export type PresetDefinition = {
  id: string;
  name: string;
  target: string;
};

export const tools: ToolDefinition[] = [
  { id: 'lossless-cut', title: 'Lossless Cut', category: 'Cut', tagline: 'Stream copy trimming without re-encode' },
  { id: 'smart-convert', title: 'Convert', category: 'Convert', tagline: 'Convert containers and codecs' },
  { id: 'audio-lab', title: 'Audio', category: 'Audio', tagline: 'Extract and transcode audio' },
  { id: 'image-sequence', title: 'Frames', category: 'Image', tagline: 'Create stills and image sequences' },
  { id: 'batch-pipeline', title: 'Batch', category: 'Batch', tagline: 'Queue and repeat multi-file jobs' }
];

export const queueJobs: QueueJob[] = [
  {
    id: 'job-1',
    label: 'Concert_A_Cam.mov -> ProRes Proxy',
    progress: 72,
    state: 'Running',
    detail: '1920x1080, proxy preset, ETA 02:14'
  },
  {
    id: 'job-2',
    label: 'Interview_master.mp4 -> trimmed copy',
    progress: 100,
    state: 'Done',
    detail: 'Lossless cut from 00:12:03 to 00:18:41'
  },
  {
    id: 'job-3',
    label: 'podcast_episode.wav -> mp3 + chapters',
    progress: 8,
    state: 'Queued',
    detail: 'Waiting for a free worker'
  }
];

export const presets: PresetDefinition[] = [
  { id: 'preset-1', name: 'Lossless Trim', target: 'copy/copy' },
  { id: 'preset-2', name: 'H.264 + AAC', target: 'libx264/aac' },
  { id: 'preset-3', name: 'Audio Only', target: 'copy/aac' }
];
