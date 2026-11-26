import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateAgesInImage } from './ageEstimator';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local apparent-age estimation client', () => {
  it('returns a readable error for an empty response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));

    const result = await estimateAgesInImage(new Blob(['image'], { type: 'image/jpeg' }));

    expect(result.status).toBe('error');
    expect(result.message).toBe('Local age-estimation service returned an empty response (HTTP 503).');
  });

  it('reports the local model-unavailable error without trying another provider', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      status: 'error',
      message: 'OpenCV Caffe importer is unavailable.',
    }, { status: 503 })));

    const result = await estimateAgesInImage(new Blob(['image'], { type: 'image/jpeg' }));

    expect(result.status).toBe('error');
    expect(result.message).toBe('OpenCV Caffe importer is unavailable.');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns per-face age groups and sends no provider credentials', async () => {
    const face = {
      face_number: 1,
      bbox: [10, 20, 120, 130],
      detection_confidence: 0.91,
      quality: {
        state: 'good',
        metrics: {
          width_px: 120,
          height_px: 130,
          laplacian_variance: 85,
          mean_brightness: 120,
          contrast_std: 40,
          clipped_fraction: 0,
        },
        observations: [],
      },
      age_status: 'estimated',
      age_range: '25-32 years',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      status: 'ok',
      provider: 'local_opencv_dnn',
      model_name: 'Local age group model',
      face_detector_name: 'Local SSD model',
      model_version: 'local-caffe-sha256:test',
      processed_at: '2025-01-01T00:00:00+00:00',
      image_size: { width: 640, height: 480 },
      faces: [face],
      limitations: ['Output is not calibrated.'],
    })));

    const result = await estimateAgesInImage(new Blob(['image'], { type: 'image/jpeg' }));
    const request = vi.mocked(fetch).mock.calls[0][1] as RequestInit;

    expect(result.status).toBe('ok');
    expect(result.faces[0]).toMatchObject({
      face_number: 1,
      age_range: '25-32 years',
      quality: { state: 'good' },
    });
    expect(result.faces[0]).not.toHaveProperty('gender');
    expect(result.faces[0]).not.toHaveProperty('age');
    expect(request.headers).toEqual({
      'Content-Type': 'image/jpeg',
      'x-age-provider': 'local',
    });
  });
});
