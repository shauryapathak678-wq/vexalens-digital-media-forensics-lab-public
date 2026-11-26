import type { EvidenceMetadata } from '@/types/forensics';

export type EvidenceAssessmentCategory =
  | 'no_strong_indicator_detected'
  | 'possible_manipulation'
  | 'possible_ai_generated'
  | 'conflicting_evidence'
  | 'inconclusive'
  | 'analysis_incomplete'
  | 'detection_unavailable';

export interface EvidenceAssessment {
  category: EvidenceAssessmentCategory;
  summary: string;
  explanation: string;
  evidence: string[];
  counterEvidence: string[];
  limitations: string[];
  nextSteps: string[];
  checksCompleted: string[];
  checksUnavailable: string[];
}

export function classifyEvidenceStatus(
  elaVariance: number,
  _metadataIssueCount = 0,
  _aiModelAvailable = false
): EvidenceAssessmentCategory {
  if (!Number.isFinite(elaVariance)) {
    return 'analysis_incomplete';
  }

  // ELA and metadata are contextual diagnostics, not validated classifiers.
  return 'inconclusive';
}

export function buildImageAssessment({
  fileName,
  metadata,
  elaVariance,
  aiModelAvailable = false,
}: {
  fileName: string;
  metadata?: Partial<EvidenceMetadata>;
  elaVariance?: number;
  aiModelAvailable?: boolean;
}): EvidenceAssessment {
  const metadataIssues = metadata?.inconsistenciesDetected ?? [];
  const metadataIssueCount = metadataIssues.length;
  const hasElaMeasurement = Number.isFinite(elaVariance ?? NaN);
  const safeVariance = hasElaMeasurement ? elaVariance! : 0;
  const category = hasElaMeasurement
    ? classifyEvidenceStatus(safeVariance, metadataIssueCount, aiModelAvailable)
    : 'analysis_incomplete';

  const checksCompleted = [
    ...(metadata ? ['Available metadata fields inspected'] : []),
    ...(hasElaMeasurement ? ['ELA recompression diagnostic computed'] : []),
  ];

  const checksUnavailable = aiModelAvailable
    ? []
    : ['AI-generated image detector not available or not configured on this server'];

  const evidence: string[] = [];
  if (metadataIssueCount > 0) {
    evidence.push(`Metadata parser reported ${metadataIssueCount} observation${metadataIssueCount > 1 ? 's' : ''}; metadata alone does not establish manipulation.`);
  }
  if (hasElaMeasurement) {
    evidence.push(`ELA diagnostic variance measured ${safeVariance.toFixed(1)}; this recompression measurement is not an AI-origin or manipulation classifier.`);
  }

  const counterEvidence: string[] = [];

  const limitations = [
    'Compression, social-media re-encoding, lighting, and camera post-processing can produce weak anomalies without indicating the image is fake.',
    'Metadata tags can be stripped, edited, or missing altogether, so they support but do not prove a conclusion.',
    'A missing AI detector is not evidence of authenticity; it simply limits the available analytical options.',
  ];

  const nextSteps = [
    'Compare against an original capture or trusted source file if available.',
    'Review the original camera or source environment for consistent lighting, shadows, and metadata.',
    'If a detector is available, validate the result with a second independent method before making a conclusion.',
  ];

  let summary = 'Inconclusive';
  let explanation = `Available metadata and ELA observations for ${fileName} are diagnostic only and do not establish whether the image is authentic, manipulated, or AI-generated.`;

  if (category === 'possible_manipulation') {
    summary = 'Possible manipulation detected';
    explanation = `The completed checks for ${fileName} show one or more compression or editing-related anomalies. These observations are relevant, but they still require corroboration because similar patterns can arise from legitimate re-encoding, local retouching, or document reconstruction.`;
  } else if (category === 'possible_ai_generated') {
    summary = 'Possible AI-generated content';
    explanation = `A suitable detector or external model returned relevant evidence for ${fileName}, and the result is treated as a preliminary indication only. AI-model signals are not proof of synthetic origin on their own, especially when the model is not validated for the exact image type.`;
  } else if (category === 'conflicting_evidence') {
    summary = 'Conflicting evidence';
    explanation = `The available methods for ${fileName} point in different directions, so no single conclusion is defensible without additional evidence.`;
  } else if (category === 'inconclusive') {
    summary = 'Inconclusive';
    explanation = `The current evidence for ${fileName} is insufficient to support a reliable conclusion. Metadata and image-level checks are informative, but they do not rise to a confident determination.`;
  } else if (category === 'analysis_incomplete') {
    summary = 'Analysis incomplete';
    explanation = `The necessary checks could not be completed for ${fileName}. The result is therefore incomplete and should not be interpreted as a positive or negative authenticity verdict.`;
  } else if (category === 'detection_unavailable') {
    summary = 'Detection unavailable';
    explanation = `A required detector for ${fileName} was not installed, configured, or accessible. The system therefore limited the conclusion to the available non-AI checks.`;
  }

  return {
    category,
    summary,
    explanation,
    evidence,
    counterEvidence,
    limitations,
    nextSteps,
    checksCompleted,
    checksUnavailable,
  };
}

export function buildVideoAssessment({
  durationSec,
  duplicateFrames = 0,
  averageFrameDifference = 0,
  aiModelAvailable = false,
}: {
  durationSec?: number;
  duplicateFrames?: number;
  averageFrameDifference?: number;
  aiModelAvailable?: boolean;
}): EvidenceAssessment {
  const hasDuration = Number.isFinite(durationSec) && (durationSec ?? 0) > 0;
  const category = hasDuration ? 'inconclusive' : 'analysis_incomplete';

  return {
    category,
    summary:
      category === 'analysis_incomplete' ? 'Analysis incomplete' : 'Inconclusive',
    explanation:
      'Frame differences and repeated-frame counts are descriptive temporal measurements; they do not independently establish manipulation or synthetic origin.',
    evidence: [
      `Average frame-to-frame difference measured ${averageFrameDifference.toFixed(1)} across the sampled sequence.`,
      duplicateFrames > 0 ? `Repeated or near-duplicate frames were detected: ${duplicateFrames}.` : 'No duplicate or repeated keyframes were detected in the sampled sequence.',
    ],
    counterEvidence: durationSec && durationSec > 0 ? ['The video length and frame sampling were sufficient for a basic temporal review.'] : ['The duration could not be confirmed during extraction.'],
    limitations: [
      'Motion, compression, and re-encoding can create temporal inconsistencies without indicating malicious intent.',
      'A genuine AI detector was not invoked in this configuration, so synthetic-content evidence remains unavailable.',
    ],
    nextSteps: [
      'Review the suspect timestamps and frame sequence against the original source or master copy.',
      'Check for abrupt scene cuts, duplicate frames, or mismatched motion continuity if the clip is edited.',
    ],
    checksCompleted: [
      'Video metadata and duration validated',
      'Keyframes extracted at multiple timestamps',
      'Temporal differences computed across the sampled sequence',
    ],
    checksUnavailable: ['Validated AI-generated video detector not configured'],
  };
}
