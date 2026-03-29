export {};

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  sample_rate?: string;
};

type ProbeFormat = {
  duration?: string;
  format_long_name?: string;
  bit_rate?: string;
};

type ProbeResult = {
  streams?: ProbeStream[];
  format?: ProbeFormat;
};

type LosslessCutPayload = {
  sourcePath: string;
  outputPath: string;
  start: string;
  end: string;
  videoCodec: string;
  audioCodec: string;
};

type ConvertPayload = {
  sourcePath: string;
  outputPath: string;
  videoCodec: string;
  audioCodec: string;
  videoBitrate: string;
  audioBitrate: string;
};

declare global {
  interface Window {
    desktop?: {
      platform: string;
      isDesktop: boolean;
      openFile: () => Promise<string | null>;
      saveFile: (sourcePath: string, extension: string, suffix?: string) => Promise<string | null>;
      probeMedia: (filePath: string) => Promise<ProbeResult>;
      runLosslessCut: (payload: LosslessCutPayload) => Promise<{ command: string; log: string }>;
      runConvert: (payload: ConvertPayload) => Promise<{ command: string; log: string }>;
    };
  }
}
