import { getSupabaseClient } from '@/lib/supabase';

export type DeepSafeModelId = 'npr_deepfakedetection' | 'universalfakedetect';
export type DeepSafeAssessment =
  | 'possible_ai_generated'
  | 'non_flagged_consistent'
  | 'inconclusive'
  | 'analysis_failed';
export type DeepSafeProcessingStatus = 'completed' | 'partial' | 'failed';

export interface DeepSafeModelResult {
  model_id: DeepSafeModelId;
  model_name: string;
  model_version: string;
  status: 'completed' | 'failed' | 'not_configured' | 'unavailable';
  score: number | null;
  raw_logit: number | null;
  score_type: string;
  score_meaning: string;
  threshold: number | null;
  classification: null;
  inference_time_seconds: number | null;
  raw_output: unknown;
  error: string | null;
}

export interface DeepSafeImageAnalysis {
  provider: 'DeepSafe';
  provider_revision: string;
  analysis_version: string;
  investigation_id: string;
  evidence_id: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  image: {
    mime_type: string;
    format: string;
    width: number;
    height: number;
    sha256: string;
  };
  models: Record<DeepSafeModelId, DeepSafeModelResult>;
  ensemble: {
    method: string;
    assessment: DeepSafeAssessment;
    fake_votes: number | null;
    total_votes: number | null;
    score: null;
    observations: string[];
  };
  processing_status: DeepSafeProcessingStatus;
  duration_ms: number;
  analyzed_at: string;
  error_detail: string | null;
}

export interface DeepSafeVideoFrameInput {
  frameIndex: number;
  timeSec: number;
  dataUrl?: string;
  sha256: string;
  status: 'analyzed' | 'skipped' | 'failed';
}

export const DEEPSAFE_VIDEO_FRAME_LIMIT = 3;
export const DEEPSAFE_MODEL_VERSION = '1.1.0';
export const DEEPSAFE_PROVIDER_REVISION = '2285e8aaa30b2df0508d570172643d1cae40703f';

export function formatDeepSafeScore(score: number): string {
  if (score === 0) return '0';
  if (Math.abs(score) < 0.001) return score.toExponential();
  return score.toString();
}

export function getDeepSafeLogScale(scores: readonly number[]): {
  minExponent: number;
  tickValues: number[];
} {
  const positiveScores = scores.filter((score) => Number.isFinite(score) && score > 0);
  const minExponent = positiveScores.length > 0
    ? Math.min(-6, Math.floor(Math.log10(Math.min(...positiveScores))) - 1)
    : -6;
  const exponentStep = Math.max(1, Math.ceil(Math.abs(minExponent) / 4));
  const tickValues: number[] = [];

  for (let exponent = 0; exponent > minExponent; exponent -= exponentStep) {
    tickValues.push(10 ** exponent);
  }

  return { minExponent, tickValues };
}

export function mapDeepSafeScoreToLogY(
  score: number,
  minExponent: number,
  chartTop: number,
  chartBottom: number,
): number {
  if (!Number.isFinite(score) || score <= 0) return chartBottom;
  const logScore = Math.log10(Math.min(score, 1));
  const normalized = (0 - logScore) / (0 - minExponent);
  return chartTop + Math.max(0, Math.min(1, normalized)) * (chartBottom - chartTop);
}

export function findReusableDeepSafeAnalysis(
  analyses: readonly DeepSafeImageAnalysis[],
  investigationId: string,
  evidenceId: string,
  sha256: string,
): DeepSafeImageAnalysis | null {
  const expectedHash = sha256.toLowerCase();
  return analyses.find((analysis) =>
    analysis.investigation_id === investigationId &&
    analysis.evidence_id === evidenceId &&
    analysis.analysis_version === '1.1.0' &&
    analysis.provider_revision === DEEPSAFE_PROVIDER_REVISION &&
    analysis.processing_status === 'completed' &&
    analysis.image.sha256.toLowerCase() === expectedHash &&
    analysis.models.npr_deepfakedetection.status === 'completed' &&
    analysis.models.npr_deepfakedetection.model_version === DEEPSAFE_MODEL_VERSION &&
    analysis.models.npr_deepfakedetection.score !== null &&
    analysis.models.npr_deepfakedetection.raw_logit !== null &&
    analysis.models.universalfakedetect.status === 'completed' &&
    analysis.models.universalfakedetect.model_version === DEEPSAFE_MODEL_VERSION &&
    analysis.models.universalfakedetect.score !== null &&
    analysis.models.universalfakedetect.raw_logit !== null,
  ) || null;
}

export function selectDeepSafeVideoFrames<T extends DeepSafeVideoFrameInput>(
  frames: readonly T[],
  sampleCount = DEEPSAFE_VIDEO_FRAME_LIMIT,
): T[] {
  const uniqueFrames = new Map<string, T>();
  frames.filter(
    (frame) => frame.status === 'analyzed' && Boolean(frame.dataUrl),
  ).forEach((frame) => {
    const hash = frame.sha256.toLowerCase();
    if (!uniqueFrames.has(hash)) uniqueFrames.set(hash, frame);
  });
  const availableFrames = [...uniqueFrames.values()];
  const requestedCount = Number.isInteger(sampleCount)
    ? Math.max(1, Math.min(DEEPSAFE_VIDEO_FRAME_LIMIT, sampleCount))
    : DEEPSAFE_VIDEO_FRAME_LIMIT;
  if (availableFrames.length <= requestedCount) return availableFrames;
  if (requestedCount === 1) {
    return [availableFrames[Math.round((availableFrames.length - 1) / 2)]];
  }

  return Array.from({ length: requestedCount }, (_, index) =>
    availableFrames[Math.round((index * (availableFrames.length - 1)) / (requestedCount - 1))],
  );
}

export interface DeepSafeModelHealth {
  status: 'available' | 'unavailable' | 'not_configured';
  model_name: string;
  model_version: string;
  loaded: boolean;
}

export interface DeepSafeHealth {
  available: boolean;
  models: Record<DeepSafeModelId, DeepSafeModelHealth>;
}

export class DeepSafeRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'DeepSafeRequestError';
    this.status = status;
  }
}

const MODEL_IDS: DeepSafeModelId[] = ['npr_deepfakedetection', 'universalfakedetect'];
const DEEPSAFE_AUTH_TIMEOUT_MS = 8_000;
const DEEPSAFE_ANALYSIS_TIMEOUT_MS = 110_000;
const ASSESSMENTS: DeepSafeAssessment[] = [
  'possible_ai_generated',
  'non_flagged_consistent',
  'inconclusive',
  'analysis_failed',
];
const PROCESSING_STATUSES: DeepSafeProcessingStatus[] = ['completed', 'partial', 'failed'];
const MODEL_STATUSES: DeepSafeModelResult['status'][] = [
  'completed',
  'failed',
  'not_configured',
  'unavailable',
];
const HEALTH_STATUSES: DeepSafeModelHealth['status'][] = [
  'available',
  'unavailable',
  'not_configured',
];

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && values.some((candidate) => candidate === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function getFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function getNullableFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeModelResult(value: unknown, expectedId: DeepSafeModelId): DeepSafeModelResult {
  if (!isRecord(value) || value.model_id !== expectedId) {
    throw new Error(`DeepSafe returned an invalid ${expectedId} model result.`);
  }
  const status = value.status;
  if (!isOneOf(status, MODEL_STATUSES)) {
    throw new Error(`DeepSafe returned an invalid status for ${expectedId}.`);
  }
  const score = value.score;
  if (
    status === 'completed' &&
    (
      typeof score !== 'number' ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 1
    )
  ) {
    throw new Error(`DeepSafe returned an invalid fake-class score for ${expectedId}.`);
  }
  const rawLogit = value.raw_logit;
  if (
    rawLogit !== undefined &&
    rawLogit !== null &&
    (typeof rawLogit !== 'number' || !Number.isFinite(rawLogit))
  ) {
    throw new Error(`DeepSafe returned an invalid raw logit for ${expectedId}.`);
  }
  return {
    model_id: expectedId,
    model_name: getString(value.model_name, expectedId),
    model_version: getString(value.model_version, 'unknown'),
    status,
    score: typeof score === 'number' && Number.isFinite(score) ? score : null,
    raw_logit: getNullableFiniteNumber(rawLogit),
    score_type: getString(value.score_type, 'uncalibrated_sigmoid_fake_class_logit'),
    score_meaning: getString(value.score_meaning, 'Uncalibrated sigmoid-transformed fake-class logit; not a probability of image origin.'),
    threshold: getNullableFiniteNumber(value.threshold),
    classification: null,
    inference_time_seconds: getFiniteNumber(value.inference_time_seconds, -1) >= 0
      ? getFiniteNumber(value.inference_time_seconds)
      : null,
    raw_output: value.raw_output ?? null,
    error: typeof value.error === 'string' && value.error ? value.error : null,
  };
}

export function parseDeepSafeAnalysis(value: unknown): DeepSafeImageAnalysis {
  if (!isRecord(value) || !isRecord(value.image) || !isRecord(value.models) || !isRecord(value.ensemble)) {
    throw new Error('DeepSafe returned an invalid analysis response.');
  }
  const image = value.image;
  const rawModels = value.models;
  const ensemble = value.ensemble;
  const assessment = ensemble.assessment;
  const processingStatus = value.processing_status;
  if (!isOneOf(assessment, ASSESSMENTS)) {
    throw new Error('DeepSafe returned an unsupported ensemble assessment.');
  }
  if (!isOneOf(processingStatus, PROCESSING_STATUSES)) {
    throw new Error('DeepSafe returned an unsupported processing status.');
  }
  if (
    typeof image.sha256 !== 'string' ||
    !/^[a-f\d]{64}$/i.test(image.sha256) ||
    typeof image.width !== 'number' ||
    typeof image.height !== 'number' ||
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width <= 0 ||
    image.height <= 0
  ) {
    throw new Error('DeepSafe returned invalid image metadata or SHA-256.');
  }
  const observations = ensemble.observations;
  if (!Array.isArray(observations) || observations.some((item) => typeof item !== 'string')) {
    throw new Error('DeepSafe returned invalid plain-language observations.');
  }
  const models = Object.fromEntries(
    MODEL_IDS.map((modelId) => [modelId, normalizeModelResult(rawModels[modelId], modelId)]),
  ) as Record<DeepSafeModelId, DeepSafeModelResult>;

  return {
    provider: 'DeepSafe',
    provider_revision: getString(value.provider_revision, 'unknown'),
    analysis_version: getString(value.analysis_version, 'unknown'),
    investigation_id: getString(value.investigation_id),
    evidence_id: getString(value.evidence_id),
    file_name: getString(value.file_name),
    mime_type: getString(value.mime_type, getString(image.mime_type)),
    file_size: getFiniteNumber(value.file_size),
    image: {
      mime_type: getString(image.mime_type),
      format: getString(image.format),
      width: image.width,
      height: image.height,
      sha256: image.sha256,
    },
    models,
    ensemble: {
      method: getString(ensemble.method),
      assessment,
      fake_votes: getNullableFiniteNumber(ensemble.fake_votes),
      total_votes: getNullableFiniteNumber(ensemble.total_votes),
      score: null,
      observations,
    },
    processing_status: processingStatus,
    duration_ms: getFiniteNumber(value.duration_ms),
    analyzed_at: getString(value.analyzed_at, new Date().toISOString()),
    error_detail: typeof value.error_detail === 'string' ? value.error_detail : null,
  };
}

export function createFailedDeepSafeAnalysis(
  evidence: {
    investigationId: string;
    id: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    sha256Hash: string;
    width: number;
    height: number;
  },
  errorMessage: string,
): DeepSafeImageAnalysis {
  const models = {
    npr_deepfakedetection: {
      model_id: 'npr_deepfakedetection',
      model_name: 'NPR Deepfake Detection',
      model_version: DEEPSAFE_MODEL_VERSION,
      status: 'unavailable',
      score: null,
      raw_logit: null,
      score_type: 'uncalibrated_sigmoid_fake_class_logit',
      score_meaning: 'No score was returned.',
      threshold: null,
      classification: null,
      inference_time_seconds: null,
      raw_output: null,
      error: errorMessage,
    },
    universalfakedetect: {
      model_id: 'universalfakedetect',
      model_name: 'UniversalFakeDetect',
      model_version: DEEPSAFE_MODEL_VERSION,
      status: 'unavailable',
      score: null,
      raw_logit: null,
      score_type: 'uncalibrated_sigmoid_fake_class_logit',
      score_meaning: 'No score was returned.',
      threshold: null,
      classification: null,
      inference_time_seconds: null,
      raw_output: null,
      error: errorMessage,
    },
  } satisfies Record<DeepSafeModelId, DeepSafeModelResult>;
  return {
    provider: 'DeepSafe',
    provider_revision: DEEPSAFE_PROVIDER_REVISION,
    analysis_version: '1.1.0',
    investigation_id: evidence.investigationId,
    evidence_id: evidence.id,
    file_name: evidence.fileName,
    mime_type: evidence.mimeType,
    file_size: evidence.fileSize,
    image: {
      mime_type: evidence.mimeType,
      format: evidence.mimeType === 'image/png' ? 'PNG' : 'JPEG',
      width: evidence.width,
      height: evidence.height,
      sha256: evidence.sha256Hash,
    },
    models,
    ensemble: {
      method: 'No aggregate verdict; inference failed before model results were returned.',
      assessment: 'analysis_failed',
      fake_votes: null,
      total_votes: null,
      score: null,
      observations: ['No usable model output was returned; image analysis failed.'],
    },
    processing_status: 'failed',
    duration_ms: 0,
    analyzed_at: new Date().toISOString(),
    error_detail: errorMessage,
  };
}

async function getAccessToken(refresh = false): Promise<string> {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase is not configured. Sign-in is required for DeepSafe analysis.');
  const sessionRequest = refresh
    ? client.auth.refreshSession().then(({ data, error }) => ({ session: data.session, error }))
    : client.auth.getSession().then(({ data, error }) => ({ session: data.session, error }));
  const { session, error } = await withTimeout(
    sessionRequest,
    DEEPSAFE_AUTH_TIMEOUT_MS,
    refresh
      ? 'Refreshing Supabase sign-in timed out. Sign in again and retry.'
      : 'Checking Supabase sign-in timed out. Check your connection and try again.',
  );
  if (error || !session?.access_token) {
    throw new Error(refresh
      ? 'Your Supabase session could not be refreshed. Sign in again and retry.'
      : 'Sign in with a Supabase account before running DeepSafe analysis.');
  }
  return session.access_token;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function fetchWithSupabaseSession(url: string, init: RequestInit): Promise<Response> {
  const send = async (accessToken: string) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${accessToken}`);
    return fetch(url, { ...init, headers });
  };

  const response = await send(await getAccessToken());
  if (response.status !== 401) return response;
  return send(await getAccessToken(true));
}

async function parseResponse(response: Response): Promise<unknown> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new DeepSafeRequestError(response.status, 'VexaLens returned an unreadable DeepSafe response.');
  }
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.error === 'string'
      ? payload.error
      : `DeepSafe request failed (HTTP ${response.status}).`;
    throw new DeepSafeRequestError(response.status, message);
  }
  return payload;
}

export async function analyzeDeepSafeEvidence(
  investigationId: string,
  evidenceId: string,
): Promise<DeepSafeImageAnalysis> {
  const response = await fetchWithSupabaseSession('/api/forensics/deepsafe-image/analyze', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ investigationId, evidenceId }),
    signal: AbortSignal.timeout(DEEPSAFE_ANALYSIS_TIMEOUT_MS),
  });
  return parseDeepSafeAnalysis(await parseResponse(response));
}

export async function analyzeDeepSafeVideoFrame(
  investigationId: string,
  evidenceId: string,
  frame: DeepSafeVideoFrameInput,
): Promise<DeepSafeImageAnalysis> {
  if (frame.status !== 'analyzed' || !frame.dataUrl) {
    throw new Error('DeepSafe requires an analyzed video frame image.');
  }
  const response = await fetchWithSupabaseSession('/api/forensics/deepsafe-video-frame/analyze', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      investigationId,
      evidenceId,
      frameIndex: frame.frameIndex,
      timeSec: frame.timeSec,
      frameDataUrl: frame.dataUrl,
    }),
    signal: AbortSignal.timeout(DEEPSAFE_ANALYSIS_TIMEOUT_MS),
  });
  const analysis = parseDeepSafeAnalysis(await parseResponse(response));
  if (analysis.image.sha256.toLowerCase() !== frame.sha256.toLowerCase()) {
    throw new Error('DeepSafe analyzed bytes that do not match the sampled video frame hash.');
  }
  return analysis;
}

export async function analyzeDeepSafeVideoFrames<T extends DeepSafeVideoFrameInput>(
  investigationId: string,
  evidenceId: string,
  frames: readonly T[],
): Promise<Array<{ frame: T; analysis?: DeepSafeImageAnalysis; error?: string }>> {
  if (frames.length === 0 || frames.length > DEEPSAFE_VIDEO_FRAME_LIMIT) {
    throw new Error(`DeepSafe accepts between 1 and ${DEEPSAFE_VIDEO_FRAME_LIMIT} selected video frames.`);
  }
  if (frames.some((frame) => frame.status !== 'analyzed' || !frame.dataUrl)) {
    throw new Error('DeepSafe requires an analyzed JPEG or PNG image for each selected video frame.');
  }

  const response = await fetchWithSupabaseSession('/api/forensics/deepsafe-video-frame/analyze', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      investigationId,
      evidenceId,
      frames: frames.map((frame) => ({
        frameIndex: frame.frameIndex,
        timeSec: frame.timeSec,
        frameDataUrl: frame.dataUrl,
      })),
    }),
    signal: AbortSignal.timeout(frames.length * DEEPSAFE_ANALYSIS_TIMEOUT_MS + 5_000),
  });
  let value: unknown;
  try {
    value = await parseResponse(response);
  } catch (error) {
    if (
      !(error instanceof DeepSafeRequestError) ||
      error.status !== 400 ||
      !/valid video evidence ID and sampled JPEG frame are required/i.test(error.message)
    ) {
      throw error;
    }

    const results: Array<{ frame: T; analysis?: DeepSafeImageAnalysis; error?: string }> = [];
    for (const [index, frame] of frames.entries()) {
      try {
        results.push({
          frame,
          analysis: await analyzeDeepSafeVideoFrame(investigationId, evidenceId, frame),
        });
      } catch (frameError) {
        const message = frameError instanceof Error
          ? frameError.message
          : 'DeepSafe frame analysis failed.';
        results.push({
          frame,
          error: message,
        });
        if (
          frameError instanceof DeepSafeRequestError &&
          frameError.status === 400 &&
          /valid video evidence ID and sampled JPEG frame are required/i.test(frameError.message)
        ) {
          results.push(...frames.slice(index + 1).map((remainingFrame) => ({
            frame: remainingFrame,
            error: message,
          })));
          break;
        }
      }
    }
    return results;
  }
  if (!isRecord(value) || !Array.isArray(value.frames) || value.frames.length !== frames.length) {
    throw new Error('VexaLens returned an incomplete DeepSafe video-frame batch.');
  }

  return value.frames.map((item, index) => {
    const frame = frames[index];
    if (
      !isRecord(item) ||
      item.frame_index !== frame.frameIndex ||
      item.time_sec !== frame.timeSec
    ) {
      throw new Error('VexaLens returned a video-frame result that does not match the request.');
    }
    if (typeof item.error === 'string' && item.error) {
      return { frame, error: item.error };
    }
    const analysis = parseDeepSafeAnalysis(item.analysis);
    if (analysis.image.sha256.toLowerCase() !== frame.sha256.toLowerCase()) {
      throw new Error('DeepSafe analyzed bytes that do not match a sampled video frame hash.');
    }
    return { frame, analysis };
  });
}

export async function fetchDeepSafeHealth(): Promise<DeepSafeHealth> {
  const response = await fetchWithSupabaseSession('/api/forensics/deepsafe-image/health', {
    signal: AbortSignal.timeout(7000),
  });
  const value = await parseResponse(response);
  if (!isRecord(value) || !isRecord(value.models)) {
    throw new Error('VexaLens returned an invalid DeepSafe health response.');
  }
  const healthModels = value.models;
  const models = Object.fromEntries(
    MODEL_IDS.map((modelId) => {
      const item = healthModels[modelId];
      if (!isRecord(item)) throw new Error(`DeepSafe health omitted ${modelId}.`);
      const status = item.status;
      if (!isOneOf(status, HEALTH_STATUSES)) {
        throw new Error(`DeepSafe health returned an invalid status for ${modelId}.`);
      }
      return [modelId, {
        status,
        model_name: getString(item.model_name, modelId),
        model_version: getString(item.model_version, 'unknown'),
        loaded: item.loaded === true,
      }];
    }),
  ) as Record<DeepSafeModelId, DeepSafeModelHealth>;
  return { available: value.available === true, models };
}
