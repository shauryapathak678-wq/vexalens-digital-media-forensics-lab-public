export type ReverseProviderStatus =
  | 'not_requested'
  | 'not_configured'
  | 'completed'
  | 'partial'
  | 'no_match'
  | 'authentication_failed'
  | 'quota_exceeded'
  | 'network_error'
  | 'provider_error';

export interface ReverseFrameFingerprint {
  frame_index: number;
  timestamp_seconds: number | null;
  phash: string;
  crop_phashes: string[];
  [key: string]: unknown;
}

export interface ReverseFingerprintResult {
  status: 'completed';
  media_type: 'image' | 'video';
  source_sha256: string;
  analyzed_at: string;
  video_metadata: Record<string, number> | null;
  frames: ReverseFrameFingerprint[];
  limitations: string[];
  processing_seconds: number;
}

export interface ReverseWebMatch {
  category: 'page' | 'full_matching_image' | 'partial_matching_image' | 'similar_image' | 'web_entity';
  url?: string;
  title?: string;
  imageUrl?: string;
  description?: string;
  score?: number;
  frameIndex: number;
  timestampSeconds: number | null;
}

export interface ReverseLocalMatch {
  evidenceId: string;
  matchType: 'exact_file' | 'visually_similar_frame';
  frameIndex?: number;
  candidateFrameIndex?: number;
  timestampSeconds?: number | null;
  hammingDistance?: number;
  note: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function safeScore(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function isReverseSearchHistoryTableMissing(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.code === 'PGRST205' || error.code === '42P01') return true;
  return typeof error.message === 'string' &&
    /(?:reverse_media_searches.*schema cache|schema cache.*reverse_media_searches)/i.test(error.message);
}

function hammingDistance(first: string, second: string): number | null {
  if (!/^[a-f0-9]{16}$/i.test(first) || !/^[a-f0-9]{16}$/i.test(second)) return null;
  let value = BigInt(`0x${first}`) ^ BigInt(`0x${second}`);
  let distance = 0;
  while (value) {
    distance += Number(value & 1n);
    value >>= 1n;
  }
  return distance;
}

export function normalizeWebDetection(payload: unknown, frames: ReverseFrameFingerprint[]): {
  status: ReverseProviderStatus;
  matches: ReverseWebMatch[];
  message?: string;
} {
  if (!isRecord(payload) || !Array.isArray(payload.responses)) {
    return { status: 'provider_error', matches: [], message: 'Google Vision returned an invalid Web Detection response.' };
  }

  const matches: ReverseWebMatch[] = [];
  const providerErrors: string[] = [];
  for (const [framePosition, responseValue] of payload.responses.entries()) {
    if (!isRecord(responseValue)) continue;
    const frame = frames[framePosition];
    if (!frame) continue;
    const providerError = isRecord(responseValue.error) ? safeString(responseValue.error.message) : undefined;
    if (providerError) {
      providerErrors.push(providerError);
      continue;
    }
    const webDetection = isRecord(responseValue.webDetection) ? responseValue.webDetection : {};
    const frameInfo = {
      frameIndex: frame.frame_index,
      timestampSeconds: frame.timestamp_seconds,
    };
    const append = (
      category: ReverseWebMatch['category'],
      items: unknown,
      mapItem: (item: Record<string, unknown>) => Omit<ReverseWebMatch, 'category' | 'frameIndex' | 'timestampSeconds'>
    ) => {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        if (isRecord(item)) matches.push({ category, ...frameInfo, ...mapItem(item) });
      }
    };
    append('page', webDetection.pagesWithMatchingImages, (item) => ({
      url: safeString(item.url),
      title: safeString(item.pageTitle),
    }));
    append('full_matching_image', webDetection.fullMatchingImages, (item) => ({
      imageUrl: safeString(item.url),
    }));
    append('partial_matching_image', webDetection.partialMatchingImages, (item) => ({
      imageUrl: safeString(item.url),
    }));
    append('similar_image', webDetection.visuallySimilarImages, (item) => ({
      imageUrl: safeString(item.url),
    }));
    append('web_entity', webDetection.webEntities, (item) => ({
      description: safeString(item.description),
      score: safeScore(item.score),
    }));
  }

  const seen = new Set<string>();
  const uniqueMatches = matches.filter((match) => {
    const key = `${match.category}:${match.frameIndex}:${match.url || match.imageUrl || match.description || ''}`;
    if (key.endsWith(':') || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (uniqueMatches.length) {
    return {
      status: providerErrors.length ? 'partial' : 'completed',
      matches: uniqueMatches,
      ...(providerErrors.length ? { message: `Some sampled frames could not be searched: ${providerErrors.join('; ')}` } : {}),
    };
  }
  return providerErrors.length
    ? { status: 'provider_error', matches: [], message: providerErrors.join('; ') }
    : { status: 'no_match', matches: [], message: 'Google Web Detection returned no indexed matches for the sampled image derivatives.' };
}

export async function searchGoogleWebDetection(
  frames: ReverseFrameFingerprint[],
  apiKey: string
): Promise<{ status: ReverseProviderStatus; matches: ReverseWebMatch[]; message?: string }> {
  const frameImages = frames.filter((frame) => typeof frame.provider_image_base64 === 'string');
  if (!frameImages.length) {
    return { status: 'provider_error', matches: [], message: 'No consented provider derivatives were supplied.' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const frameResults: Array<{ response?: unknown; error?: string; httpStatus?: number }> =
      new Array(frameImages.length);
    let nextFrameIndex = 0;
    const searchNextFrame = async () => {
      while (nextFrameIndex < frameImages.length) {
        const framePosition = nextFrameIndex++;
        const frame = frameImages[framePosition];
        try {
          const response = await fetch('https://vision.googleapis.com/v1/images:annotate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            signal: controller.signal,
            body: JSON.stringify({
              requests: [{
                image: { content: frame.provider_image_base64 },
                features: [{ type: 'WEB_DETECTION', maxResults: 20 }],
              }],
            }),
          });
          if (!response.ok) {
            frameResults[framePosition] = {
              httpStatus: response.status,
              error: `Google Cloud Vision returned HTTP ${response.status}.`,
            };
            continue;
          }
          const payload = await response.json() as { responses?: unknown[] };
          const providerResponse = Array.isArray(payload.responses) ? payload.responses[0] : undefined;
          const validProviderResponse = isRecord(providerResponse);
          frameResults[framePosition] = {
            response: providerResponse,
            ...(!validProviderResponse
              ? { error: 'Google Vision returned an invalid response for a sampled frame.' }
              : {}),
          };
        } catch (error) {
          frameResults[framePosition] = {
            error: error instanceof Error ? error.message : 'Google Web Detection request failed.',
          };
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, frameImages.length) }, () => searchNextFrame())
    );
    const failures = frameResults.filter((item) => item.error);
    if (failures.length === frameResults.length && failures.every((item) => item.httpStatus === 401 || item.httpStatus === 403)) {
      return { status: 'authentication_failed', matches: [], message: 'Google Cloud Vision rejected the configured credentials or API permissions.' };
    }
    if (failures.length === frameResults.length && failures.every((item) => item.httpStatus === 429)) {
      return { status: 'quota_exceeded', matches: [], message: 'Google Cloud Vision quota or rate limit was reached.' };
    }
    if (failures.length === frameResults.length) {
      const timedOut = failures.some((item) => /aborted|timeout/i.test(item.error || ''));
      return {
        status: timedOut ? 'network_error' : 'provider_error',
        matches: [],
        message: failures.map((item) => item.error).filter(Boolean).join('; '),
      };
    }
    const normalized = normalizeWebDetection({
      responses: frameResults.map((item) => item.error
        ? { error: { message: item.error } }
        : item.response),
    }, frameImages);
    return failures.length
      ? {
        ...normalized,
        ...(normalized.status === 'completed' || normalized.status === 'no_match'
          ? { status: 'partial' as const }
          : {}),
        message: [normalized.message, ...failures.map((item) => item.error).filter(Boolean)].filter(Boolean).join('; '),
      }
      : normalized;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { status: 'network_error', matches: [], message: 'Google Web Detection timed out after 20 seconds.' };
    }
    return {
      status: 'network_error',
      matches: [],
      message: error instanceof Error ? `Google Web Detection request failed: ${error.message}` : 'Google Web Detection request failed.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function compareLocalFingerprints(
  source: ReverseFingerprintResult,
  candidates: Array<{ evidenceId: string; fingerprint: unknown }>
): ReverseLocalMatch[] {
  const matches: ReverseLocalMatch[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate.fingerprint)) continue;
    if (
      candidate.fingerprint.source_sha256 === source.source_sha256
    ) {
      matches.push({
        evidenceId: candidate.evidenceId,
        matchType: 'exact_file',
        note: 'The SHA-256 values are identical; this indicates byte-for-byte identical files.',
      });
      continue;
    }
    if (!Array.isArray(candidate.fingerprint.frames)) continue;
    let best: ReverseLocalMatch | null = null;
    for (const sourceFrame of source.frames) {
      for (const candidateValue of candidate.fingerprint.frames) {
        if (!isRecord(candidateValue)) continue;
        const candidateHashes = [
          safeString(candidateValue.phash),
          ...(Array.isArray(candidateValue.crop_phashes)
            ? candidateValue.crop_phashes.map(safeString)
            : []),
        ].filter((hash): hash is string => Boolean(hash));
        const sourceHashes = [sourceFrame.phash, ...sourceFrame.crop_phashes];
        for (const sourceHash of sourceHashes) {
          for (const candidateHash of candidateHashes) {
            const distance = hammingDistance(sourceHash, candidateHash);
            if (distance !== null && distance <= 6 && (!best || distance < (best.hammingDistance ?? 65))) {
              best = {
                evidenceId: candidate.evidenceId,
                matchType: 'visually_similar_frame',
                frameIndex: sourceFrame.frame_index,
                candidateFrameIndex: typeof candidateValue.frame_index === 'number' ? candidateValue.frame_index : undefined,
                timestampSeconds: sourceFrame.timestamp_seconds,
                hammingDistance: distance,
                note: 'A sampled frame or quadrant crop has a low perceptual-hash distance. This is a visual lead, not proof of common origin.',
              };
            }
          }
        }
      }
    }
    if (best) matches.push(best);
  }
  return matches;
}
