import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeSyncNetOffset, fetchSyncNetVideoCopy, SYNCNET_MAX_VIDEO_BYTES } from './syncNetClient';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchSyncNetVideoCopy', () => {
  it('downloads the selected video preview', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('video bytes', {
        headers: { 'content-type': 'video/mp4' },
      }),
    ));

    const video = await fetchSyncNetVideoCopy('https://storage.example/video.mp4');

    expect(await video.text()).toBe('video bytes');
    expect(video.type).toBe('video/mp4');
  });

  it('rejects oversized previews before reading their body', async () => {
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(SYNCNET_MAX_VIDEO_BYTES + 1) }),
      body: null,
      blob: vi.fn(),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    await expect(fetchSyncNetVideoCopy('https://storage.example/video.mp4'))
      .rejects.toThrow('SyncNet accepts videos up to 128 MB.');
    expect(response.blob).not.toHaveBeenCalled();
  });
});

describe('analyzeSyncNetOffset', () => {
  it('returns the face-track settings used by the local pipeline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        status: 'completed',
        model: 'SyncNet',
        model_version: 'syncnet_v2',
        upstream_revision: 'revision',
        source_sha256: 'a'.repeat(64),
        video_duration_seconds: 20,
        analysis_segment_start_seconds: 7.5,
        analysis_segment_end_seconds: 12.5,
        analysis_segment_duration_seconds: 5,
        frame_rate: 25,
        face_detection_scale: 0.25,
        min_face_size_pixels: 60,
        tracks: [],
      })),
    ));

    const result = await analyzeSyncNetOffset(new Blob(['video']), '.mp4', 'a'.repeat(64));

    expect(result.face_detection_scale).toBe(0.25);
    expect(result.min_face_size_pixels).toBe(60);
  });
});
