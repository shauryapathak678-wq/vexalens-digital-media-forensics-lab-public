import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeOriginMedia,
  detectLandmarks,
  normalizeExifReaderMetadata,
  validateOriginMedia,
} from './originAnalysis';

const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('origin analysis input validation', () => {
  it('checks image and video signatures against the recorded MIME type', () => {
    expect(validateOriginMedia(pngBytes, 'image', 'image/png', 'sample.png')).toBe('image');
    expect(validateOriginMedia(pngBytes, 'image', 'image/jpeg', 'sample.jpg')).toBeNull();
    expect(validateOriginMedia(Buffer.from(`BM${'\0'.repeat(12)}`), 'image', 'image/bmp', 'sample.bmp')).toBe('image');
    expect(validateOriginMedia(Buffer.from('....ftypisom'), 'video', 'video/mp4', 'sample.mp4')).toBe('video');
    expect(validateOriginMedia(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), 'video', 'video/webm', 'sample.webm')).toBe('video');
  });

  describe('ExifReader metadata fallback', () => {
    it('normalizes supported tags and GPS while excluding serial-number tags', () => {
      const metadata = normalizeExifReaderMetadata({
        exif: {
          Make: { description: 'Canon', value: ['Canon'] },
          BodySerialNumber: { description: 'private', value: ['private'] },
        },
        gps: { Latitude: -33.86, Longitude: 151.2, Altitude: 5 },
      });

      expect(metadata).toMatchObject({
        '[ExifReader][EXIF]Make': 'Canon',
        '[GPS]GPSLatitude': -33.86,
        '[GPS]GPSLongitude': 151.2,
        '[GPS]GPSAltitude': 5,
      });
      expect(metadata).not.toHaveProperty('[ExifReader][EXIF]BodySerialNumber');
    });

    it('returns no metadata when ExifReader finds no supported tags', () => {
      expect(normalizeExifReaderMetadata({})).toBeNull();
    });
  });

  it('rejects missing, unsupported, or incorrectly classified media', () => {
    expect(validateOriginMedia(Buffer.alloc(0), 'image', 'image/png', 'empty.png')).toBeNull();
    expect(validateOriginMedia(Buffer.from('not media'), 'video', 'video/mp4', 'fake.mp4')).toBeNull();
    expect(validateOriginMedia(pngBytes, 'audio', 'audio/mpeg', 'fake.mp3')).toBeNull();
    expect(validateOriginMedia(pngBytes, 'image', 'image/png', 'fake.jpg')).toBeNull();
  });

  it('stops analysis when submitted bytes differ from the evidence digest', async () => {
    await expect(
      analyzeOriginMedia(pngBytes, 'image', '0'.repeat(64), 4, undefined, 'image/png')
    ).rejects.toThrow('do not match the SHA-256 recorded for this evidence');
  });

  it('rejects unsupported metadata-extraction MIME types before invoking local tools', async () => {
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(pngBytes).digest('hex');
    await expect(
      analyzeOriginMedia(pngBytes, 'image', digest, 4, undefined, 'image/gif')
    ).rejects.toThrow('MIME type is not supported');
  });

  it('returns honest local-only status when Vision is not configured', async () => {
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(pngBytes).digest('hex');
    const result = await analyzeOriginMedia(pngBytes, 'image', digest, 4, undefined, 'image/png');

    expect(result.sha256).toBe(digest);
    expect(result.mediaType).toBe('image');
    expect(result.visionStatus).toBe('not_configured');
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0].status).toBe('not_configured');
    expect(result.frames[0].landmarks).toEqual([]);
  });

  it('returns actual landmark descriptions, provider scores, and returned place coordinates', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      responses: [{
        landmarkAnnotations: [{
          description: 'Example landmark',
          score: 0.84,
          locations: [{ latLng: { latitude: 12.5, longitude: -34.25 } }],
        }],
      }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await detectLandmarks(pngBytes, 'server-only-key');

    expect(result.status).toBe('completed');
    expect(result.landmarks).toEqual([{
      description: 'Example landmark',
      score: 0.84,
      locations: [{ latitude: 12.5, longitude: -34.25 }],
    }]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://vision.googleapis.com/v1/images:annotate');
    expect(fetchMock.mock.calls[0][1].headers['x-goog-api-key']).toBe('server-only-key');
  });

  it('classifies Vision authentication, quota, and no-match responses', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 403 }))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ responses: [{}] }), { status: 200 })));

    expect((await detectLandmarks(pngBytes, 'test-key')).status).toBe('authentication_failed');
    expect((await detectLandmarks(pngBytes, 'test-key')).status).toBe('quota_exceeded');
    expect((await detectLandmarks(pngBytes, 'test-key')).status).toBe('no_match');
  });

  it('reports upstream Vision gateway failures without returning fabricated landmark results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('upstream unavailable', { status: 502 })));
    const result = await detectLandmarks(pngBytes, 'test-key');
    expect(result.status).toBe('provider_error');
    expect(result.landmarks).toEqual([]);
    expect(result.message).toContain('HTTP 502');
  });

  it('reports network failures and oversized inputs without claiming a result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    expect((await detectLandmarks(pngBytes, 'test-key')).status).toBe('network_error');
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
    expect((await detectLandmarks(oversized, 'test-key')).status).toBe('provider_error');
  });
});
