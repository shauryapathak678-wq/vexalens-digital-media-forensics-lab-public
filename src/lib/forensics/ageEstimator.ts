export type FaceQualityState = 'good' | 'moderate' | 'poor';

export interface FaceQualityAssessment {
  state: FaceQualityState;
  metrics: {
    width_px: number;
    height_px: number;
    laplacian_variance: number;
    mean_brightness: number;
    contrast_std: number;
    clipped_fraction: number;
  };
  observations: string[];
}

export interface FaceAgeResult {
  face_number: number;
  /** [x, y, width, height] in source-image pixels. */
  bbox: [number, number, number, number];
  /** Raw detector score; it is not an age estimate or identity confidence. */
  detection_confidence: number;
  quality: FaceQualityAssessment;
  age_status: 'estimated' | 'unable_to_estimate';
  /** One of the local model's eight broad age-group labels; never an exact age. */
  age_range: string | null;
}

export interface AgeEstimateResponse {
  status: 'ok' | 'error';
  faces: FaceAgeResult[];
  model_name?: string;
  face_detector_name?: string;
  model_version?: string;
  processed_at?: string;
  image_size?: { width: number; height: number };
  limitations?: string[];
  message?: string;
  processingTimeMs: number;
}

interface ApiResponse extends Omit<AgeEstimateResponse, 'processingTimeMs'> {
  detail?: string;
}

async function readResponse(response: Response): Promise<ApiResponse> {
  const body = await response.text();
  if (!body.trim()) {
    throw new Error(`Local age-estimation service returned an empty response (HTTP ${response.status}).`);
  }

  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`Local age-estimation service returned an invalid response (HTTP ${response.status}).`);
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Local age-estimation service returned an invalid response (HTTP ${response.status}).`);
  }
  return data as ApiResponse;
}

export async function estimateAgesInImage(imageFile: File | Blob): Promise<AgeEstimateResponse> {
  const startTime = Date.now();
  const headers: Record<string, string> = {
    'Content-Type': imageFile.type || 'image/jpeg',
    'x-age-provider': 'local',
  };
  if (typeof File !== 'undefined' && imageFile instanceof File) {
    headers['x-file-name'] = imageFile.name;
  }

  try {
    const response = await fetch('/api/forensics/age-estimate', {
      method: 'POST',
      headers,
      body: await imageFile.arrayBuffer(),
      signal: AbortSignal.timeout(45_000),
    });
    const data = await readResponse(response);

    if (!response.ok || data.status !== 'ok' || !Array.isArray(data.faces)) {
      throw new Error(data.detail || data.message || `Local age-estimation request failed (HTTP ${response.status}).`);
    }

    return {
      ...data,
      status: 'ok',
      faces: data.faces as FaceAgeResult[],
      processingTimeMs: Date.now() - startTime,
    };
  } catch (error: unknown) {
    return {
      status: 'error',
      faces: [],
      message: error instanceof Error ? error.message : 'Local age-estimation request failed.',
      processingTimeMs: Date.now() - startTime,
    };
  }
}
