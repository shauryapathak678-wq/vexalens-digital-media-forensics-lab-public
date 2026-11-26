export type SightengineMediaType = 'image' | 'video';

export interface SightengineDeepfakeResult {
  score: number | null;
  scoreSource: 'provider' | 'mean_frames' | null;
  aiGeneratedScore: number | null;
  aiGeneratedScoreSource: 'provider' | 'mean_frames' | null;
  frames: SightengineDeepfakeFrame[];
  requestId: string | null;
}

export interface SightengineDeepfakeFrame {
  positionSec: number | null;
  deepfakeScore: number | null;
  aiGeneratedScore: number | null;
}

export interface SightengineCredentialsStatus {
  configured: boolean;
  hasUser: boolean;
  hasSecret: boolean;
  maskedUser: string | null;
  maskedSecret: string | null;
}

const SIGHTENGINE_USER_STORAGE_KEY = 'vexalens_sightengine_api_user';
const SIGHTENGINE_SECRET_STORAGE_KEY = 'vexalens_sightengine_api_secret';

export function getStoredSightengineUser(): string {
  try {
    return localStorage.getItem(SIGHTENGINE_USER_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function getStoredSightengineSecret(): string {
  try {
    return localStorage.getItem(SIGHTENGINE_SECRET_STORAGE_KEY) || '';
  } catch {
    return '';
  }
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

async function readApiResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const readableText = text.startsWith('<')
      ? text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
      : text.trim();
    return { error: readableText.slice(0, 500) };
  }
}

async function validateVideoDuration(media: Blob): Promise<void> {
  const videoUrl = URL.createObjectURL(media);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.src = videoUrl;

  try {
    const duration = await new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Could not read the selected video duration.')), 15_000);
      video.onloadedmetadata = () => {
        window.clearTimeout(timeout);
        resolve(video.duration);
      };
      video.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error('The selected video could not be decoded to check its duration.'));
      };
    });
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Sightengine requires a video with a readable duration.');
    }
    if (duration >= 60) {
      throw new Error('Sightengine synchronous deepfake analysis supports videos shorter than 60 seconds. Trim the video and retry.');
    }
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(videoUrl);
  }
}

export async function fetchSightengineCredentialsStatus(): Promise<SightengineCredentialsStatus> {
  const localUser = getStoredSightengineUser();
  const localSecret = getStoredSightengineSecret();

  // Build a local status from explicitly configured localStorage values.
  const localStatus: SightengineCredentialsStatus = {
    configured: Boolean(localUser && localSecret),
    hasUser: Boolean(localUser),
    hasSecret: Boolean(localSecret),
    maskedUser: localUser ? (localUser.length > 4 ? `${localUser.slice(0, 2)}...${localUser.slice(-2)}` : '***') : null,
    maskedSecret: localSecret ? `${localSecret.slice(0, 4)}...${localSecret.slice(-4)}` : null,
  };

  try {
    const response = await fetch('/api/forensics/sightengine/credentials');
    if (response.ok) {
      const data = await response.json() as SightengineCredentialsStatus;
      if (data && data.configured) return data;
      if (data && data.hasUser && data.hasSecret) return { ...data, configured: true };
      // Server says not configured, but explicitly configured local credentials may still be used.
      if (localStatus.configured) return localStatus;
    }
  } catch {}

  return localStatus;
}

export async function updateSightengineCredentials(
  apiUser: string,
  apiSecret: string
): Promise<{ success: boolean; configured: boolean; message: string }> {
  try {
    localStorage.setItem(SIGHTENGINE_USER_STORAGE_KEY, apiUser);
    localStorage.setItem(SIGHTENGINE_SECRET_STORAGE_KEY, apiSecret);
  } catch {}

  try {
    const response = await fetch('/api/forensics/sightengine/credentials', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiUser, apiSecret }),
    });
    const data = await readApiResponse(response);
    if (response.ok && data && typeof data === 'object' && 'success' in data) {
      return data as { success: boolean; configured: boolean; message: string };
    }
  } catch {}

  return {
    success: true,
    configured: Boolean(apiUser && apiSecret),
    message: 'Sightengine credentials saved successfully.',
  };
}

function parseSightengineResponse(data: unknown, mediaType: SightengineMediaType): SightengineDeepfakeResult {
  if (!data || typeof data !== 'object') {
    throw new Error('Sightengine returned an invalid deepfake analysis response.');
  }

  const raw = data as Record<string, any>;

  // Format 1: Already normalized by VexaLens server
  if ('score' in raw && 'frames' in raw) {
    const frames = Array.isArray(raw.frames)
      ? raw.frames.map((frame: any) => ({
          positionSec: typeof frame.positionSec === 'number' ? frame.positionSec : null,
          deepfakeScore: validScore(frame.deepfakeScore),
          aiGeneratedScore: validScore(frame.aiGeneratedScore),
        }))
      : [];
    return {
      score: validScore(raw.score),
      scoreSource: raw.scoreSource || null,
      aiGeneratedScore: validScore(raw.aiGeneratedScore),
      aiGeneratedScoreSource: raw.aiGeneratedScoreSource || null,
      frames,
      requestId: typeof raw.requestId === 'string' ? raw.requestId : null,
    };
  }

  // Format 2: Direct raw Sightengine provider response
  const rawFrames = Array.isArray(raw.data?.frames) ? raw.data.frames : [];
  const frames = rawFrames.map((frame: any) => ({
    positionSec: typeof frame.info?.position === 'number' ? frame.info.position : null,
    deepfakeScore: validScore(frame.type?.deepfake),
    aiGeneratedScore: validScore(frame.type?.ai_generated),
  }));

  const responseDeepfakeScore = validScore(raw.type?.deepfake);
  const responseAiGeneratedScore = validScore(raw.type?.ai_generated);
  const meanDeepfakeScore = averageScore(frames.map((f: any) => f.deepfakeScore));
  const meanAiGeneratedScore = averageScore(frames.map((f: any) => f.aiGeneratedScore));

  const score = responseDeepfakeScore ?? meanDeepfakeScore;
  const aiGeneratedScore = responseAiGeneratedScore ?? meanAiGeneratedScore;

  if (mediaType === 'image' && score === null) {
    throw new Error('Sightengine did not return a face-deepfake confidence score.');
  }

  return {
    score,
    scoreSource: responseDeepfakeScore !== null ? 'provider' : meanDeepfakeScore !== null ? 'mean_frames' : null,
    aiGeneratedScore,
    aiGeneratedScoreSource: responseAiGeneratedScore !== null ? 'provider' : meanAiGeneratedScore !== null ? 'mean_frames' : null,
    frames,
    requestId: typeof raw.request?.id === 'string' ? raw.request.id : null,
  };
}

export async function analyzeSightengineDeepfake(
  previewUrl: string,
  fileName: string,
  mediaType: SightengineMediaType
): Promise<SightengineDeepfakeResult> {
  const mediaResponse = await fetch(previewUrl);
  if (!mediaResponse.ok) {
    throw new Error(`Could not read the selected evidence file (HTTP ${mediaResponse.status}).`);
  }
  const media = await mediaResponse.blob();
  if (media.size === 0) {
    throw new Error('The selected evidence file is empty.');
  }
  if (mediaType === 'video') await validateVideoDuration(media);

  const apiUser = getStoredSightengineUser();
  const apiSecret = getStoredSightengineSecret();

  const query = new URLSearchParams({
    mediaType,
    apiUser,
    apiSecret,
  });

  let serverError: string | null = null;

  // Step 1: Call through backend server proxy
  try {
    const response = await fetch(`/api/forensics/sightengine-deepfake?${query}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(fileName),
        'X-Media-Mime-Type': media.type || 'application/octet-stream',
        'X-Sightengine-Api-User': apiUser,
        'X-Sightengine-Api-Secret': apiSecret,
      },
      body: media,
    });
    const data = await readApiResponse(response);
    if (response.ok && data) {
      return parseSightengineResponse(data, mediaType);
    }
    serverError = data && typeof data === 'object' && 'error' in data && typeof (data as any).error === 'string'
      ? (data as any).error
      : `Sightengine deepfake analysis failed (HTTP ${response.status}).`;
  } catch (err) {
    serverError = err instanceof Error ? err.message : 'Server proxy connection failed.';
  }

  // Step 2: Direct browser fallback to Sightengine API
  try {
    const form = new FormData();
    form.append('media', media, fileName);
    form.append('models', mediaType === 'video' ? 'deepfake' : 'deepfake');
    form.append('api_user', apiUser);
    form.append('api_secret', apiSecret);
    if (mediaType === 'video') form.append('interval', '1');

    const endpoint = mediaType === 'video'
      ? 'https://api.sightengine.com/1.0/video/check-sync.json'
      : 'https://api.sightengine.com/1.0/check.json';

    const directResponse = await fetch(endpoint, {
      method: 'POST',
      body: form,
    });
    const directData = await readApiResponse(directResponse);
    if (directResponse.ok && directData && typeof directData === 'object' && (directData as any).status === 'success') {
      return parseSightengineResponse(directData, mediaType);
    }
    const directMsg = directData && typeof directData === 'object' && 'error' in directData && (directData as any).error?.message
      ? (directData as any).error.message
      : directData && typeof directData === 'object' && 'error' in directData && typeof (directData as any).error === 'string'
      ? (directData as any).error
      : null;
    if (directMsg) {
      throw new Error(`Sightengine: ${directMsg}`);
    }
  } catch (directErr) {
    if (directErr instanceof Error && directErr.message.startsWith('Sightengine:')) {
      throw directErr;
    }
  }

  throw new Error(serverError || 'Sightengine deepfake analysis failed.');
}
