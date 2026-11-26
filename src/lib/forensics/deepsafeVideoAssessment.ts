import type { FrameAnalysisResult } from '@/types/forensics';
import {
  formatDeepSafeScore,
  type DeepSafeImageAnalysis,
  type DeepSafeModelId,
} from './deepsafeImageDetector';

export type DeepSafeVideoFinalAssessment =
  | 'A. LIKELY AI-GENERATED / DEEPFAKE'
  | 'B. NO STRONG AI-GENERATION SIGNAL DETECTED'
  | 'C. INCONCLUSIVE — FURTHER INVESTIGATION REQUIRED';

export interface DeepSafeVideoFrameAssessmentInput {
  frame: Pick<FrameAnalysisResult, 'frameIndex' | 'timeSec' | 'formattedTime' | 'sha256'>;
  analysis?: DeepSafeImageAnalysis;
  error?: string;
}

export interface DeepSafeVideoAssessmentReport {
  assessment: DeepSafeVideoFinalAssessment;
  observation: string;
  modelAgreement: string;
  modelSummaries: Record<DeepSafeModelId, {
    label: string;
    scoreCount: number;
    consistency: 'consistent' | 'varied' | 'insufficient data';
    summary: string;
  }>;
  frameCount: number;
  analyzedFrameCount: number;
  analysisTimestamp: string;
  frameDetails: string[];
  reasoning: string[];
  limitations: string[];
}

const MODEL_LABELS: Record<DeepSafeModelId, string> = {
  npr_deepfakedetection: 'NPR',
  universalfakedetect: 'UniversalFakeDetect',
};

function getCompletedScore(
  analysis: DeepSafeImageAnalysis | undefined,
  modelId: DeepSafeModelId,
): number | null {
  const model = analysis?.models[modelId];
  return model?.status === 'completed' && model.score !== null ? model.score : null;
}

function summarizeModel(
  frames: readonly DeepSafeVideoFrameAssessmentInput[],
  modelId: DeepSafeModelId,
): DeepSafeVideoAssessmentReport['modelSummaries'][DeepSafeModelId] {
  const label = MODEL_LABELS[modelId];
  const scores = frames
    .map((frame) => getCompletedScore(frame.analysis, modelId))
    .filter((score): score is number => score !== null);

  if (scores.length === 0) {
    return {
      label,
      scoreCount: 0,
      consistency: 'insufficient data',
      summary: `${label} could not give a usable result for the selected frames.`,
    };
  }

  if (scores.length === 1) {
    return {
      label,
      scoreCount: 1,
      consistency: 'insufficient data',
      summary: `${label} gave a result for one frame, so its results cannot be compared across frames.`,
    };
  }

  const consistent = scores.every((score) => score === scores[0]);
  return {
    label,
    scoreCount: scores.length,
    consistency: consistent ? 'consistent' : 'varied',
    summary: consistent
      ? `${label} gave the same result for all ${scores.length} frames.`
      : `${label} gave different results across ${scores.length} frames.`,
  };
}

function formatFrameModelResult(
  analysis: DeepSafeImageAnalysis | undefined,
  modelId: DeepSafeModelId,
  frameError?: string,
): string {
  const model = analysis?.models[modelId];
  if (model?.status === 'completed' && model.score !== null) {
    return `${formatDeepSafeScore(model.score)} (uncalibrated raw score)`;
  }

  const status = model?.error || model?.status || frameError || 'not reported';
  return `unavailable (${status})`;
}

export function buildDeepSafeVideoAssessment(
  fileName: string,
  frames: readonly DeepSafeVideoFrameAssessmentInput[],
  analysisTimestamp: string,
): DeepSafeVideoAssessmentReport {
  const modelSummaries = {
    npr_deepfakedetection: summarizeModel(frames, 'npr_deepfakedetection'),
    universalfakedetect: summarizeModel(frames, 'universalfakedetect'),
  };
  const analyzedFrameCount = frames.filter((frame) => Boolean(frame.analysis)).length;
  const scoreCount = Object.values(modelSummaries).reduce((total, model) => total + model.scoreCount, 0);
  const assessment: DeepSafeVideoFinalAssessment =
    'C. INCONCLUSIVE — FURTHER INVESTIGATION REQUIRED';
  const modelAgreement =
    'Agreement cannot be determined: the available raw scores have no validated model-specific decision thresholds.';
  const frameDetails = frames.map((frame) => {
    const analysisTime = frame.analysis?.analyzed_at || 'not reported';
    return [
      `Frame #${frame.frame.frameIndex} at ${frame.frame.formattedTime} (${frame.frame.timeSec.toFixed(3)}s)`,
      `frame SHA-256 ${frame.frame.sha256}`,
      `NPR ${formatFrameModelResult(frame.analysis, 'npr_deepfakedetection', frame.error)}`,
      `UniversalFakeDetect ${formatFrameModelResult(frame.analysis, 'universalfakedetect', frame.error)}`,
      `backend analysis time ${analysisTime}`,
    ].join('; ');
  });
  const observation = [
    `DeepSafe returned results for ${analyzedFrameCount} of ${frames.length} selected frames from "${fileName}".`,
    modelSummaries.npr_deepfakedetection.summary,
    modelSummaries.universalfakedetect.summary,
    'These scores are not a percentage chance that the video is fake.',
    'The scores alone cannot show whether the models agree about the video.',
    'Overall result: inconclusive. These frames cannot prove that the video is real, AI-generated, or face-swapped. Check other evidence.',
  ].join(' ');
  const reasoning = [
    `${assessment} was selected because the returned values are uncalibrated frame-level scores and there is no validated threshold or video-level decision rule.`,
    modelAgreement,
    scoreCount === 0
      ? 'Neither model returned a usable score.'
      : `Usable raw scores were returned for ${scoreCount} model-frame result${scoreCount === 1 ? '' : 's'}; the individual frame outputs are listed below.`,
    'No frame is classified as suspicious based on an arbitrary cutoff, and one frame alone cannot establish that the video is AI-generated.',
  ];
  const limitations = [
    'NPR and UniversalFakeDetect return image-level model scores; those scores are not calibrated probabilities of video origin.',
    'No decision threshold has been validated for these models and this evidence domain.',
    'Only the selected frames were analyzed; sparse frame samples are not a validated video-level verdict.',
    'This screening does not confirm, localize, or distinguish a face swap from other forms of AI-generated media.',
  ];

  if (analyzedFrameCount < frames.length) {
    limitations.push(`Only ${analyzedFrameCount} of ${frames.length} selected frames returned an analysis response.`);
  }
  if (modelSummaries.npr_deepfakedetection.scoreCount < frames.length) {
    limitations.push('NPR did not return usable scores for every selected frame.');
  }
  if (modelSummaries.universalfakedetect.scoreCount < frames.length) {
    limitations.push('UniversalFakeDetect did not return usable scores for every selected frame.');
  }

  return {
    assessment,
    observation,
    modelAgreement,
    modelSummaries,
    frameCount: frames.length,
    analyzedFrameCount,
    analysisTimestamp,
    frameDetails,
    reasoning,
    limitations,
  };
}
