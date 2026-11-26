import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getTruthScanVideoPresentation,
  getTruthScanVideoCredits,
  queryTruthScanVideo,
  submitTruthScanVideo,
} from './truthScanVideoDetector';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TruthScan video API client', () => {
  it('shows the current provider verdict and does not treat its raw score as an AI probability', () => {
    expect(getTruthScanVideoPresentation({
      id: 'job-real',
      status: 'done',
      result: 33.254012,
      result_details: {
        detection_step: 3,
        ocr: ['Watermark skipped', 0],
        ml_model: ['Real', 33.254012, 'latency: 10.212523'],
        confidence: 33.254012,
        final_result: 'Real',
      },
    })).toEqual({
      verdict: 'Real',
      aiLikelihoodPercent: null,
      providerScore: 33.254012,
      finalStage: 'Step 3',
      watermark: 'Watermark skipped',
      framesAnalyzed: null,
    });
  });

  it('converts the documented normalized prob_fake value to a percentage', () => {
    expect(getTruthScanVideoPresentation({
      id: 'job-probability',
      status: 'done',
      result: 0.1019,
      result_details: {
        final_stage: 'ml',
        ml: { aggregate: { prob_fake: 0.1019, label: 'no_detection', n_frames: 256 } },
      },
    })).toEqual({
      verdict: 'no_detection',
      aiLikelihoodPercent: 10.2,
      providerScore: 0.1019,
      finalStage: 'ml',
      watermark: 'Not reported',
      framesAnalyzed: 256,
    });
  });

  it('uploads the whole video with the selected model and filename', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: 'job-1', status: 'pending' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));
    vi.stubGlobal('fetch', fetchMock);
    const video = new Blob(['video bytes'], { type: 'video/mp4' });

    await expect(submitTruthScanVideo(video, 'sample clip.mp4', 'faceswap'))
      .resolves.toEqual({ id: 'job-1', status: 'pending' });

    expect(fetchMock).toHaveBeenCalledWith('/api/forensics/ai-video-detect?model=faceswap', expect.objectContaining({
      method: 'POST',
      body: video,
      headers: expect.objectContaining({
        'Content-Type': 'application/octet-stream',
        'X-File-Name': 'sample%20clip.mp4',
        'X-Video-Mime-Type': 'video/mp4',
      }),
    }));
  });

  it('queries an existing job and rejects provider errors clearly', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ id: 'job-2', status: 'done', result: 0.8 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'Detection key is invalid.' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(queryTruthScanVideo('job-2'))
      .resolves.toEqual({ id: 'job-2', status: 'done', result: 0.8 });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/forensics/ai-video-query', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ id: 'job-2' }),
    }));
    await expect(queryTruthScanVideo('job-3')).rejects.toThrow('Detection key is invalid.');
  });

  it('rejects malformed successful responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ status: 'pending' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )));

    await expect(queryTruthScanVideo('job-4'))
      .rejects.toThrow('invalid video detection response');
  });

  it('reads the balance for the server-configured video API key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ credits: 7486, baseCredits: 7000, boostCredits: 486 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getTruthScanVideoCredits()).resolves.toEqual({
      credits: 7486,
      baseCredits: 7000,
      boostCredits: 486,
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/forensics/ai-video-credits');
  });

  it('preserves plain-text provider errors instead of replacing them with an HTTP code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      'Not enough credits for this video.',
      { status: 502 }
    )));

    await expect(submitTruthScanVideo(new Blob(['video']), 'clip.mp4', 'generic'))
      .rejects.toThrow('Not enough credits for this video.');
  });
});
