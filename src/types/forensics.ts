export type MediaType = 'image' | 'video' | 'audio' | 'document' | 'other';
export type CaseStatus = 'open' | 'in_progress' | 'review' | 'closed';
export type CasePriority = 'low' | 'medium' | 'high' | 'critical';

export type FindingSeverity =
  | 'informational'
  | 'low'
  | 'medium'
  | 'high'
  | 'critical'
  | 'nominal'
  | 'warning'
  | 'inconclusive';

export type FindingCategory =
  | 'metadata'
  | 'compression'
  | 'synthetic_deepfake'
  | 'audio_signal'
  | 'visual_anomaly'
  | 'provenance';

export type DetectorVerdict =
  | 'indicators_observed'
  | 'no_indicator_detected'
  | 'inconclusive'
  | 'conflicting_results'
  | 'detection_unavailable'
  | 'analysis_incomplete';

export interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  badgeNumber: string;
  agency: string;
  role: 'investigator' | 'lead_analyst' | 'administrator';
  organization?: string;
  tier?: 'community' | 'pro' | 'enterprise';
  createdAt: string;
}

export interface Investigation {
  id: string;
  caseNumber: string;
  title: string;
  description: string;
  userId: string;
  status: CaseStatus;
  priority: CasePriority;
  leadInvestigator: string;
  createdAt: string;
  updatedAt: string;
  evidenceCount?: number;
  tags?: string[];
}

export interface EvidenceMetadata {
  fileFormat?: string;
  fileSizeBytes?: number;
  dimensions?: { width: number; height: number };
  aspectRatio?: string;
  colorSpace?: string;
  colorProfile?: string;
  cameraMake?: string;
  cameraModel?: string;
  lensModel?: string;
  software?: string;
  iso?: string | number;
  focalLength?: string;
  aperture?: string;
  exposureTime?: string;
  dateTimeOriginal?: string;
  dateTimeDigitized?: string;
  hasEmbeddedThumbnail?: boolean;
  gps?: {
    latitude?: number;
    longitude?: number;
    altitude?: number;
    timestamp?: string;
    speed?: number;
    speedUnit?: string;
    track?: number;
    direction?: number;
    directionReference?: string;
    source?: string;
    locationName?: string;
  };
  audioSpecs?: {
    durationSec?: number;
    sampleRateHz?: number;
    channels?: number;
    codec?: string;
    bitrateKbps?: number;
    bitDepth?: number;
  };
  videoSpecs?: {
    durationSec?: number;
    frameRateFps?: number;
    isVariableFrameRate?: boolean;
    resolution?: string;
    videoCodec?: string;
    audioCodec?: string;
    totalFramesEstimated?: number;
    audioStreamPresent?: boolean;
  };
  inconsistenciesDetected?: string[];
  missingMetadataNotices?: string[];
  verifiedEditingArtifacts?: string[];
  unverifiableFields?: string[];
  rawExif?: Record<string, any>;
}

export interface EvidenceLocationRegion {
  x?: number; // Normalized 0-100% or pixel coordinate
  y?: number;
  width?: number;
  height?: number;
  label?: string;
  timestampStart?: string; // e.g. "00:12.400"
  timestampEnd?: string;   // e.g. "00:13.200"
  frameNumber?: number;
  cropPreviewUrl?: string;
}

export interface EvidenceItem {
  id: string;
  investigationId: string;
  userId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  mediaType: MediaType;
  sha256Hash: string;
  storageUrl: string;
  previewUrl: string;
  /** Durable base64 thumbnail so visual records survive a page reload. */
  thumbnailUrl?: string;
  isOriginal: boolean;
  verified: boolean; // True only after comparison with a trusted reference digest.
  metadata: EvidenceMetadata;
  createdAt: string;
}

/**
 * Advanced Explainable Finding schema answering all 8 core questions:
 * 1. What did the analysis find?
 * 2. What specific evidence supports the finding?
 * 3. Where exactly was the indicator detected?
 * 4. Why might this indicate AI generation or editing?
 * 5. How reliable is this method?
 * 6. What could cause a false positive/negative?
 * 7. What remains uncertain?
 * 8. What should the investigator do next?
 */
export interface AnalysisFinding {
  id: string;
  investigationId: string;
  evidenceId: string;
  title: string;
  severity: FindingSeverity;
  category: FindingCategory;
  // Core Dual-Level Explanations
  simpleExplanation?: string; // Plain English for ordinary people, jurors, and journalists
  hindiExplanation?: string; // Hindi plain-language explanation for non-technical users
  technicalExplanation?: string; // Detailed measurements, signal specs, and equations
  observedEvidence: string; // Specific pixel/timestamp measurements
  evidenceLocation?: EvidenceLocationRegion; // Coordinates or timecode
  whyIndicatesAI?: string; // Architectural root cause
  methodReliability?: string; // Known error bounds and calibration
  potentialFalsePositives?: string; // Alternative explanations (compression, noise, lighting)
  unresolvedQuestions?: string; // What remains scientifically uncertain
  recommendedNextSteps?: string; // Concrete next investigative actions
  detectionMethod: string;
  detectorVersion: string;
  rawDetectorScore?: number; // Direct model score if applicable
  scoreInterpretation?: string; // Documented model score meaning
  createdAt: string;
  confidenceScore?: number; // Use only when a calibrated model score is available.
  // Truth Reconstruction & Evidence Labels (Module 3)
  evidenceLabel?: 'observed_fact' | 'model_prediction' | 'investigator_conclusion';
  derivedArtifactIds?: string[];
  alternativeHypotheses?: string[];
  sourceSha256?: string;
  frameIndex?: number;
  timestampSec?: number;
  // Backward compatibility alias:
  plainEnglishSummary?: string;
  limitations?: string;
}

export interface ForensicReportEvidenceItem {
  id: string;
  fileName: string;
  mediaType: string;
  sha256: string;
  fileSizeBytes: number;
  mimeType: string;
  hashStatus: 'calculated' | 'not_available';
  previewUrl?: string;
  thumbnailUrl?: string;
  metadata: EvidenceMetadata;
  isOriginal: boolean;
  verified?: boolean;
  createdAt?: string;
  findingsCount?: number;
}

export interface ForensicReport {
  id?: string;
  investigationId?: string;
  caseNumber: string;
  reportNumber: string;
  title: string;
  summary: string;
  leadInvestigator: string;
  badgeNumber: string;
  agency: string;
  createdAt: string;
  caseRegisteredAt?: string;
  evidenceList: ForensicReportEvidenceItem[];
  findings: AnalysisFinding[];
  certificates?: EvidenceCertificate[];
  provenance?: ProvenanceEvent[];
  methodologiesUsed?: string[];
  disclaimers?: string[];
}

export interface DetectorRun {
  id: string;
  evidenceId: string;
  detectorName: string;
  verdict: DetectorVerdict;
  rawScore?: number;
  scoreInterpretation?: string;
  confidence: 'Low' | 'Medium' | 'High';
  findingsCount: number;
  summary: string;
  simpleExplanation: string;
  technicalAnalysis: string;
  rawDetails: Record<string, any>;
  timestamp: string;
}

export interface ProvenanceEvent {
  id: string;
  evidenceId: string;
  investigationId: string;
  actionType:
    | 'intake'
    | 'hashing'
    | 'metadata_check'
    | 'ela_scan'
    | 'ai_deepfake_audit'
    | 'custody_transfer'
    | 'report_generated'
    | 'certificate_issued';
  actor: string;
  recordedSha256: string;
  verifiedMatch: boolean;
  sourceUrl?: string;
  sourceStatus?: 'unverified' | 'verified' | 'not_applicable';
  notes: string;
  timestamp: string;
}

export interface InvestigationNote {
  id: string;
  investigationId: string;
  authorName: string;
  authorBadge: string;
  content: string;
  createdAt: string;
}

export interface ActivityLog {
  id: string;
  userId: string;
  investigationId?: string;
  caseNumber?: string;
  eventType: string;
  description: string;
  timestamp: string;
}

export interface ELAParams {
  quality: number; // 0.90 to 0.95, default 0.95
  diffGain: number; // 0.5 to 5.0, default 1.0 (auto-normalized)
  colorChannel: 'rgb' | 'r' | 'g' | 'b';
  invert: boolean;
  luminanceOnly: boolean;
  blockSize?: number;
  zThreshold?: number;
}

/**
 * VexaLens Evidence Integrity Certificate
 * Cryptographically verifies and certifies facts recorded by the platform
 */
export interface EvidenceCertificate {
  certificateId: string; // e.g. "VLC-2026-94812"
  evidenceId: string;
  investigationId: string;
  caseNumber: string;
  fileName: string;
  fileSizeBytes: number;
  sha256Hash: string;
  uploadTimestamp: string;
  analysisTimestamp: string;
  softwareVersion: string;
  algorithmsApplied: string[];
  manifestHash: string;
  signature: string; // Server-side HMAC-SHA256 authentication code.
  verificationPublicKeyId: string;
  status: 'valid' | 'revoked' | 'unverifiable';
  revocationReason?: string;
  examinerName: string;
  examinerBadge: string;
  agency: string;
  qrVerificationUrl?: string;
}

/**
 * 6-Image Batch Item for Multi-Image batch investigation
 */
export interface BatchImageItem {
  id: string;
  file: File | Blob;
  fileName: string;
  fileSize: number;
  previewUrl: string;
  sha256: string;
  duplicateOf?: string;
  /** 8x8 average-hash (64-bit hex) used only for near-duplicate triage. */
  perceptualHash?: string;
  /** id of another batch item with a perceptually similar image, if any. */
  nearDuplicateOf?: string;
  resultState: DetectorVerdict;
  mainEvidence: string;
  findingsCount: number;
  cameraInfo: string;
  softwareInfo: string;
  analysisCompleted: boolean;
  error?: string;
  findingDetails?: AnalysisFinding[];
}

/**
 * Report Customization Configuration for Report Builder
 */
export interface ReportCustomization {
  reportTitle: string;
  caseNumber: string;
  leadInvestigator: string;
  badgeNumber: string;
  agency: string;
  organizationLogoUrl?: string;
  language: 'en' | 'hi';
  explanationLevel: 'both' | 'simple' | 'technical';
  includedSections: {
    coverPage: boolean;
    executiveSummary: boolean;
    evidenceInventory: boolean;
    metadataAudit: boolean;
    elaAnalysis: boolean;
    deepfakeDetection: boolean;
    audioAcoustics: boolean;
    videoKeyframes: boolean;
    comparisonMatrix: boolean;
    provenanceTimeline: boolean;
    disclaimers: boolean;
    certificateSeal: boolean;
  };
  includeEvidenceCrops: boolean;
  severityFilter: 'all' | 'high_critical' | 'critical_only';
  customExecutiveSummary?: string;
  recommendedNextSteps?: string;
  reportDate: string;
}

export interface CommercialQuota {
  tier: 'community' | 'pro' | 'enterprise';
  monthlyScansUsed: number;
  monthlyScansLimit: number;
  storageMbUsed: number;
  storageMbLimit: number;
  apiTokensUsed: number;
  apiTokensLimit: number;
  concurrentJobsMax: number;
}

// ==========================================
// Processing Jobs & Asynchronous Workflows
// ==========================================
export type JobLifecycleStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ProcessingJob {
  id: string;
  evidenceId?: string;
  caseNumber?: string;
  type:
    | 'image_forensics'
    | 'ai_origin_detection'
    | 'video_deepfake_analysis'
    | 'photo_to_video_match'
    | 'signature_comparison'
    | 'audio_spectrogram'
    | 'batch_triage'
    | 'pdf_report_export';
  status: JobLifecycleStatus;
  progressPercent: number;
  stage: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  retryCount: number;
  error?: string;
  resultSummary?: string;
}

// ==========================================
// Signature Comparison Lab Types
// ==========================================
export type SignatureConclusion =
  | 'visually_similar'
  | 'notable_differences'
  | 'insufficient_quality'
  | 'inconclusive';

export interface SignatureMetrics {
  contourSimilarity: number; // 0-100%
  strokeCurvature: number; // 0-100%
  aspectRatioRatio: number; // reference / questioned
  slantAngleDiffDeg: number; // absolute degree difference
  strokeDensityDiff: number; // difference in stroke-to-whitespace ratio
  endpointMismatchCount: number; // local structural discrepancies
  structuralDiscrepancyScore: number; // combined 0-100 score
}

export interface SignatureComparisonResult {
  referenceName: string;
  questionedName: string;
  metrics: SignatureMetrics;
  conclusion: SignatureConclusion;
  explanation: string;
  hindiExplanation: string;
  limitations: string[];
  differenceMapDataUrl?: string;
  timestamp: string;
}

// ==========================================
// Photo-to-Video Match Types
// ==========================================
export type FaceMatchConclusion =
  | 'potential_visual_match'
  | 'no_match_above_threshold'
  | 'inconclusive'
  | 'service_unavailable'
  | 'cartoon_or_non_human';

export interface CandidateFaceMatch {
  timestamp: string;
  frameNumber: number;
  similarityScore: number; // 0-1.0
  candidateCropUrl: string;
  eyeSpacingSimilarity: number;
  facialGeometryScore: number;
}

export interface PhotoToVideoMatchResult {
  referenceFaceCropUrl: string;
  videoFileName: string;
  framesSampled: number;
  candidateMatches: CandidateFaceMatch[];
  bestSimilarityScore: number;
  thresholdApplied: number;
  conclusion: FaceMatchConclusion;
  explanation: string;
  hindiExplanation: string;
  consentNoticeAcknowledged: boolean;
  biometricRetentionDisclaimer: string;
}

// ==========================================
// AI-Origin Assessment Types
// ==========================================
export type AIOriginOutcome =
  | 'consistent_unmanipulated'
  | 'possible_manipulation'
  | 'ai_generated_supported'
  | 'mixed_content'
  | 'inconclusive'
  | 'unavailable';

export interface AIOriginAssessmentResult {
  outcome: AIOriginOutcome;
  summary: string;
  modelName: string;
  modelVersion: string;
  inferenceStatus: 'operational' | 'fallback' | 'unavailable';
  spectralEnergyRatio: number;
  azimuthalSymmetryIndex: number;
  prnuNoiseVariance: number;
  highFreqCheckerboardScore: number;
  colorCovarianceAnomaly: number;
  technicalExplanation: string;
  simpleExplanation: string;
  hindiExplanation: string;
  evidenceObservations: string[];
  limitations: string[];
  recommendedNextSteps: string[];
  timestamp: string;
}

// ==========================================
// AI Model Status Registry Types
// ==========================================
export type AIModelStatusState =
  | 'not_installed'
  | 'not_configured'
  | 'loading'
  | 'ready'
  | 'inference_failed'
  | 'not_validated';

export interface AIModelHealthInfo {
  modelId: string;
  name: string;
  task: string;
  version: string;
  status: AIModelStatusState;
  device: string; // e.g. "CPU (AMD64 / AVX2)"
  lastInferenceAt?: string;
  lastInferenceStatus?: 'success' | 'failed';
  latencyMs?: number;
  accuracyConfidence: string;
  description: string;
  citationOrLicense: string;
  dependencies: string[];
}

// ==========================================
// Privacy, Consent & Report Sharing Types
// ==========================================
export type ShareScope = 'report_summary' | 'full_report';

export interface ShareLink {
  id: string;
  /** Random opaque token. Not a public URL on its own. */
  token: string;
  reportId: string;
  caseId?: string;
  scope: ShareScope;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
  revokedReason?: string;
  createdBy: string;
  /** Timestamp the operator explicitly consented to creating a shareable report. */
  consentAcknowledgedAt: string;
  accessCount: number;
}

export interface ExternalProcessingConsent {
  acknowledged: boolean;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
}

// ==========================================
// Module 1E: C2PA & Content Credentials Types
// ==========================================
export type C2PAValidationStatus =
  | 'manifest_detected_unverified'
  | 'valid_signed_manifest'
  | 'untrusted_root_signature'
  | 'corrupted_manifest'
  | 'no_manifest_found'
  | 'unsupported_format';

export interface C2PAAssertion {
  label: string;
  data: Record<string, any>;
}

export interface C2PAManifestResult {
  hasManifest: boolean;
  validationStatus: C2PAValidationStatus;
  claimGenerator?: string;
  title?: string;
  format?: string;
  instanceId?: string;
  issuer?: string;
  signedAt?: string;
  signatureAlgorithm?: string;
  actions: string[];
  assertions: C2PAAssertion[];
  digitalSourceType?: string;
  provenanceSummary: string;
  disclaimer: string;
  rawBoxesFound: string[];
}

// ==========================================
// Module 4: Multi-Model Consensus & Adapter Types
// ==========================================
export type AdapterInferenceStatus =
  | 'completed'
  | 'not_configured'
  | 'unavailable'
  | 'failed'
  | 'inconclusive'
  | 'timeout';

export interface DetectorSpatialRegion {
  id: string;
  xPct: number;
  yPct: number;
  widthPct: number;
  heightPct: number;
  label: string;
  areaPct: number;
  meanZ: number;
  peakZ: number;
  description: string;
}

export interface DetectorSpatialAnalysis {
  method: 'ela';
  reliability: 'high' | 'medium' | 'low';
  verdict: 'no_local_edits_detected' | 'possible_local_edit' | 'global_recompression' | 'not_reliable';
  reliabilityReasons: string[];
  regions: DetectorSpatialRegion[];
}

export interface NormalizedDetectorOutput {
  adapterId: string;
  adapterName: string;
  version: string;
  status: AdapterInferenceStatus;
  verdict: 'ai_generated' | 'authentic' | 'manipulated' | 'inconclusive' | 'unavailable';
  rawScore?: number;
  calibratedLikelihood?: number; // 0-1 probability only when scientifically calibrated
  scoreSemantics: string;
  observations: string[];
  alternativeExplanations: string[];
  limitations: string[];
  latencyMs: number;
  errorMessage?: string;
  spatialAnalysis?: DetectorSpatialAnalysis;
}

export interface MultiModelComparisonSummary {
  mediaId: string;
  analyzedAt: string;
  adaptersRun: NormalizedDetectorOutput[];
  consensusState: 'agreement' | 'divergence' | 'inconclusive' | 'insufficient_detectors';
  consensusExplanation: string;
  recommendedFurtherWork: string[];
}

// ==========================================
// Module 2: Video Deepfake & Forensic Timeline Types
// ==========================================
export interface FrameAnalysisResult {
  frameIndex: number;
  timeSec: number;
  formattedTime: string;
  dataUrl?: string;
  sha256: string;
  status: 'analyzed' | 'skipped' | 'failed';
  faceDetected: boolean;
  faceBoundingBox?: { x: number; y: number; width: number; height: number };
  faceCropUrl?: string;
  faceSeamAnomalyScore?: number; // 0-100% boundary gradient disparity
  facialDeepfakeProbability?: number; // 0-1.0
  interFrameCoherenceDiff?: number; // 0-100 difference against previous frame
  isSceneCut?: boolean;
  notes?: string;
}

export interface VideoTimelineEvent {
  id: string;
  timeSec: number;
  formattedTime: string;
  type: 'suspicious_interval' | 'scene_cut' | 'temporal_jitter' | 'audio_video_desync' | 'skipped_frame';
  severity: FindingSeverity;
  label: string;
  description: string;
  frameIndex?: number;
  isApproximateInterval?: boolean;
  intervalEndSec?: number;
}

export interface AudioVideoSyncMetrics {
  analyzedDurationSec: number;
  audioTrackFound: boolean;
  audioSampleRateHz?: number;
  estimatedLagMs: number; // Positive = audio leads, negative = audio lags
  correlationCoefficient: number; // 0 to 1.0
  droppedFrameCount: number;
  syncVerdict: 'nominal_sync' | 'possible_desync' | 'dubbed_or_replaced_audio' | 'inconclusive' | 'no_audio';
  explanation: string;
  hindiExplanation: string;
  limitations: string[];
}

export interface VideoDeepfakeScanResult {
  videoId: string;
  videoDurationSec: number;
  framesSampled: number;
  framesAnalyzed: number;
  framesSkipped: number;
  samplingIntervalSec: number;
  facialDeepfakeVerdict: 'manipulation_indicated' | 'no_manipulation_detected' | 'inconclusive' | 'unavailable';
  generalAiVideoVerdict: 'synthetic_video_supported' | 'natural_video_consistent' | 'inconclusive' | 'unavailable';
  perFrameResults: FrameAnalysisResult[];
  timelineEvents: VideoTimelineEvent[];
  audioSync?: AudioVideoSyncMetrics;
  modelNamesUsed: string[];
  limitations: string[];
  disclaimer: string;
}

// ==========================================
// Module 6 & 7: Derived Artifacts & Permanent Reports Repository
// ==========================================
export interface DerivedArtifact {
  id: string;
  parentEvidenceId: string;
  parentSha256: string;
  derivationType: 'keyframe' | 'audio_track' | 'crop_roi' | 'spectral_residual' | 'difference_mask';
  sha256Hash: string;
  fileSizeBytes: number;
  mimeType: string;
  storageUrl?: string;
  timestampSec?: number;
  frameIndex?: number;
  createdAt: string;
}

export interface PermanentReportRecord {
  id: string;
  reportNumber: string;
  caseId?: string; // Optional because original case might be deleted
  historicalCaseId: string;
  historicalCaseNumber: string;
  title: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  summary: string;
  conclusion: string;
  findingCount: number;
  evidenceCount: number;
  reportSnapshot: ForensicReport;
  rawJsonExport?: string;
  pdfExportAvailable: boolean;
  caseDeleted: boolean;
  caseDeletedAt?: string;
  evidenceRetained: boolean;
  evidenceRetentionPolicy: 'statutory_permanent' | 'purged_with_case' | 'manual';
  tamperVerified: boolean;
  auditSignature?: string;
}
