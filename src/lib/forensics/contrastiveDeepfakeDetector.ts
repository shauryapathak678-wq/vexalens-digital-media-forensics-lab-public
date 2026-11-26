export type ContrastiveDeepfakeAssessment =
  | 'possible_deepfake'
  | 'no_strong_signal'
  | 'no_face_detected';

export interface ContrastiveDeepfakeResult {
  assessment: ContrastiveDeepfakeAssessment;
  label: string;
  fake_score: number | null;
  face: { x: number; y: number; width: number; height: number } | null;
  model_id: string;
  model_url: string;
  limitations: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAssessment(value: unknown): value is ContrastiveDeepfakeAssessment {
  return value === 'possible_deepfake' || value === 'no_strong_signal' || value === 'no_face_detected';
}

function isFaceBox(value: unknown): value is NonNullable<ContrastiveDeepfakeResult['face']> {
  return isRecord(value) &&
    ['x', 'y', 'width', 'height'].every((key) =>
      typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0
    ) &&
    typeof value.width === 'number' && value.width > 0 &&
    typeof value.height === 'number' && value.height > 0;
}

export async function analyzeContrastiveDeepfake(
  file: File,
  signal?: AbortSignal,
): Promise<ContrastiveDeepfakeResult> {
  const response = await fetch('/api/forensics/contrastive-deepfake', {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
    signal,
  });

  let responseText: string;
  try {
    responseText = await response.text();
  } catch {
    throw new Error(`The local deepfake detector request failed (HTTP ${response.status}).`);
  }

  let payload: unknown;
  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch {
    if (response.status === 404) {
      throw new Error('The local deepfake endpoint is not loaded. Restart VexaLens and try again.');
    }
    throw new Error(
      response.ok
        ? 'The local deepfake detector returned an unreadable response.'
        : `The local deepfake detector failed (HTTP ${response.status}). Restart VexaLens and try again.`,
    );
  }

  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.error === 'string'
      ? payload.error
      : 'The local deepfake detector could not analyze this image.';
    throw new Error(message);
  }

  if (!isRecord(payload)) {
    throw new Error('The local deepfake detector returned an invalid result.');
  }

  const assessment = payload.assessment;
  const label = payload.label;
  const fakeScore = payload.fake_score;
  const face = payload.face;
  const modelId = payload.model_id;
  const modelUrl = payload.model_url;
  const limitations = payload.limitations;
  if (
    !isAssessment(assessment) ||
    typeof label !== 'string' ||
    (fakeScore !== null &&
      (typeof fakeScore !== 'number' || !Number.isFinite(fakeScore) || fakeScore < 0 || fakeScore > 1)) ||
    (face !== null && !isFaceBox(face)) ||
    typeof modelId !== 'string' ||
    typeof modelUrl !== 'string' ||
    !Array.isArray(limitations) ||
    !limitations.every((item): item is string => typeof item === 'string')
  ) {
    throw new Error('The local deepfake detector returned an invalid result.');
  }
  if (
    (assessment === 'no_face_detected' && (fakeScore !== null || face !== null)) ||
    (assessment !== 'no_face_detected' && (fakeScore === null || face === null))
  ) {
    throw new Error('The local deepfake detector returned an inconsistent result.');
  }

  return {
    assessment,
    label,
    fake_score: fakeScore,
    face,
    model_id: modelId,
    model_url: modelUrl,
    limitations,
  };
}
