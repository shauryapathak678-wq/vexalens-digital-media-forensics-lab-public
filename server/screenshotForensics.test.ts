import { describe, expect, it } from 'vitest';
import {
  completeScreenshotAnalysisJob,
  createScreenshotAnalysisJob,
  getActiveScreenshotAnalysisJobCount,
  getScreenshotAnalysis,
  getScreenshotAnalysisJob,
  getScreenshotAnalysisHistory,
  storeScreenshotAnalysis,
  type BackendScreenshotAnalysis,
} from './screenshotForensics';

describe('screenshot analysis result cache', () => {
  it('stores the actual backend result without creating detector findings', () => {
    const result: BackendScreenshotAnalysis = {
      id: 'scan-test-1',
      fileName: 'upi_screenshot.png',
      sha256: 'a'.repeat(64),
      analysisTimestamp: '2026-01-01T00:00:00Z',
      assessmentStatus: 'no_indicators',
      suspiciousRegions: [],
      moduleFindings: {},
    };

    storeScreenshotAnalysis(result);

    expect(getScreenshotAnalysis(result.id)).toEqual(result);
    expect(getScreenshotAnalysisHistory()).toContainEqual(result);
  });

  it('tracks async job states and scopes history to the job owner', () => {
    const result: BackendScreenshotAnalysis = {
      id: 'scan-owner-a',
      fileName: 'private.png',
      sha256: 'b'.repeat(64),
      analysisTimestamp: '2026-01-02T00:00:00Z',
      assessmentStatus: 'no_indicators',
      suspiciousRegions: [],
      moduleFindings: {},
    };

    createScreenshotAnalysisJob('job-owner-a', 'owner-a');
    expect(getActiveScreenshotAnalysisJobCount()).toBe(1);
    completeScreenshotAnalysisJob('job-owner-a', result);

    expect(getScreenshotAnalysisJob('job-owner-a')?.status).toBe('complete');
    expect(getScreenshotAnalysisHistory('owner-a')).toContainEqual(result);
    expect(getScreenshotAnalysisHistory('owner-b')).not.toContainEqual(result);
    expect(getActiveScreenshotAnalysisJobCount()).toBe(0);
  });
});
