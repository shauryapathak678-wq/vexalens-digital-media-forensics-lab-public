export interface DeepSeekAgeResult {
  status: 'ok';
  provider: 'deepseek';
  faces: Array<{ age: number; score: number; bbox: [number, number, number, number]; class: string }>;
  message: string;
}

const DEEPSEEK_CHAT_URL = 'https://pathakshaurya0912007--ep-deepseek-v4-1-flash-server.us-west.modal.direct/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash';

function ageClass(age: number): string {
  if (age < 13) return 'Age - Child';
  if (age < 18) return 'Age - Teenager';
  if (age < 35) return 'Age - Young Adult';
  if (age < 55) return 'Age - Adult';
  return 'Age - Mature Adult';
}

function parseJsonObject(content: string): Record<string, unknown> {
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleaned);
}

export async function estimateAgeWithDeepSeek(
  tokenId: string,
  tokenSecret: string,
  imageBuffer: Buffer,
  contentType: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeepSeekAgeResult> {
  const id = tokenId.trim();
  const secret = tokenSecret.trim();
  if (!id || !secret) throw new Error('Modal proxy token credentials are required.');
  if (imageBuffer.length > 20 * 1024 * 1024) throw new Error('Image must be smaller than 20 MB for this request.');

  const mimeType = contentType || 'image/jpeg';
  const dataUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
  const prompt = `Analyze the attached image and estimate the apparent age of each clearly visible human face.
Return only valid JSON with exactly this shape:
{"faces":[{"age":number,"confidence":number,"explanation":"short simple sentence"}],"summary":"short simple sentence"}
The age is a decimal when useful. Confidence must be 0 to 100 and means certainty about the age estimate, not gender. Do not identify real people. If no face is detected, use {"faces":[],"summary":"No clearly visible human face was detected."}`;

  const response = await fetchImpl(DEEPSEEK_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${id}.${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: 'You are a careful image age-estimation assistant. Be concise. Never claim identity or precise legal age.' },
        { role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ] },
      ],
      temperature: 0.2,
      max_tokens: 1024,
      top_p: 0.9,
      stream: false,
      reasoning_effort: 'high',
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(text.trim() ? `DeepSeek returned a non-JSON response (HTTP ${response.status})` : `DeepSeek returned an empty response (HTTP ${response.status})`);
  }

  if (!response.ok) {
    const rawError = typeof data?.error?.message === 'string'
      ? data.error.message
      : typeof data?.error === 'string'
        ? data.error
        : String(data?.error || '');
    if (/webhook token secret validation failure|invalid.*token|token.*invalid/i.test(rawError) || response.status === 401) {
      throw new Error('Modal proxy credentials are invalid or have been rotated. Generate a new token ID and secret pair and update the server environment.');
    }
    throw new Error(rawError || `DeepSeek request failed (HTTP ${response.status})`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('DeepSeek returned no image analysis content.');

  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonObject(content);
  } catch {
    throw new Error('DeepSeek returned invalid JSON for age estimation.');
  }

  const detections = Array.isArray(parsed.faces) ? parsed.faces : [];
  const faces = detections.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const face = item as Record<string, unknown>;
    if (typeof face.age !== 'number' || !Number.isFinite(face.age)) return [];
    const confidence = typeof face.confidence === 'number'
      ? Math.max(0, Math.min(100, face.confidence))
      : 0;
    return [{
      age: face.age,
      score: confidence / 100,
      bbox: [0, 0, 0, 0] as [number, number, number, number],
      class: ageClass(face.age),
    }];
  });

  return {
    status: 'ok',
    provider: 'deepseek',
    faces,
    message: typeof parsed.summary === 'string'
      ? parsed.summary
      : `${faces.length} ${faces.length === 1 ? 'face' : 'faces'} detected. These are probabilistic estimates, not confirmed ages.`,
  };
}
