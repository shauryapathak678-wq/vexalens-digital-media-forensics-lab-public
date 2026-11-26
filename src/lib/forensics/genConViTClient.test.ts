import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeGenConViTVideo,
  getGenConViTStatus,
  type GenConViTAnalysisMode,
  type GenConViTAnalysisResult,
  type GenConViTStatus,
} from './genConViTClient';

const readyStatus: GenConViTStatus = {
  configured: true,
  model: 'GenConViT',
  model_version: '32d6e9e3',
  device: 'CPU',
  num_sampled_frames: 15,
  rapid_face_search_frames: 5,
  max_video_duration_seconds: 60,
  max_video_bytes: 128 * 1024 * 1024,
  missing_dependencies: [],
  missing_files: [],
  category: 'video-level screening',
  fast_model_ready: true,
  fast_model_loading: false,
  fast_model_error: null,
};

const validResult: GenConViTAnalysisResult = {
  status: 'completed',
  analysis_mode: 'rapid',
  model: 'GenConViT',
  model_version: '32d6e9e3',
  predicted_class: 'REAL',
  fake_score: 0.2,
  real_score: 0.8,
  score_semantics: 'Uncalibrated model score.',
  sampled_frames: 1,
  faces_detected: 1,
  frames_with_faces: 1,
  face_search_frames: 2,
  video_fps: 25,
  video_duration_seconds: 4,
  inference_seconds: 2,
  analysis_timestamp: '2026-11-20T00:00:00Z',
  device: 'CPU',
  classification_scope: 'General video screening only.',
  source_sha256: 'a'.repeat(64),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GenConViT client', () => {
  it('parses local readiness and reports missing models without hiding the state', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...readyStatus,
      configured: false,
      missing_files: ['models/genconvit/genconvit_vae_inference.pth'],
    })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getGenConViTStatus()).resolves.toMatchObject({
      configured: false,
      missing_files: ['models/genconvit/genconvit_vae_inference.pth'],
    });
  });

  it('sends the selected analysis mode and accepts a valid local result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(validResult)));
    vi.stubGlobal('fetch', fetchMock);
    const sourceHash = 'b'.repeat(64);

    const mode: GenConViTAnalysisMode = 'rapid';
    await expect(analyzeGenConViTVideo(new Blob(['video']), '.mp4', sourceHash))
      .resolves.toMatchObject({ analysis_mode: mode, predicted_class: 'REAL', source_sha256: 'a'.repeat(64) });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/lipsync/genconvit/analyze',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Evidence-Sha256': sourceHash,
          'X-File-Extension': '.mp4',
          'X-Analysis-Mode': mode,
        }),
      }),
    );
  });

  it('rejects invalid scores instead of showing an unsupported classification', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...validResult,
      fake_score: 1.2,
    })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(analyzeGenConViTVideo(new Blob(['video']), '.mp4', 'b'.repeat(64)))
      .rejects.toThrow('invalid analysis response');
  });

  it('stops rapid requests at 50 seconds with a clear timeout message', async () => {
    const timeoutError = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError));

    await expect(analyzeGenConViTVideo(new Blob(['video']), '.mp4', 'b'.repeat(64)))
      .rejects.toThrow('50-second limit');
  });
});
