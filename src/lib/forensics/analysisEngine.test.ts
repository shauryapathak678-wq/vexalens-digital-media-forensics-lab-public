import { describe, expect, it } from 'vitest';
import { buildImageAssessment, buildVideoAssessment, classifyEvidenceStatus } from './analysisEngine';

describe('truthful forensic assessment', () => {
  it('classifies metadata-only signs as inconclusive rather than synthetic by default', () => {
    const result = buildImageAssessment({
      fileName: 'portrait.jpg',
      metadata: {
        software: 'Adobe Photoshop 25.1',
        inconsistenciesDetected: ['Post-processing software detected in EXIF CreatorTool: "Adobe Photoshop 25.1"'],
      },
      elaVariance: 18,
      aiModelAvailable: false,
    });

    expect(result.category).toBe('inconclusive');
    expect(result.summary.toLowerCase()).toContain('inconclusive');
    expect(result.explanation.toLowerCase()).toContain('metadata');
  });

  it('does not classify high ELA variance or metadata as manipulation', () => {
    const result = buildImageAssessment({
      fileName: 'stamp_scan.jpg',
      metadata: { software: 'Canon EOS', inconsistenciesDetected: [] },
      elaVariance: 62,
      aiModelAvailable: false,
    });

    expect(classifyEvidenceStatus(62, 0, false)).toBe('inconclusive');
    expect(result.category).toBe('inconclusive');
  });

  it('does not infer AI origin from ELA and metadata even when a generic model is available', () => {
    expect(classifyEvidenceStatus(90, 2, true)).toBe('inconclusive');
  });

  it('does not treat missing ELA output as a zero-variance assessment', () => {
    const result = buildImageAssessment({ fileName: 'not-yet-processed.jpg' });

    expect(result.category).toBe('analysis_incomplete');
    expect(result.evidence).toEqual([]);
  });

  it('does not classify video from repeated frames or frame-difference magnitude', () => {
    const result = buildVideoAssessment({
      durationSec: 12,
      duplicateFrames: 8,
      averageFrameDifference: 99,
      aiModelAvailable: true,
    });

    expect(result.category).toBe('inconclusive');
    expect(result.checksUnavailable).toContain('Validated AI-generated video detector not configured');
  });
});
