export type ToolCategory = 'Convert' | 'Cut' | 'Audio' | 'Image' | 'Batch';

export type ToolDefinition = {
  id: string;
  title: string;
  category: ToolCategory;
};

export type PresetDefinition = {
  id: string;
  name: string;
  target: string;
};

export type ConvertPreset = {
  id: string;
  name: string;
  container: string;
  videoCodec: string;
  audioCodec: string;
  videoBitrate: string;
  audioBitrate: string;
};

export const tools: ToolDefinition[] = [
  { id: 'lossless-cut', title: 'Lossless Cut', category: 'Cut' },
  { id: 'smart-convert', title: 'Convert', category: 'Convert' },
  { id: 'audio-lab', title: 'Audio', category: 'Audio' },
  { id: 'image-sequence', title: 'Frames', category: 'Image' },
  { id: 'batch-pipeline', title: 'Batch', category: 'Batch' }
];

export const presets: PresetDefinition[] = [
  { id: 'preset-1', name: 'Lossless Trim', target: 'copy/copy' },
  { id: 'preset-2', name: 'Audio Only', target: 'copy/aac' }
];

export const convertPresets: ConvertPreset[] = [
  {
    id: 'convert-1',
    name: 'MP4 Safe Convert',
    container: 'mp4',
    videoCodec: 'mpeg4',
    audioCodec: 'aac',
    videoBitrate: '5M',
    audioBitrate: '192k'
  },
  {
    id: 'convert-2',
    name: 'Archive MKV',
    container: 'mkv',
    videoCodec: 'ffv1',
    audioCodec: 'flac',
    videoBitrate: '',
    audioBitrate: ''
  },
  {
    id: 'convert-3',
    name: 'Audio Extract FLAC',
    container: 'flac',
    videoCodec: 'none',
    audioCodec: 'flac',
    videoBitrate: '',
    audioBitrate: ''
  }
];
