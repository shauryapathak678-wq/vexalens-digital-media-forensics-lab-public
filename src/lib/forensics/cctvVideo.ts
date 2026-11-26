import { calculateSHA256 } from './crypto';

export const CCTV_MAX_VIDEO_BYTES = 128 * 1024 * 1024;
const CCTV_TIMEOUT_MS = 15_000;
const SUPPORTED_VIDEO_EXTENSIONS = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm']);

export interface CctvTimingGap {
  at: number;
  at_label: string;
  gap_seconds: number;
  frames_missing: number;
}

export interface CctvDiscontinuity {
  frame: number;
  at: number;
  at_label: string;
  change_strength: number;
  brightness_jump: number;
}

export interface CctvFrozenSegment {
  start: number;
  end: number;
  start_label: string;
  frames: number;
}

export interface CctvReplaySegment {
  original_start: number;
  original_label: string;
  repeated_start: number;
  repeated_label: string;
  length_seconds: number;
}

export interface CctvActivityEvent {
  start: number;
  end: number;
  start_label: string;
  end_label: string;
  peak: number;
}

export interface CctvVideoAnalysisResult {
  verdict: 'No tampering indicators found' | 'Needs review' | 'High risk';
  risk_score: number;
  reasons: string[];
  file: {
    sha256: string;
    frames_analyzed: number;
    fps: number;
    resolution: string;
    duration_seconds: number;
    timestamp_source: string;
    truncated: boolean;
  };
  timing_gaps: CctvTimingGap[];
  discontinuities: CctvDiscontinuity[];
  frozen_frames: CctvFrozenSegment[];
  replayed_segments: CctvReplaySegment[];
  activity_events: CctvActivityEvent[];
  series: {
    change: number[];
    duration_seconds: number;
    threshold: number;
  };
  custody: {
    source_sha256: string;
    analysis_sha256: string;
    original_unchanged: true;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isRecordArray<T>(
  value: unknown,
  isItem: (item: unknown) => item is T,
): value is T[] {
  return Array.isArray(value) && value.every(isItem);
}

function isTimingGap(value: unknown): value is CctvTimingGap {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.at) &&
    isString(value.at_label) &&
    isFiniteNumber(value.gap_seconds) &&
    Number.isInteger(value.frames_missing)
  );
}

function isDiscontinuity(value: unknown): value is CctvDiscontinuity {
  if (!isRecord(value)) return false;
  return (
    Number.isInteger(value.frame) &&
    isFiniteNumber(value.at) &&
    isString(value.at_label) &&
    isFiniteNumber(value.change_strength) &&
    isFiniteNumber(value.brightness_jump)
  );
}

function isFrozenSegment(value: unknown): value is CctvFrozenSegment {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.start) &&
    isFiniteNumber(value.end) &&
    isString(value.start_label) &&
    Number.isInteger(value.frames)
  );
}

function isReplaySegment(value: unknown): value is CctvReplaySegment {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.original_start) &&
    isString(value.original_label) &&
    isFiniteNumber(value.repeated_start) &&
    isString(value.repeated_label) &&
    isFiniteNumber(value.length_seconds)
  );
}

function isActivityEvent(value: unknown): value is CctvActivityEvent {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.start) &&
    isFiniteNumber(value.end) &&
    isString(value.start_label) &&
    isString(value.end_label) &&
    isFiniteNumber(value.peak)
  );
}

function isCctvAnalysis(value: unknown): value is CctvVideoAnalysisResult {
  if (!isRecord(value) || !isRecord(value.file) || !isRecord(value.series) || !isRecord(value.custody)) {
    return false;
  }
  const { file, series, custody } = value;
  return (
    (value.verdict === 'No tampering indicators found' ||
      value.verdict === 'Needs review' ||
      value.verdict === 'High risk') &&
    isFiniteNumber(value.risk_score) &&
    value.risk_score >= 0 &&
    value.risk_score <= 100 &&
    isStringArray(value.reasons) &&
    isString(file.sha256) &&
    /^[a-f0-9]{64}$/i.test(file.sha256) &&
    Number.isInteger(file.frames_analyzed) &&
    Number(file.frames_analyzed) > 0 &&
    isFiniteNumber(file.fps) &&
    isString(file.resolution) &&
    isFiniteNumber(file.duration_seconds) &&
    file.duration_seconds >= 0 &&
    isString(file.timestamp_source) &&
    typeof file.truncated === 'boolean' &&
    isRecordArray(value.timing_gaps, isTimingGap) &&
    isRecordArray(value.discontinuities, isDiscontinuity) &&
    isRecordArray(value.frozen_frames, isFrozenSegment) &&
    isRecordArray(value.replayed_segments, isReplaySegment) &&
    isRecordArray(value.activity_events, isActivityEvent) &&
    Array.isArray(series.change) &&
    series.change.length > 0 &&
    series.change.every(isFiniteNumber) &&
    isFiniteNumber(series.duration_seconds) &&
    series.duration_seconds >= 0 &&
    isFiniteNumber(series.threshold) &&
    isString(custody.source_sha256) &&
    /^[a-f0-9]{64}$/i.test(custody.source_sha256) &&
    isString(custody.analysis_sha256) &&
    /^[a-f0-9]{64}$/i.test(custody.analysis_sha256) &&
    custody.original_unchanged === true
  );
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`The local CCTV service returned an invalid response (HTTP ${response.status}).`);
  }
}

export async function analyzeCctvVideo(video: File): Promise<CctvVideoAnalysisResult> {
  const extension = video.name.slice(video.name.lastIndexOf('.')).toLowerCase();
  if (!SUPPORTED_VIDEO_EXTENSIONS.has(extension)) {
    throw new Error('Choose an AVI, M4V, MKV, MOV, MP4, or WebM video.');
  }
  if (video.size === 0) throw new Error('The selected video file is empty.');
  if (video.size > CCTV_MAX_VIDEO_BYTES) throw new Error('CCTV analysis accepts videos up to 128 MB.');

  const deadline = Date.now() + CCTV_TIMEOUT_MS;
  let sourceSha256: string;
  let response: Response;
  try {
    sourceSha256 = await calculateSHA256(video);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new DOMException('CCTV analysis timed out.', 'TimeoutError');
    response = await fetch('/api/forensics/cctv/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Evidence-Sha256': sourceSha256,
        'X-File-Extension': extension,
      },
      body: video,
      signal: AbortSignal.timeout(remainingMs),
    });
  } catch (requestError) {
    if (requestError instanceof Error && requestError.name === 'TimeoutError') {
      throw new Error('CCTV analysis exceeded the 15-second limit. Try a shorter video.');
    }
    throw requestError;
  }

  const body = await readJsonResponse(response);
  if (!response.ok) {
    const detail = isRecord(body) && typeof body.detail === 'string'
      ? body.detail
      : isRecord(body) && typeof body.error === 'string'
        ? body.error
        : 'CCTV video analysis failed.';
    throw new Error(detail);
  }
  if (!isCctvAnalysis(body)) {
    throw new Error('The local CCTV service returned an invalid analysis response.');
  }
  if (
    body.file.sha256.toLowerCase() !== sourceSha256.toLowerCase() ||
    body.custody.source_sha256.toLowerCase() !== sourceSha256.toLowerCase() ||
    body.custody.analysis_sha256.toLowerCase() !== sourceSha256.toLowerCase()
  ) {
    throw new Error('The uploaded evidence hash did not match the analyzed copy. No result was accepted.');
  }
  return body;
}
