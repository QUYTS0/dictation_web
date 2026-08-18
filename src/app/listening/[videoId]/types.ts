export interface ListeningSegment {
  segmentIndex: number;
  start: number;
  end: number;
  textEn: string;
  textVi: string | null;
}

export type TranscriptLoadState = "loading" | "processing" | "failed" | "ready";
