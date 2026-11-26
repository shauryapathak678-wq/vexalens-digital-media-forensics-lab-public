import { describe, expect, it } from 'vitest';
import {
  calculateMouthApertureRatio,
  compareActivitySignals,
  extractSpeechSegments,
  summarizeMouthMotion,
} from './lipSync';

describe('compareActivitySignals', () => {
  it('reports a positive lag when the visual activity follows the audio activity', () => {
    const audio = [0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
    const visual = [0, ...audio.slice(0, -1)];

    const result = compareActivitySignals(audio, visual, 0.5, 2);

    expect(result.visualLagSec).toBe(0.5);
    expect(result.correlation).toBe(1);
    expect(result.sampleCount).toBeGreaterThanOrEqual(8);
  });

  it('does not produce a timing estimate when either signal has no variation', () => {
    const result = compareActivitySignals(Array(20).fill(0), Array(20).fill(0.4), 0.5);

    expect(result).toEqual({ correlation: null, visualLagSec: null, sampleCount: 0 });
  });

  it('does not estimate correlation from too few paired samples', () => {
    const result = compareActivitySignals([0, 1, 0, 1], [0, 1, 0, 1], 0.5);

    expect(result.correlation).toBeNull();
    expect(result.visualLagSec).toBeNull();
  });
});

describe('calculateMouthApertureRatio', () => {
  it('normalizes lip opening by mouth width', () => {
    const landmarks = Array.from({ length: 292 }, () => ({ x: 0, y: 0 }));
    landmarks[13] = { x: 0.4, y: 0.5 };
    landmarks[14] = { x: 0.4, y: 0.55 };
    landmarks[61] = { x: 0.3, y: 0.5 };
    landmarks[291] = { x: 0.5, y: 0.5 };

    expect(calculateMouthApertureRatio(landmarks)).toBeCloseTo(0.25);
  });

  it('returns no measurement for missing or zero-width mouth landmarks', () => {
    const landmarks = Array.from({ length: 292 }, () => ({ x: 0.5, y: 0.5 }));

    expect(calculateMouthApertureRatio([])).toBeNull();
    expect(calculateMouthApertureRatio(landmarks)).toBeNull();
  });
});

describe('summarizeMouthMotion', () => {
  it('reports measured aperture range and mouth-tracking coverage without inferring the motion source', () => {
    const summary = summarizeMouthMotion([
      { timeSec: 0, audioRms: 0, speechScore: 0, mouthApertureRatio: 0.1, faceTracked: true },
      { timeSec: 0.1, audioRms: 0, speechScore: 0, mouthApertureRatio: 0.3, faceTracked: true },
      { timeSec: 0.2, audioRms: 0, speechScore: 0, mouthApertureRatio: null, faceTracked: false },
      { timeSec: 0.3, audioRms: 0, speechScore: 0, mouthApertureRatio: 0.2, faceTracked: true },
    ]);

    expect(summary).toMatchObject({
      trackedSamples: 3,
      totalSamples: 4,
      trackingPercent: 75,
    });
    expect(summary.apertureRange).toBeCloseTo(0.2);
  });

  it('reports no aperture range when the mouth was not tracked', () => {
    expect(summarizeMouthMotion([
      { timeSec: 0, audioRms: 0, speechScore: 0, mouthApertureRatio: null, faceTracked: false },
    ])).toEqual({
      trackedSamples: 0,
      totalSamples: 1,
      trackingPercent: 0,
      apertureRange: null,
    });
  });
});

describe('extractSpeechSegments', () => {
  it('groups nearby speech frames and separates sustained silence', () => {
    const samples = [
      { timeSec: 0, score: 0.7 },
      { timeSec: 0.032, score: 0.6 },
      { timeSec: 0.064, score: 0.7 },
      { timeSec: 0.096, score: 0.6 },
      { timeSec: 0.3, score: 0.1 },
      { timeSec: 0.4, score: 0.1 },
      { timeSec: 0.5, score: 0.7 },
      { timeSec: 0.532, score: 0.6 },
      { timeSec: 0.564, score: 0.7 },
      { timeSec: 0.596, score: 0.6 },
    ];

    const segments = extractSpeechSegments(samples);

    expect(segments).toHaveLength(2);
    expect(segments[0].startSeconds).toBe(0);
    expect(segments[0].endSeconds).toBeCloseTo(0.128);
    expect(segments[1].startSeconds).toBe(0.5);
  });

  it('does not report brief detections as speech segments', () => {
    expect(extractSpeechSegments([
      { timeSec: 0, score: 0.8 },
      { timeSec: 0.032, score: 0.1 },
    ])).toEqual([]);
  });
});
