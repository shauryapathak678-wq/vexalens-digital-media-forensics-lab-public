import { describe, expect, it } from 'vitest';
import {
  DEEPSAFE_MODEL_VERSION,
  DEEPSAFE_PROVIDER_REVISION,
  type DeepSafeImageAnalysis,
  type DeepSafeModelId,
  type DeepSafeModelResult,
} from './deepsafeImageDetector';
import { buildDeepSafeVideoAssessment } from './deepsafeVideoAssessment';

function makeModel(
  modelId: DeepSafeModelId,
  score: number,
): DeepSafeModelResult {
  return {
    model_id: modelId,
    model_name: modelId,
    model_version: DEEPSAFE_MODEL_VERSION,
    status: 'completed',
    score,
    raw_logit: null,
    score_type: 'uncalibrated_sigmoid_fake_class_logit',
    score_meaning: 'Uncalibrated sigmoid fake-class score.',
    threshold: null,
    classification: null,
    inference_time_seconds: 0.2,
    raw_output: { probability: score },
    error: null,
  };
}

function makeFrameAnalysis(frameIndex: number, nprScore: number, ufdScore: number): DeepSafeImageAnalysis {
  return {
    provider: 'DeepSafe',
    provider_revision: DEEPSAFE_PROVIDER_REVISION,
    analysis_version: '1.1.0',
    investigation_id: 'investigation-1',
    evidence_id: 'evidence-1',
    file_name: 'sample-video.mp4',
    mime_type: 'image/jpeg',
    file_size: 100,
    image: {
      mime_type: 'image/jpeg',
      format: 'JPEG',
      width: 640,
      height: 360,
      sha256: frameIndex.toString(16).padStart(64, '0'),
    },
    models: {
      npr_deepfakedetection: makeModel('npr_deepfakedetection', nprScore),
      universalfakedetect: makeModel('universalfakedetect', ufdScore),
    },
    ensemble: {
      method: 'No aggregate verdict',
      assessment: 'inconclusive',
      fake_votes: null,
      total_votes: null,
      score: null,
      observations: ['No validated verdict criteria.'],
    },
    processing_status: 'completed',
    duration_ms: 100,
    analyzed_at: '2026-11-17T00:00:00.000Z',
    error_detail: null,
  };
}

const timestamp = '2026-11-17T00:01:00.000Z';

describe('DeepSafe video assessment report', () => {
  it('records actual per-frame scores and remains inconclusive without validated criteria', () => {
    const report = buildDeepSafeVideoAssessment('sample-video.mp4', [
      {
        frame: {
          frameIndex: 1,
          timeSec: 1,
          formattedTime: '00:00:01',
          sha256: '01'.repeat(32),
        },
        analysis: makeFrameAnalysis(1, 0.0020838, 0.4553549),
      },
      {
        frame: {
          frameIndex: 7,
          timeSec: 7,
          formattedTime: '00:00:07',
          sha256: '07'.repeat(32),
        },
        analysis: makeFrameAnalysis(7, 1.05e-33, 1.11e-6),
      },
    ], timestamp);

    expect(report.assessment).toBe('C. INCONCLUSIVE — FURTHER INVESTIGATION REQUIRED');
    expect(report.modelSummaries.npr_deepfakedetection.consistency).toBe('varied');
    expect(report.modelSummaries.universalfakedetect.consistency).toBe('varied');
    expect(report.frameDetails[0]).toContain('NPR 0.0020838 (uncalibrated raw score)');
    expect(report.frameDetails[0]).toContain('UniversalFakeDetect 0.4553549 (uncalibrated raw score)');
    expect(report.frameDetails[1]).toContain('NPR 1.05e-33 (uncalibrated raw score)');
    expect(report.observation).toContain('not a percentage chance');
    expect(report.observation).toContain('gave different results across 2 frames');
    expect(report.observation).toContain('Overall result: inconclusive.');
    expect(report.modelAgreement).toContain('cannot be determined');
    expect(report.analysisTimestamp).toBe(timestamp);
  });

  it('does not upgrade high scores to a likely-deepfake verdict without a validated rule', () => {
    const report = buildDeepSafeVideoAssessment('sample-video.mp4', [
      {
        frame: {
          frameIndex: 1,
          timeSec: 1,
          formattedTime: '00:00:01',
          sha256: '01'.repeat(32),
        },
        analysis: makeFrameAnalysis(1, 0.99, 0.98),
      },
    ], timestamp);

    expect(report.assessment).toBe('C. INCONCLUSIVE — FURTHER INVESTIGATION REQUIRED');
    expect(report.reasoning.join(' ')).toContain('no validated threshold');
  });

  it('records unavailable outputs without creating a clean or fake classification', () => {
    const report = buildDeepSafeVideoAssessment('sample-video.mp4', [{
      frame: {
        frameIndex: 1,
        timeSec: 1,
        formattedTime: '00:00:01',
        sha256: '01'.repeat(32),
      },
      error: 'Model service unavailable.',
    }], timestamp);

    expect(report.assessment).toBe('C. INCONCLUSIVE — FURTHER INVESTIGATION REQUIRED');
    expect(report.analyzedFrameCount).toBe(0);
    expect(report.frameDetails[0]).toContain('unavailable');
    expect(report.limitations[0]).toContain('not calibrated probabilities of video origin');
  });
});
