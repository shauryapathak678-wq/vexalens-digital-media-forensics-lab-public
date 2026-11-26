import { createClient, type Session } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { getSupabaseClient } from '@/lib/supabase';
import {
  analyzeDeepSafeVideoFrames,
  analyzeDeepSafeVideoFrame,
  createFailedDeepSafeAnalysis,
  findReusableDeepSafeAnalysis,
  parseDeepSafeAnalysis,
  selectDeepSafeVideoFrames,
  DEEPSAFE_VIDEO_FRAME_LIMIT,
  DEEPSAFE_MODEL_VERSION,
  DEEPSAFE_PROVIDER_REVISION,
  formatDeepSafeScore,
  getDeepSafeLogScale,
  mapDeepSafeScoreToLogY,
  type DeepSafeImageAnalysis,
  type DeepSafeModelResult,
} from './deepsafeImageDetector';

vi.mock('@/lib/supabase', () => ({
  getSupabaseClient: vi.fn(),
}));

const image = {
  mime_type: 'image/png',
  format: 'PNG',
  width: 640,
  height: 480,
  sha256: 'ab'.repeat(32),
};

const makeFrame = (frameIndex: number) => ({
  frameIndex,
  timeSec: frameIndex,
  formattedTime: `00:00:${String(frameIndex).padStart(2, '0')}`,
  dataUrl: `data:image/jpeg;base64,frame-${frameIndex}`,
  sha256: frameIndex.toString(16).padStart(64, '0'),
  status: 'analyzed' as const,
  faceDetected: false,
});

function modelResult(
  modelId: 'npr_deepfakedetection' | 'universalfakedetect',
  classification: 'fake' | 'real',
): DeepSafeModelResult {
  const score = classification === 'fake' ? 0.82 : 0.18;
  return {
    model_id: modelId,
    model_name: modelId,
    model_version: DEEPSAFE_MODEL_VERSION,
    status: 'completed',
    score,
    raw_logit: Math.log(score / (1 - score)),
    score_type: 'uncalibrated_sigmoid_fake_class_logit',
    score_meaning: 'Uncalibrated sigmoid-transformed fake-class logit.',
    threshold: null,
    classification: null,
    inference_time_seconds: 0.2,
    raw_output: { probability: score },
    error: null,
  };
}

function response(): DeepSafeImageAnalysis {
  return {
    provider: 'DeepSafe',
    provider_revision: DEEPSAFE_PROVIDER_REVISION,
    analysis_version: '1.1.0',
    investigation_id: 'investigation-1',
    evidence_id: 'evidence-1',
    file_name: 'evidence.png',
    mime_type: 'image/png',
    file_size: 1024,
    image: { ...image },
    models: {
      npr_deepfakedetection: modelResult('npr_deepfakedetection', 'fake'),
      universalfakedetect: modelResult('universalfakedetect', 'real'),
    },
    ensemble: {
      method: 'No aggregate verdict',
      assessment: 'inconclusive',
      fake_votes: null,
      total_votes: null,
      score: null,
      observations: ['The available detectors produced different classifications.'],
    },
    processing_status: 'completed',
    duration_ms: 400,
    analyzed_at: '2026-11-14T00:00:00Z',
    error_detail: null,
  };
}

describe('DeepSafe response parsing', () => {
  it('reuses only a completed current-version result with matching evidence hash', () => {
    const saved = response();
    expect(findReusableDeepSafeAnalysis(
      [saved],
      saved.investigation_id,
      saved.evidence_id,
      saved.image.sha256,
    )).toBe(saved);

    expect(findReusableDeepSafeAnalysis(
      [saved],
      saved.investigation_id,
      saved.evidence_id,
      'cd'.repeat(32),
    )).toBeNull();

    const oldVersion = response();
    oldVersion.models.npr_deepfakedetection.model_version = '1.0.0';
    expect(findReusableDeepSafeAnalysis(
      [oldVersion],
      oldVersion.investigation_id,
      oldVersion.evidence_id,
      oldVersion.image.sha256,
    )).toBeNull();
  });

  it('formats the original backend score without reconstructing it from logits', () => {
    expect(formatDeepSafeScore(7.25127e-34)).toBe('7.25127e-34');
    expect(formatDeepSafeScore(2.83946e-5)).toBe('2.83946e-5');
    expect(formatDeepSafeScore(0.82)).toBe('0.82');
    expect(formatDeepSafeScore(0)).toBe('0');
  });

  it('uses a logarithmic chart scale that separates tiny scores without changing them', () => {
    const nprScore = 7.25127e-34;
    const ufdScore = 2.83946e-5;
    const scale = getDeepSafeLogScale([nprScore, ufdScore]);
    const nprY = mapDeepSafeScoreToLogY(nprScore, scale.minExponent, 20, 180);
    const ufdY = mapDeepSafeScoreToLogY(ufdScore, scale.minExponent, 20, 180);

    expect(scale.tickValues[0]).toBe(1);
    expect(nprY).toBeGreaterThan(ufdY);
    expect(nprY - ufdY).toBeGreaterThan(80);
    expect(mapDeepSafeScoreToLogY(0, scale.minExponent, 20, 180)).toBe(180);
  });

  it('preserves separate uncalibrated scores and raw logits without classifications', () => {
    const parsed = parseDeepSafeAnalysis(response());

    expect(parsed.models.npr_deepfakedetection.classification).toBeNull();
    expect(parsed.models.npr_deepfakedetection.raw_logit).toBeCloseTo(Math.log(0.82 / 0.18));
    expect(parsed.models.universalfakedetect.classification).toBeNull();
    expect(parsed.ensemble.assessment).toBe('inconclusive');
    expect(parsed.ensemble.score).toBeNull();
  });

  it('preserves one model failure without inventing a negative result', () => {
    const value = response();
    value.models.universalfakedetect = {
      ...value.models.universalfakedetect,
      status: 'unavailable',
      score: null,
      classification: null,
      error: 'The model service timed out.',
    };
    value.ensemble.assessment = 'inconclusive';
    value.ensemble.total_votes = null;
    value.processing_status = 'partial';

    const parsed = parseDeepSafeAnalysis(value);

    expect(parsed.models.universalfakedetect.status).toBe('unavailable');
    expect(parsed.models.universalfakedetect.classification).toBeNull();
    expect(parsed.processing_status).toBe('partial');
  });

  it('rejects invalid hashes, dimensions, and completed model scores', () => {
    const invalidHash = response();
    invalidHash.image.sha256 = 'not-a-hash';
    expect(() => parseDeepSafeAnalysis(invalidHash)).toThrow('invalid image metadata');

    const invalidDimension = response();
    invalidDimension.image.width = 0;
    expect(() => parseDeepSafeAnalysis(invalidDimension)).toThrow('invalid image metadata');

    const invalidScore = response();
    invalidScore.models.npr_deepfakedetection.score = 1.2;
    expect(() => parseDeepSafeAnalysis(invalidScore)).toThrow('invalid fake-class score');
  });

  it('does not invent vote counts when inference fails before model results', () => {
    const failed = createFailedDeepSafeAnalysis({
      investigationId: 'investigation-1',
      id: 'evidence-1',
      fileName: 'evidence.png',
      mimeType: 'image/png',
      fileSize: 1024,
      sha256Hash: image.sha256,
      width: image.width,
      height: image.height,
    }, 'Inference service unavailable.');

    expect(failed.processing_status).toBe('failed');
    expect(failed.ensemble.fake_votes).toBeNull();
    expect(failed.ensemble.total_votes).toBeNull();
    expect(failed.models.npr_deepfakedetection.score).toBeNull();
  });
});

describe('DeepSafe video frame selection', () => {
  it('selects evenly spaced cached frames up to the configured cap', () => {
    const frames = Array.from({ length: 12 }, (_, index) => makeFrame(index + 1));

    expect(DEEPSAFE_VIDEO_FRAME_LIMIT).toBe(3);
    expect(selectDeepSafeVideoFrames(frames).map((frame) => frame.frameIndex)).toEqual([1, 7, 12]);
    expect(selectDeepSafeVideoFrames(frames, 1).map((frame) => frame.frameIndex)).toEqual([7]);
    expect(selectDeepSafeVideoFrames(frames, 2).map((frame) => frame.frameIndex)).toEqual([1, 12]);
  });

  it('omits unavailable and duplicate frames before selecting', () => {
    const frames = [
      makeFrame(1),
      { ...makeFrame(2), dataUrl: undefined },
      { ...makeFrame(3), status: 'skipped' as const },
      makeFrame(4),
      { ...makeFrame(5), sha256: makeFrame(1).sha256 },
    ];

    expect(selectDeepSafeVideoFrames(frames).map((frame) => frame.frameIndex)).toEqual([1, 4]);
  });
});

describe('DeepSafe video-frame batch', () => {
  it('sends selected in-memory frames in one authenticated request without Storage access', async () => {
    const client = createClient('https://example.supabase.co', 'publishable-key');
    const session: Session = {
      access_token: 'access-token',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: 'refresh-token',
      user: {
        id: 'user-id',
        app_metadata: {},
        user_metadata: {},
        aud: 'authenticated',
        created_at: new Date().toISOString(),
      },
    };
    vi.spyOn(client.auth, 'getSession').mockResolvedValue({
      data: { session },
      error: null,
    });
    vi.mocked(getSupabaseClient).mockReturnValue(client);

    const frames = [makeFrame(1), makeFrame(4)];
    const analyses = frames.map((frame) => {
      const analysis = response();
      analysis.image.sha256 = frame.sha256;
      return analysis;
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        frames: frames.map((frame, index) => ({
          frame_index: frame.frameIndex,
          time_sec: frame.timeSec,
          analysis: analyses[index],
        })),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    try {
      const results = await analyzeDeepSafeVideoFrames('investigation-id', 'evidence-id', frames);

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][0]).toBe('/api/forensics/deepsafe-video-frame/analyze');
      const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
      expect(body.frames).toHaveLength(2);
      expect(body.frames[0].frameDataUrl).toBe(frames[0].dataUrl);
      expect(JSON.stringify(fetch.mock.calls[0][1]?.body)).not.toContain('/storage/');
      expect(results.map((result) => result.analysis?.image.sha256)).toEqual(frames.map((frame) => frame.sha256));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('falls back to the legacy single-frame API when the server rejects batch fields', async () => {
    const client = createClient('https://example.supabase.co', 'publishable-key');
    const session: Session = {
      access_token: 'access-token',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: 'refresh-token',
      user: {
        id: 'user-id',
        app_metadata: {},
        user_metadata: {},
        aud: 'authenticated',
        created_at: new Date().toISOString(),
      },
    };
    vi.spyOn(client.auth, 'getSession').mockResolvedValue({
      data: { session },
      error: null,
    });
    vi.mocked(getSupabaseClient).mockReturnValue(client);

    const frames = [makeFrame(1), makeFrame(4)];
    const analyses = frames.map((frame) => {
      const analysis = response();
      analysis.image.sha256 = frame.sha256;
      return analysis;
    });
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'A valid video evidence ID and sampled JPEG frame are required.',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(analyses[0]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(analyses[1]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    try {
      const results = await analyzeDeepSafeVideoFrames('investigation-id', 'evidence-id', frames);

      expect(fetch).toHaveBeenCalledTimes(3);
      expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).frameDataUrl).toBe(frames[0].dataUrl);
      expect(results.map((result) => result.analysis?.image.sha256)).toEqual(frames.map((frame) => frame.sha256));
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('DeepSafe authentication timeout', () => {
  it('fails promptly when the Supabase session lookup never settles', async () => {
    const client = createClient('https://example.supabase.co', 'publishable-key');
    vi.spyOn(client.auth, 'getSession').mockImplementation(
      () => new Promise<Awaited<ReturnType<typeof client.auth.getSession>>>(() => {}),
    );
    vi.mocked(getSupabaseClient).mockReturnValue(client);
    vi.useFakeTimers();

    try {
      const request = analyzeDeepSafeVideoFrame('investigation-id', 'evidence-id', {
        frameIndex: 1,
        timeSec: 1,
        dataUrl: 'data:image/jpeg;base64,/9j/2Q==',
        sha256: 'ab'.repeat(32),
        status: 'analyzed',
      });
      const rejection = expect(request).rejects.toThrow('Checking Supabase sign-in timed out.');
      await vi.advanceTimersByTimeAsync(8_000);
      await rejection;
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('refreshes an expired Supabase token once and retries the frame request', async () => {
    const client = createClient('https://example.supabase.co', 'publishable-key');
    const makeSession = (accessToken: string): Session => ({
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: 'refresh-token',
      user: {
        id: 'user-id',
        app_metadata: {},
        user_metadata: {},
        aud: 'authenticated',
        created_at: new Date().toISOString(),
      },
    });
    const expiredSession = makeSession('expired-access-token');
    const refreshedSession = makeSession('refreshed-access-token');
    vi.spyOn(client.auth, 'getSession').mockResolvedValue({
      data: { session: expiredSession },
      error: null,
    });
    const refresh = vi.spyOn(client.auth, 'refreshSession').mockResolvedValue({
      data: { session: refreshedSession, user: refreshedSession.user },
      error: null,
    });
    vi.mocked(getSupabaseClient).mockReturnValue(client);
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Access token expired.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(response()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    try {
      await analyzeDeepSafeVideoFrame('investigation-id', 'evidence-id', {
        frameIndex: 1,
        timeSec: 1,
        dataUrl: 'data:image/jpeg;base64,/9j/2Q==',
        sha256: 'ab'.repeat(32),
        status: 'analyzed',
      });

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(new Headers(fetch.mock.calls[0][1]?.headers).get('Authorization'))
        .toBe('Bearer expired-access-token');
      expect(new Headers(fetch.mock.calls[1][1]?.headers).get('Authorization'))
        .toBe('Bearer refreshed-access-token');
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
