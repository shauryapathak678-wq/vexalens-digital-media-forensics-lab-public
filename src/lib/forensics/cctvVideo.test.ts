import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculateSHA256 } from './crypto';
import { analyzeCctvVideo } from './cctvVideo';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CCTV video client', () => {
  it('sends the source hash and accepts a matching custody result', async () => {
    const video = new File(['synthetic video bytes'], 'sample.mp4', { type: 'video/mp4' });
    const sha256 = await calculateSHA256(video);
    const result = {
      verdict: 'Needs review',
      risk_score: 20,
      reasons: ['A synthetic indicator was found.'],
      file: {
        sha256,
        frames_analyzed: 10,
        fps: 25,
        resolution: '640x360',
        duration_seconds: 0.4,
        timestamp_source: 'opencv',
        truncated: false,
      },
      timing_gaps: [],
      discontinuities: [],
      frozen_frames: [],
      replayed_segments: [],
      activity_events: [],
      series: { change: [0, 0.1], duration_seconds: 0.4, threshold: 0.5 },
      custody: {
        source_sha256: sha256,
        analysis_sha256: sha256,
        original_unchanged: true,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(analyzeCctvVideo(video)).resolves.toMatchObject({
      verdict: 'Needs review',
      custody: { source_sha256: sha256, analysis_sha256: sha256, original_unchanged: true },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/forensics/cctv/analyze',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Evidence-Sha256': sha256,
          'X-File-Extension': '.mp4',
        }),
      }),
    );
  });

  it('rejects a service result whose analysis-copy hash does not match the upload', async () => {
    const video = new File(['synthetic video bytes'], 'sample.mp4', { type: 'video/mp4' });
    const sha256 = await calculateSHA256(video);
    const result = {
      verdict: 'No tampering indicators found',
      risk_score: 0,
      reasons: [],
      file: {
        sha256,
        frames_analyzed: 10,
        fps: 25,
        resolution: '640x360',
        duration_seconds: 0.4,
        timestamp_source: 'opencv',
        truncated: false,
      },
      timing_gaps: [],
      discontinuities: [],
      frozen_frames: [],
      replayed_segments: [],
      activity_events: [],
      series: { change: [0, 0.1], duration_seconds: 0.4, threshold: 0.5 },
      custody: {
        source_sha256: sha256,
        analysis_sha256: '0'.repeat(64),
        original_unchanged: true,
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(result))));

    await expect(analyzeCctvVideo(video)).rejects.toThrow('did not match the analyzed copy');
  });

  it('rejects unsupported extensions before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(analyzeCctvVideo(new File(['bytes'], 'sample.txt')))
      .rejects.toThrow('Choose an AVI, M4V, MKV, MOV, MP4, or WebM video');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
