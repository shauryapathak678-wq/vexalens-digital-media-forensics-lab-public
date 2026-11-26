export interface GenConViTStatus {
  configured: boolean;
  model: 'GenConViT';
  model_version: string;
  device: string;
  num_sampled_frames: number;
  rapid_face_search_frames: number;
  max_video_duration_seconds: number;
  max_video_bytes: number;
  missing_dependencies: string[];
  missing_files: string[];
  category: string;
  fast_model_ready: boolean;
  fast_model_loading: boolean;
  fast_model_error: string | null;
}

export interface GenConViTAnalysisResult {
  status: 'completed';
  analysis_mode: GenConViTAnalysisMode;
  model: 'GenConViT';
  model_version: string;
  predicted_class: 'REAL' | 'FAKE';
  fake_score: number;
  real_score: number;
  score_semantics: string;
  sampled_frames: number;
  faces_detected: number;
  frames_with_faces: number;
  face_search_frames: number;
  video_fps: number;
  video_duration_seconds: number;
  inference_seconds: number;
  analysis_timestamp: string;
  device: string;
  classification_scope: string;
  source_sha256: string;
}

export type GenConViTAnalysisMode = 'rapid';

export const GENCONVIT_MAX_VIDEO_BYTES = 128 * 1024 * 1024;

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`The local GenConViT service returned an invalid response (HTTP ${response.status}).`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`The local GenConViT service returned an invalid response (HTTP ${response.status}).`);
  }
  return value as Record<string, unknown>;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export async function getGenConViTStatus(): Promise<GenConViTStatus> {
  const response = await fetch('/api/lipsync/genconvit/health', {
    signal: AbortSignal.timeout(12_000),
  });
  const body = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : 'The local GenConViT service is unavailable.');
  }
  if (
    typeof body.configured !== 'boolean' ||
    body.model !== 'GenConViT' ||
    typeof body.model_version !== 'string' ||
    typeof body.device !== 'string' ||
    typeof body.num_sampled_frames !== 'number' ||
    typeof body.rapid_face_search_frames !== 'number' ||
    typeof body.max_video_duration_seconds !== 'number' ||
    typeof body.max_video_bytes !== 'number' ||
    !isStringArray(body.missing_dependencies) ||
    !isStringArray(body.missing_files) ||
    typeof body.category !== 'string' ||
    typeof body.fast_model_ready !== 'boolean' ||
    typeof body.fast_model_loading !== 'boolean' ||
    (body.fast_model_error !== null && typeof body.fast_model_error !== 'string')
  ) {
    throw new Error('The local GenConViT service returned an invalid readiness response.');
  }
  return {
    configured: body.configured,
    model: 'GenConViT',
    model_version: body.model_version,
    device: body.device,
    num_sampled_frames: body.num_sampled_frames,
    rapid_face_search_frames: body.rapid_face_search_frames,
    max_video_duration_seconds: body.max_video_duration_seconds,
    max_video_bytes: body.max_video_bytes,
    missing_dependencies: body.missing_dependencies,
    missing_files: body.missing_files,
    category: body.category,
    fast_model_ready: body.fast_model_ready,
    fast_model_loading: body.fast_model_loading,
    fast_model_error: body.fast_model_error,
  };
}

export async function analyzeGenConViTVideo(
  video: Blob,
  extension: string,
  evidenceSha256: string,
): Promise<GenConViTAnalysisResult> {
  if (!/^\.[a-z0-9]{3,4}$/i.test(extension)) throw new Error('Choose a supported video file.');
  if (!/^[a-f0-9]{64}$/i.test(evidenceSha256)) throw new Error('A valid evidence SHA-256 is required.');
  if (video.size === 0) throw new Error('The selected video file is empty.');
  if (video.size > GENCONVIT_MAX_VIDEO_BYTES) throw new Error('GenConViT accepts videos up to 128 MB.');

  let response: Response;
  try {
    response = await fetch('/api/lipsync/genconvit/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Evidence-Sha256': evidenceSha256,
        'X-File-Extension': extension,
        'X-Analysis-Mode': 'rapid',
      },
      body: video,
      signal: AbortSignal.timeout(50_000),
    });
  } catch (requestError) {
    if (requestError instanceof Error && requestError.name === 'TimeoutError') {
      throw new Error('Rapid screening exceeded its 50-second limit on this host. No result was returned.');
    }
    throw requestError;
  }
  const body = await readJsonResponse(response);
  if (!response.ok) {
    const detail = typeof body.detail === 'string'
      ? body.detail
      : typeof body.error === 'string'
        ? body.error
        : 'GenConViT video screening failed.';
    throw new Error(detail);
  }
  if (
    body.status !== 'completed' ||
    body.analysis_mode !== 'rapid' ||
    body.model !== 'GenConViT' ||
    typeof body.model_version !== 'string' ||
    (body.predicted_class !== 'REAL' && body.predicted_class !== 'FAKE') ||
    typeof body.fake_score !== 'number' ||
    typeof body.real_score !== 'number' ||
    !Number.isFinite(body.fake_score) ||
    !Number.isFinite(body.real_score) ||
    body.fake_score < 0 ||
    body.fake_score > 1 ||
    body.real_score < 0 ||
    body.real_score > 1 ||
    typeof body.score_semantics !== 'string' ||
    typeof body.sampled_frames !== 'number' ||
    typeof body.faces_detected !== 'number' ||
    typeof body.frames_with_faces !== 'number' ||
    typeof body.face_search_frames !== 'number' ||
    typeof body.video_fps !== 'number' ||
    typeof body.video_duration_seconds !== 'number' ||
    typeof body.inference_seconds !== 'number' ||
    typeof body.analysis_timestamp !== 'string' ||
    typeof body.device !== 'string' ||
    typeof body.classification_scope !== 'string' ||
    typeof body.source_sha256 !== 'string'
  ) {
    throw new Error('The local GenConViT service returned an invalid analysis response.');
  }
  return {
    status: 'completed',
    analysis_mode: 'rapid',
    model: 'GenConViT',
    model_version: body.model_version,
    predicted_class: body.predicted_class,
    fake_score: body.fake_score,
    real_score: body.real_score,
    score_semantics: body.score_semantics,
    sampled_frames: body.sampled_frames,
    faces_detected: body.faces_detected,
    frames_with_faces: body.frames_with_faces,
    face_search_frames: body.face_search_frames,
    video_fps: body.video_fps,
    video_duration_seconds: body.video_duration_seconds,
    inference_seconds: body.inference_seconds,
    analysis_timestamp: body.analysis_timestamp,
    device: body.device,
    classification_scope: body.classification_scope,
    source_sha256: body.source_sha256,
  };
}
