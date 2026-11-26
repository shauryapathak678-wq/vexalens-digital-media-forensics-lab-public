export interface EverypixelFace {
  age: number;
  score: number;
  bbox: [number, number, number, number];
  class: string;
}

export interface EverypixelAgeResult {
  status: 'ok';
  provider: 'everypixel';
  faces: EverypixelFace[];
}

export type EverypixelImageInput =
  | { buffer: Buffer; fileName: string; contentType: string }
  | { url: string };

const EVERYPIXEL_FACES_URL = 'https://api.everypixel.com/v1/faces';

function parseEverypixelFaces(data: unknown): EverypixelFace[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Everypixel returned an invalid response.');
  }

  const result = data as Record<string, unknown>;
  if (result.status !== 'ok') {
    const message = result.error && typeof result.error === 'object'
      ? (result.error as Record<string, unknown>).message
      : result.message;
    throw new Error(typeof message === 'string' ? message : 'Everypixel did not accept the image.');
  }

  if (!Array.isArray(result.faces)) {
    throw new Error('Everypixel response did not include a faces array.');
  }

  return result.faces.map((face: unknown, index) => {
    if (!face || typeof face !== 'object' || Array.isArray(face)) {
      throw new Error(`Everypixel returned invalid face data at index ${index}.`);
    }

    const item = face as Record<string, unknown>;
    const bbox = item.bbox;
    if (
      typeof item.age !== 'number'
      || !Number.isFinite(item.age)
      || typeof item.score !== 'number'
      || !Number.isFinite(item.score)
      || !Array.isArray(bbox)
      || bbox.length !== 4
      || !bbox.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))
      || typeof item.class !== 'string'
    ) {
      throw new Error(`Everypixel returned incomplete face data at index ${index}.`);
    }

    return {
      age: item.age,
      score: item.score,
      bbox: bbox as [number, number, number, number],
      class: item.class,
    };
  });
}

export async function estimateFacesWithEverypixel(
  clientId: string,
  clientSecret: string,
  image: EverypixelImageInput,
  fetchImpl: typeof fetch = fetch,
): Promise<EverypixelAgeResult> {
  if (!clientId.trim() || !clientSecret.trim()) {
    throw new Error('Everypixel requires both a Client ID and Client Secret.');
  }
  if (clientId.trim() === clientSecret.trim()) {
    throw new Error('Everypixel Client ID and Client Secret must be different values.');
  }

  const authorization = `Basic ${Buffer.from(`${clientId.trim()}:${clientSecret.trim()}`).toString('base64')}`;
  let url = EVERYPIXEL_FACES_URL;
  const headers: HeadersInit = { Authorization: authorization };
  let body: FormData | undefined;

  if ('url' in image) {
    let imageUrl: URL;
    try {
      imageUrl = new URL(image.url);
    } catch {
      throw new Error('Enter a valid HTTPS image URL for Everypixel.');
    }
    if (imageUrl.protocol !== 'https:') {
      throw new Error('Everypixel image URLs must use HTTPS.');
    }
    const everypixelUrl = new URL(EVERYPIXEL_FACES_URL);
    everypixelUrl.searchParams.set('url', imageUrl.toString());
    url = everypixelUrl.toString();
  } else {
    body = new FormData();
    const imageBlob = new Blob([new Uint8Array(image.buffer)], { type: image.contentType || 'application/octet-stream' });
    body.append('data', imageBlob, image.fileName || 'image.jpg');
  }

  const response = await fetchImpl(url, {
    method: body ? 'POST' : 'GET',
    headers,
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const responseText = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(responseText);
  } catch {
    const detail = responseText.trim().slice(0, 250);
    throw new Error(
      responseText.trim()
        ? `Everypixel returned a non-JSON response (HTTP ${response.status}): ${detail}`
        : `Everypixel returned an empty response (HTTP ${response.status}).`,
    );
  }

  const faces = parseEverypixelFaces(data);
  if (!response.ok) {
    throw new Error(`Everypixel request failed (HTTP ${response.status}).`);
  }

  return { status: 'ok', provider: 'everypixel', faces };
}
