export interface SightengineDeepfakeResult {
  score: number | null;
  scoreSource: 'provider' | 'mean_frames' | null;
  aiGeneratedScore: number | null;
  aiGeneratedScoreSource: 'provider' | 'mean_frames' | null;
  frames: SightengineDeepfakeFrame[];
  requestId: string | null;
}

export type SightengineMediaType = 'image' | 'video';

export interface SightengineDeepfakeFrame {
  positionSec: number | null;
  deepfakeScore: number | null;
  aiGeneratedScore: number | null;
}

interface SightengineResponse {
  status?: unknown;
  request?: { id?: unknown };
  type?: { deepfake?: unknown; ai_generated?: unknown };
  data?: {
    frames?: Array<{
      info?: { position?: unknown };
      type?: { deepfake?: unknown; ai_generated?: unknown };
    }>;
  };
  error?: { message?: unknown } | string;
}

function validScore(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function averageScore(scores: Array<number | null>): number | null {
  const validScores = scores.filter((score): score is number => score !== null);
  return validScores.length
    ? validScores.reduce((total, score) => total + score, 0) / validScores.length
    : null;
}

function getProviderError(data: SightengineResponse | null, responseText: string, status: number): string {
  const providerMessage = typeof data?.error === 'string'
    ? data.error
    : data?.error && typeof data.error.message === 'string'
      ? data.error.message
      : null;
  return (providerMessage || responseText.trim() || `Sightengine request failed (HTTP ${status}).`).slice(0, 500);
}

export async function analyzeSightengineDeepfake(
  media: Buffer,
  fileName: string,
  mimeType: string,
  mediaType: SightengineMediaType,
  apiUser: string,
  apiSecret: string
): Promise<SightengineDeepfakeResult> {
  const form = new FormData();
  const bytes = new Uint8Array(media.length);
  bytes.set(media);
  form.append('media', new Blob([bytes.buffer], { type: mimeType }), fileName);
  form.append('models', mediaType === 'video' ? 'deepfake,genai' : 'deepfake');
  form.append('api_user', apiUser);
  form.append('api_secret', apiSecret);
  if (mediaType === 'video') form.append('interval', '1');

  const endpoint = mediaType === 'video'
    ? 'https://api.sightengine.com/1.0/video/check-sync.json'
    : 'https://api.sightengine.com/1.0/check.json';
  const response = await fetch(endpoint, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const responseText = await response.text();
  let data: SightengineResponse | null = null;
  try {
    data = responseText ? JSON.parse(responseText) as SightengineResponse : null;
  } catch {
    data = null;
  }

  if (!response.ok || data?.status !== 'success') {
    const error = getProviderError(data, responseText, response.status)
      .replaceAll(apiUser, '[redacted]')
      .replaceAll(apiSecret, '[redacted]');
    throw new Error(error);
  }

  const frames = Array.isArray(data.data?.frames)
    ? data.data.frames.map((frame) => ({
      positionSec: typeof frame.info?.position === 'number' && Number.isFinite(frame.info.position)
        ? frame.info.position
        : null,
      deepfakeScore: validScore(frame.type?.deepfake),
      aiGeneratedScore: validScore(frame.type?.ai_generated),
    }))
    : [];
  const rawFrames = Array.isArray(data.data?.frames) ? data.data.frames : [];
  const hasInvalidFrameScore = rawFrames.some((frame) =>
    (frame.type?.deepfake !== undefined && validScore(frame.type.deepfake) === null) ||
    (frame.type?.ai_generated !== undefined && validScore(frame.type.ai_generated) === null)
  );
  if (
    hasInvalidFrameScore ||
    (data.type?.deepfake !== undefined && validScore(data.type.deepfake) === null) ||
    (data.type?.ai_generated !== undefined && validScore(data.type.ai_generated) === null)
  ) {
    throw new Error('Sightengine returned an invalid deepfake confidence score.');
  }

  const deepfakeFrameScores = frames.map((frame) => frame.deepfakeScore);
  const aiGeneratedFrameScores = frames.map((frame) => frame.aiGeneratedScore);
  const responseDeepfakeScore = validScore(data.type?.deepfake);
  const responseAiGeneratedScore = validScore(data.type?.ai_generated);
  const meanDeepfakeScore = averageScore(deepfakeFrameScores);
  const meanAiGeneratedScore = averageScore(aiGeneratedFrameScores);
  const score = responseDeepfakeScore ?? meanDeepfakeScore;
  const aiGeneratedScore = responseAiGeneratedScore ?? meanAiGeneratedScore;
  if (mediaType === 'image' && score === null) {
    throw new Error('Sightengine did not return a face-deepfake confidence score.');
  }
  if (mediaType === 'video' && score === null && frames.length === 0) {
    throw new Error('Sightengine returned no video-level or frame-level deepfake results.');
  }

  return {
    score,
    scoreSource: responseDeepfakeScore !== null ? 'provider' : meanDeepfakeScore !== null ? 'mean_frames' : null,
    aiGeneratedScore,
    aiGeneratedScoreSource: responseAiGeneratedScore !== null
      ? 'provider'
      : meanAiGeneratedScore !== null
        ? 'mean_frames'
        : null,
    frames,
    requestId: typeof data.request?.id === 'string' ? data.request.id : null,
  };
}
