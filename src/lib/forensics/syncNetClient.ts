export interface SyncNetStatus {
  configured: boolean;
  upstream: string;
  upstream_revision: string;
  missing_files: string[];
  missing_dependencies: string[];
  missing_tools: string[];
  max_video_duration_seconds: number;
  max_video_bytes: number;
  analysis_window_seconds: number;
}

export interface SyncNetTrackResult {
  track_index: number;
  face_track_frames: number;
  face_track_duration_seconds: number;
  offset_frames: number;
  offset_seconds: number;
  confidence_score: number;
}

export interface SyncNetAnalysisResult {
  status: 'completed';
  model: 'SyncNet';
  model_version: string;
  upstream_revision: string;
  source_sha256: string;
  video_duration_seconds: number;
  analysis_segment_start_seconds: number;
  analysis_segment_end_seconds: number;
  analysis_segment_duration_seconds: number;
  frame_rate: number;
  face_detection_scale?: number;
  min_face_size_pixels?: number;
  confidence_semantics?: string;
  offset_semantics?: string;
  analysis_duration_seconds?: number;
  tracks: SyncNetTrackResult[];
  message?: string;
}

export const SYNCNET_MAX_VIDEO_BYTES = 128 * 1024 * 1024;

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`The local SyncNet service returned an invalid response (HTTP ${response.status}).`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`The local SyncNet service returned an invalid response (HTTP ${response.status}).`);
  }
  return value as Record<string, unknown>;
}

export async function getSyncNetStatus(): Promise<SyncNetStatus> {
  let response: Response;
  try {
    response = await fetch('/api/lipsync/syncnet/health', {
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error('SyncNet readiness check timed out. Verify the local service if it remains unavailable.');
    }
    throw error;
  }
  const body = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : 'The local SyncNet service is unavailable.');
  }
  if (
    typeof body.configured !== 'boolean' ||
    typeof body.upstream !== 'string' ||
    typeof body.upstream_revision !== 'string' ||
    !Array.isArray(body.missing_files) ||
    !body.missing_files.every((item) => typeof item === 'string') ||
    !Array.isArray(body.missing_dependencies) ||
    !body.missing_dependencies.every((item) => typeof item === 'string') ||
    !Array.isArray(body.missing_tools) ||
    !body.missing_tools.every((item) => typeof item === 'string') ||
    typeof body.max_video_duration_seconds !== 'number' ||
    typeof body.max_video_bytes !== 'number' ||
    typeof body.analysis_window_seconds !== 'number'
  ) {
    throw new Error('The local SyncNet service returned an invalid status response.');
  }
  return {
    configured: body.configured,
    upstream: body.upstream,
    upstream_revision: body.upstream_revision,
    missing_files: body.missing_files,
    missing_dependencies: body.missing_dependencies,
    missing_tools: body.missing_tools,
    max_video_duration_seconds: body.max_video_duration_seconds,
    max_video_bytes: body.max_video_bytes,
    analysis_window_seconds: body.analysis_window_seconds,
  };
}

export async function fetchSyncNetVideoCopy(url: string): Promise<Blob> {
  const controller = new AbortController();
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch {
    throw new Error('Could not download the selected video from its preview URL. Check your connection or choose the local file; the storage host may block browser access.');
  }
  if (!response.ok) {
    throw new Error(`Could not download the selected video from its preview URL (HTTP ${response.status}).`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > SYNCNET_MAX_VIDEO_BYTES) {
    controller.abort();
    throw new Error('SyncNet accepts videos up to 128 MB.');
  }
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > SYNCNET_MAX_VIDEO_BYTES) {
      throw new Error('SyncNet accepts videos up to 128 MB.');
    }
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > SYNCNET_MAX_VIDEO_BYTES) {
      controller.abort();
      throw new Error('SyncNet accepts videos up to 128 MB.');
    }
    chunks.push(new Uint8Array(value));
  }

  return new Blob(chunks, { type: response.headers.get('content-type') || '' });
}

export async function analyzeSyncNetOffset(
  video: Blob,
  extension: string,
  evidenceSha256: string,
): Promise<SyncNetAnalysisResult> {
  const response = await fetch('/api/lipsync/syncnet/analyze', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Evidence-Sha256': evidenceSha256,
      'X-File-Extension': extension,
    },
    body: video,
    signal: AbortSignal.timeout(18 * 60 * 1000),
  });
  const body = await readJsonResponse(response);
  if (!response.ok) {
    const detail = typeof body.detail === 'string'
      ? body.detail
      : typeof body.error === 'string'
        ? body.error
        : 'SyncNet offset analysis failed.';
    throw new Error(detail);
  }
  if (
    body.status !== 'completed' ||
    body.model !== 'SyncNet' ||
    typeof body.model_version !== 'string' ||
    typeof body.upstream_revision !== 'string' ||
    typeof body.source_sha256 !== 'string' ||
    typeof body.video_duration_seconds !== 'number' ||
    typeof body.analysis_segment_start_seconds !== 'number' ||
    typeof body.analysis_segment_end_seconds !== 'number' ||
    typeof body.analysis_segment_duration_seconds !== 'number' ||
    typeof body.frame_rate !== 'number' ||
    (body.face_detection_scale !== undefined &&
      (typeof body.face_detection_scale !== 'number' || !Number.isFinite(body.face_detection_scale))) ||
    (body.min_face_size_pixels !== undefined &&
      (typeof body.min_face_size_pixels !== 'number' || !Number.isFinite(body.min_face_size_pixels))) ||
    !Array.isArray(body.tracks)
  ) {
    throw new Error('The local SyncNet service returned an invalid analysis response.');
  }

  const tracks: SyncNetTrackResult[] = body.tracks.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error('The local SyncNet service returned an invalid face-track result.');
    }
    const track = entry as Record<string, unknown>;
    if (
      typeof track.track_index !== 'number' ||
      typeof track.face_track_frames !== 'number' ||
      typeof track.face_track_duration_seconds !== 'number' ||
      typeof track.offset_frames !== 'number' ||
      typeof track.offset_seconds !== 'number' ||
      typeof track.confidence_score !== 'number' ||
      ![
        track.track_index,
        track.face_track_frames,
        track.face_track_duration_seconds,
        track.offset_frames,
        track.offset_seconds,
        track.confidence_score,
      ].every(Number.isFinite)
    ) {
      throw new Error('The local SyncNet service returned an invalid face-track result.');
    }
    return {
      track_index: track.track_index,
      face_track_frames: track.face_track_frames,
      face_track_duration_seconds: track.face_track_duration_seconds,
      offset_frames: track.offset_frames,
      offset_seconds: track.offset_seconds,
      confidence_score: track.confidence_score,
    };
  });

  return {
    status: 'completed',
    model: 'SyncNet',
    model_version: body.model_version,
    upstream_revision: body.upstream_revision,
    source_sha256: body.source_sha256,
    video_duration_seconds: body.video_duration_seconds,
    analysis_segment_start_seconds: body.analysis_segment_start_seconds,
    analysis_segment_end_seconds: body.analysis_segment_end_seconds,
    analysis_segment_duration_seconds: body.analysis_segment_duration_seconds,
    frame_rate: body.frame_rate,
    face_detection_scale: typeof body.face_detection_scale === 'number' ? body.face_detection_scale : undefined,
    min_face_size_pixels: typeof body.min_face_size_pixels === 'number' ? body.min_face_size_pixels : undefined,
    confidence_semantics: typeof body.confidence_semantics === 'string' ? body.confidence_semantics : undefined,
    offset_semantics: typeof body.offset_semantics === 'string' ? body.offset_semantics : undefined,
    analysis_duration_seconds: typeof body.analysis_duration_seconds === 'number' ? body.analysis_duration_seconds : undefined,
    tracks,
    message: typeof body.message === 'string' ? body.message : undefined,
  };
}
