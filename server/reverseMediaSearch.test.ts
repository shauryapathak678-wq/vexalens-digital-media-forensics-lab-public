import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compareLocalFingerprints,
  isReverseSearchHistoryTableMissing,
  normalizeWebDetection,
  searchGoogleWebDetection,
  type ReverseFingerprintResult,
} from './reverseMediaSearch';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reverse-search history schema detection', () => {
  it('recognizes PostgREST missing-table cache errors without masking other failures', () => {
    expect(isReverseSearchHistoryTableMissing({
      code: 'PGRST205',
      message: "Could not find the table 'public.reverse_media_searches' in the schema cache",
    })).toBe(true);
    expect(isReverseSearchHistoryTableMissing({
      code: '42501',
      message: 'permission denied for table reverse_media_searches',
    })).toBe(false);
    expect(isReverseSearchHistoryTableMissing(new Error('Network request failed'))).toBe(false);
  });
});

function fingerprint(
  sha256: string,
  frames: Array<{ frame_index: number; timestamp_seconds: number | null; phash: string; crop_phashes: string[] }>
): ReverseFingerprintResult {
  return {
    status: 'completed',
    media_type: 'video',
    source_sha256: sha256,
    analyzed_at: '2026-10-01T00:00:00Z',
    video_metadata: null,
    frames,
    limitations: [],
    processing_seconds: 0.1,
  };
}

describe('reverse media search normalization', () => {
  it('deduplicates duplicate provider links per sampled frame and keeps frame attribution', () => {
    const result = normalizeWebDetection({
      responses: [
        {
          webDetection: {
            pagesWithMatchingImages: [
              { url: 'https://example.test/page', pageTitle: 'Example' },
              { url: 'https://example.test/page', pageTitle: 'Duplicate result' },
            ],
          },
        },
        {
          webDetection: {
            pagesWithMatchingImages: [{ url: 'https://example.test/page', pageTitle: 'Example' }],
          },
        },
      ],
    }, [
      { frame_index: 12, timestamp_seconds: 1.5, phash: '0'.repeat(16), crop_phashes: [] },
      { frame_index: 24, timestamp_seconds: 3, phash: '1'.repeat(16), crop_phashes: [] },
    ]);

    expect(result.status).toBe('completed');
    expect(result.matches).toHaveLength(2);
    expect(result.matches.map((match) => match.frameIndex)).toEqual([12, 24]);
  });

  it('keeps successful frame matches when another sampled frame has a provider error', () => {
    const result = normalizeWebDetection({
      responses: [
        { webDetection: { fullMatchingImages: [{ url: 'https://images.example.test/photo.jpg' }] } },
        { error: { message: 'One frame was rejected.' } },
      ],
    }, [
      { frame_index: 0, timestamp_seconds: 0, phash: '0'.repeat(16), crop_phashes: [] },
      { frame_index: 10, timestamp_seconds: 1, phash: '1'.repeat(16), crop_phashes: [] },
    ]);

    expect(result.status).toBe('partial');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].frameIndex).toBe(0);
    expect(result.message).toContain('One frame was rejected.');
  });

  it('sends one bounded derivative per provider request and keeps frame attribution', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { requests: unknown[] };
      expect(body.requests).toHaveLength(1);
      return new Response(JSON.stringify({
        responses: [{ webDetection: { fullMatchingImages: [{ url: 'https://image.test/original.jpg' }] } }],
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await searchGoogleWebDetection([
      {
        frame_index: 0,
        timestamp_seconds: 0,
        phash: '0'.repeat(16),
        crop_phashes: [],
        provider_image_base64: 'aW1hZ2U=',
      },
      {
        frame_index: 10,
        timestamp_seconds: 1,
        phash: '1'.repeat(16),
        crop_phashes: [],
        provider_image_base64: 'aW1hZ2U=',
      },
    ], 'server-key');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('completed');
    expect(result.matches.map((match) => match.frameIndex)).toEqual([0, 10]);
  });
});

describe('local fingerprint comparisons', () => {
  it('distinguishes exact-file matches from low-distance sampled-frame leads', () => {
    const source = fingerprint('a'.repeat(64), [
      { frame_index: 4, timestamp_seconds: 2, phash: '0000000000000000', crop_phashes: ['ffffffffffffffff'] },
    ]);
    const matches = compareLocalFingerprints(source, [
      { evidenceId: 'exact-evidence', fingerprint: fingerprint('a'.repeat(64), []) },
      {
        evidenceId: 'visual-evidence',
        fingerprint: fingerprint('b'.repeat(64), [
          { frame_index: 9, timestamp_seconds: 4.5, phash: '0000000000000001', crop_phashes: [] },
        ]),
      },
    ]);

    expect(matches.map((match) => match.matchType)).toEqual(['exact_file', 'visually_similar_frame']);
    expect(matches[1]).toMatchObject({
      evidenceId: 'visual-evidence',
      frameIndex: 4,
      candidateFrameIndex: 9,
      hammingDistance: 1,
    });
  });

  it('does not call a full-video match from a different frame hash', () => {
    const source = fingerprint('a'.repeat(64), [
      { frame_index: 0, timestamp_seconds: 0, phash: '0000000000000000', crop_phashes: [] },
    ]);
    const matches = compareLocalFingerprints(source, [
      {
        evidenceId: 'different',
        fingerprint: fingerprint('b'.repeat(64), [
          { frame_index: 0, timestamp_seconds: 0, phash: 'ffffffffffffffff', crop_phashes: [] },
        ]),
      },
    ]);

    expect(matches).toEqual([]);
  });
});
