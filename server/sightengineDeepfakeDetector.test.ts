import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeSightengineDeepfake } from './sightengineDeepfakeDetector';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Sightengine deepfake detector', () => {
  it('submits image bytes with server credentials and returns the documented score', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        status: 'success',
        request: { id: 'req-image-1' },
        type: { deepfake: 0.23 },
      }),
      { status: 200 }
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(analyzeSightengineDeepfake(
      Buffer.from('image bytes'),
      'sample.jpg',
      'image/jpeg',
      'image',
      'test-user',
      'test-secret'
    )).resolves.toEqual({
      score: 0.23,
      scoreSource: 'provider',
      aiGeneratedScore: null,
      aiGeneratedScoreSource: null,
      frames: [],
      requestId: 'req-image-1',
    });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.sightengine.com/1.0/check.json');
    const form = options.body as FormData;
    expect(form.get('models')).toBe('deepfake');
    expect(form.get('api_user')).toBe('test-user');
    expect(form.get('api_secret')).toBe('test-secret');
    expect(form.get('media')).toBeInstanceOf(Blob);
    expect(form.get('interval')).toBeNull();
  });

  it('uses the synchronous video endpoint and a one-second sampling interval', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        status: 'success',
        request: { id: 'req-video-1' },
        data: {
          frames: [
            { info: { position: 0 }, type: { deepfake: 0.8, ai_generated: 0.3 } },
            { info: { position: 1 }, type: { deepfake: 0.6, ai_generated: 0.7 } },
          ],
        },
      }),
      { status: 200 }
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(analyzeSightengineDeepfake(
      Buffer.from('video bytes'),
      'sample.mp4',
      'video/mp4',
      'video',
      'test-user',
      'test-secret'
    )).resolves.toEqual({
      score: 0.7,
      scoreSource: 'mean_frames',
      aiGeneratedScore: 0.5,
      aiGeneratedScoreSource: 'mean_frames',
      frames: [
        { positionSec: 0, deepfakeScore: 0.8, aiGeneratedScore: 0.3 },
        { positionSec: 1, deepfakeScore: 0.6, aiGeneratedScore: 0.7 },
      ],
      requestId: 'req-video-1',
    });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.sightengine.com/1.0/video/check-sync.json');
    expect((options.body as FormData).get('models')).toBe('deepfake,genai');
    expect((options.body as FormData).get('interval')).toBe('1');
  });

  it('redacts credentials from provider errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ status: 'failure', error: { message: 'invalid test-secret' } }),
      { status: 200 }
    )));

    await expect(analyzeSightengineDeepfake(
      Buffer.from('image bytes'),
      'sample.jpg',
      'image/jpeg',
      'image',
      'test-user',
      'test-secret'
    )).rejects.toThrow('invalid [redacted]');
  });

  it('preserves Sightengine gateway error details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ status: 'failure', error: { message: 'Video is longer than the synchronous limit.' } }),
      { status: 502 }
    )));

    await expect(analyzeSightengineDeepfake(
      Buffer.from('video bytes'),
      'sample.mp4',
      'video/mp4',
      'video',
      'test-user',
      'test-secret'
    )).rejects.toThrow('Video is longer than the synchronous limit.');
  });

  it('rejects malformed score responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ status: 'success', type: { deepfake: 1.2 } }),
      { status: 200 }
    )));

    await expect(analyzeSightengineDeepfake(
      Buffer.from('image bytes'),
      'sample.jpg',
      'image/jpeg',
      'image',
      'test-user',
      'test-secret'
    )).rejects.toThrow('invalid deepfake confidence score');
  });
});
