export type TruthScanVideoModel = 'generic' | 'faceswap';
export type TruthScanVideoStatus = 'pending' | 'analyzing' | 'done' | 'failed' | string;

export interface TruthScanVideoResult {
  id: string;
  status: TruthScanVideoStatus;
  result?: number;
  result_details?: {
    final_stage?: string;
    final_result?: string | null;
    detection_step?: number | null;
    confidence?: number | null;
    ml_model?: unknown[] | null;
    ocr?: unknown[] | null;
    metadata?: {
      status?: string;
      prediction?: string;
      confidence?: number;
    };
    watermark?: {
      prediction?: string;
      confidence?: number;
    };
    ml?: {
      aggregate?: {
        prob_fake?: number;
        label?: string;
        n_frames?: number;
        latency_sec?: number;
      };
    };
    latency_sec?: number;
  };
  preview_url?: string | null;
}

export interface TruthScanVideoPresentation {
  verdict: string;
  aiLikelihoodPercent: number | null;
  providerScore: number | null;
  finalStage: string;
  watermark: string;
  framesAnalyzed: number | null;
}

export interface TruthScanVideoCredits {
  credits: number;
  baseCredits: number;
  boostCredits: number;
}

function getFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function getTruthScanVideoPresentation(result: TruthScanVideoResult): TruthScanVideoPresentation {
  const details = result.result_details;
  const aggregate = details?.ml?.aggregate;
  const probability = getFiniteNumber(aggregate?.prob_fake);
  const mlModel = Array.isArray(details?.ml_model) ? details.ml_model : [];
  const verdict = details?.final_result
    || (typeof mlModel[0] === 'string' ? mlModel[0] : null)
    || aggregate?.label
    || 'Completed';
  const providerScore = getFiniteNumber(details?.confidence)
    ?? getFiniteNumber(mlModel[1])
    ?? getFiniteNumber(result.result);
  const watermark = details?.watermark?.prediction
    || (typeof details?.ocr?.[0] === 'string' ? details.ocr[0] : null)
    || 'Not reported';
  const finalStage = details?.final_stage
    || (typeof details?.detection_step === 'number' ? `Step ${details.detection_step}` : 'Not reported');

  return {
    verdict,
    aiLikelihoodPercent: probability === null
      ? null
      : Math.round(Math.max(0, Math.min(1, probability)) * 1000) / 10,
    providerScore,
    finalStage,
    watermark,
    framesAnalyzed: getFiniteNumber(aggregate?.n_frames),
  };
}

async function parseApiResponse(response: Response): Promise<TruthScanVideoResult> {
  const responseText = await response.text();
  let data: unknown = null;
  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const errorData = data && typeof data === 'object'
      ? data as { error?: unknown; message?: unknown; detail?: unknown }
      : null;
    const providerMessage = [errorData?.error, errorData?.message, errorData?.detail]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    const message = providerMessage || responseText.trim() || `TruthScan video request failed (HTTP ${response.status}).`;
    throw new Error(message);
  }
  if (!data || typeof data !== 'object' || !('id' in data) || typeof data.id !== 'string' ||
      !('status' in data) || typeof data.status !== 'string') {
    throw new Error('TruthScan returned an invalid video detection response.');
  }
  return data as TruthScanVideoResult;
}

export async function getTruthScanVideoCredits(): Promise<TruthScanVideoCredits> {
  const response = await fetch('/api/forensics/ai-video-credits');
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
      ? data.error
      : `TruthScan credit check failed (HTTP ${response.status}).`;
    throw new Error(message);
  }
  if (!data || typeof data !== 'object' || !('credits' in data) || typeof data.credits !== 'number') {
    throw new Error('TruthScan returned an invalid video credit balance.');
  }
  return {
    credits: data.credits,
    baseCredits: 'baseCredits' in data && typeof data.baseCredits === 'number' ? data.baseCredits : 0,
    boostCredits: 'boostCredits' in data && typeof data.boostCredits === 'number' ? data.boostCredits : 0,
  };
}

export async function submitTruthScanVideo(
  video: Blob,
  fileName: string,
  model: TruthScanVideoModel
): Promise<TruthScanVideoResult> {
  const response = await fetch(`/api/forensics/ai-video-detect?model=${model}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(fileName),
      'X-Video-Mime-Type': video.type || 'video/mp4',
    },
    body: video,
  });
  return parseApiResponse(response);
}

export async function queryTruthScanVideo(jobId: string): Promise<TruthScanVideoResult> {
  const response = await fetch('/api/forensics/ai-video-query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: jobId }),
  });
  return parseApiResponse(response);
}
