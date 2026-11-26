export interface GenderRecognitionAgeResult {
  status: 'ok';
  provider: 'gender_recognition';
  faces: Array<{
    age: number;
    score: number;
    bbox: [number, number, number, number];
    class: string;
  }>;
  remainingCredits: number | null;
}

const GENDER_RECOGNITION_AGE_URL = 'https://api.genderrecognition.com/v1/image-gender/api/age';

function ageClass(age: number): string {
  if (age < 13) return 'Age - Child';
  if (age < 18) return 'Age - Teenager';
  if (age < 35) return 'Age - Young Adult';
  if (age < 55) return 'Age - Adult';
  return 'Age - Mature Adult';
}

export async function estimateAgeWithGenderRecognition(
  apiKey: string,
  imageBuffer: Buffer,
  fileName: string,
  contentType: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GenderRecognitionAgeResult> {
  const key = apiKey.trim();
  if (!key) throw new Error('GenderRecognition API key is required.');
  if (imageBuffer.length > 10 * 1024 * 1024) throw new Error('Uploaded file exceeds the 10MB size limit');

  const form = new FormData();
  const blob = new Blob([new Uint8Array(imageBuffer)], { type: contentType || 'application/octet-stream' });
  form.append('file', blob, fileName || 'image.jpg');

  const response = await fetchImpl(GENDER_RECOGNITION_AGE_URL, {
    method: 'POST',
    headers: { apiKey: key },
    body: form,
    signal: AbortSignal.timeout(45_000),
  });

  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(text.trim() || `GenderRecognition returned HTTP ${response.status}`);
  }

  if (!response.ok || !data || typeof data !== 'object') {
    const error = (data as any)?.error;
    if (typeof error === 'string') throw new Error(error);
    if (error && typeof error === 'object') {
      throw new Error(error.message || error.code || 'GenderRecognition request failed');
    }
    throw new Error(`GenderRecognition request failed (HTTP ${response.status})`);
  }

  const payload = data as Record<string, unknown>;
  if (payload.success !== true || !Array.isArray(payload.detections)) {
    throw new Error('GenderRecognition returned an invalid age response');
  }

  const faces = payload.detections.flatMap((detection: unknown) => {
    if (!detection || typeof detection !== 'object' || Array.isArray(detection)) return [];
    const item = detection as Record<string, unknown>;
    if (typeof item.age !== 'number' || !Number.isFinite(item.age)) return [];
    const probability = typeof item.probability === 'number' ? item.probability : 0;
    return [{
      age: item.age,
      score: Math.max(0, Math.min(1, probability / 100)),
      bbox: [0, 0, 0, 0] as [number, number, number, number],
      class: ageClass(item.age),
    }];
  });

  return {
    status: 'ok',
    provider: 'gender_recognition',
    faces,
    remainingCredits: typeof payload.remainingRequests === 'number' ? payload.remainingRequests : null,
  };
}
