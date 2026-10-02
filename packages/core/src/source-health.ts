/** Versioned results from a full source decode and audio peak scan. */
export interface AudioPeak {
  /** dBFS, or null for digital silence. */
  dbfs: number | null;
  /** Start time in seconds of the decoded/analyzer frame containing the maximum, not its exact sample time; null for silence. */
  atSeconds: number | null;
}

export interface AudioMeasurement {
  /** Integrated loudness in LUFS, or null when the stream is silent/below the EBU gate. */
  integratedLufs: number | null;
  samplePeak: AudioPeak;
  truePeak: AudioPeak;
}

export interface SourceHealth {
  format: 1;
  method: "ffmpeg" | "ffprobe";
  path: string;
  fingerprint: string;
  measuredAt: string;
  decode: { status: "ok" } | { status: "failed"; error: string };
  audio:
    | { status: "none" }
    | { status: "unmeasured" }
    | ({ status: "measured" } & AudioMeasurement)
    | { status: "failed"; error: string };
}

export type FinalMixMeasurement = { decoded: true; audio: { status: "none" } | ({ status: "measured" } & AudioMeasurement) };
