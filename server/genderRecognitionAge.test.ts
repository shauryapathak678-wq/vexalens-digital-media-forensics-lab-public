import { describe, expect, it, vi } from 'vitest';
import { estimateAgeWithGenderRecognition } from './genderRecognitionAge';

describe('GenderRecognition Age API', () => {
  it('uploads a multipart file field and normalizes detections', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      success: true,
      detections: [{ age: 27.4, probability: 99 }, { age: 41.2, probability: 94 }],
      remainingRequests: 2999,
    }));

    const result = await estimateAgeWithGenderRecognition(
      'test-api-key',
      Buffer.from('image bytes'),
      'people.jpg',
      'image/jpeg',
      fetchMock as unknown as typeof fetch,
    );

    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.genderrecognition.com/v1/image-gender/api/age');
    expect(options.method).toBe('POST');
    expect(new Headers(options.headers).get('apikey')).toBe('test-api-key');
    expect((options.body as FormData).get('file')).toBeInstanceOf(Blob);
    expect(result.remainingCredits).toBe(2999);
    expect(result.faces).toHaveLength(2);
    expect(result.faces[0]).toMatchObject({ age: 27.4, score: 0.99, class: 'Age - Young Adult' });
  });

  it('supports successful responses with no detections', async () => {
    const result = await estimateAgeWithGenderRecognition(
      'test-api-key',
      Buffer.from('image bytes'),
      'portrait.png',
      'image/png',
      vi.fn(async () => Response.json({ success: true, detections: [], remainingRequests: 2998 })) as unknown as typeof fetch,
    );
    expect(result.faces).toEqual([]);
    expect(result.remainingCredits).toBe(2998);
  });

  it('returns quota errors without inventing detections', async () => {
    await expect(estimateAgeWithGenderRecognition(
      'test-api-key',
      Buffer.from('image bytes'),
      'portrait.jpg',
      'image/jpeg',
      vi.fn(async () => Response.json({ error: { code: 'RATE_LIMIT_EXCEEDED', message: 'You have exceeded your free tier limit of 50 requests.' } }, { status: 400 })) as unknown as typeof fetch,
    )).rejects.toThrow(/free tier limit/i);
  });
});
