import type { AIOriginAssessmentResult } from '@/types/forensics';

export type ScreenshotCategory =
  | 'payment'
  | 'upi'
  | 'bank_receipt'
  | 'digital_invoice'
  | 'chat'
  | 'social_media'
  | 'application'
  | 'other';

export type ScreenshotAssessmentStatus =
  | 'no_indicators'
  | 'potential_manipulation'
  | 'inconclusive'
  | 'failed';

export type RegionSeverity = 'low' | 'medium' | 'high' | 'inconclusive';

export interface SuspiciousRegion {
  id: string;
  regionNumber: number;
  box: {
    x: number; // 0 to 1 normalized
    y: number; // 0 to 1 normalized
    width: number; // 0 to 1 normalized
    height: number; // 0 to 1 normalized
  };
  pixelBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  label: string;
  technique: string;
  modules: string[];
  evidenceFamilies: string[];
  signalLevel: 'single-test' | 'corroborated';
  simpleObservation?: string;
  easyWords?: string;
  reason: string;
  technicalObservations: string;
  limitations: string;
  cropDataUrl?: string;
  measurements: Record<string, Record<string, string | number>>;
}

export interface ModuleFinding {
  id: string;
  name: string;
  status: 'clean' | 'flagged' | 'inconclusive' | 'not_applicable';
  simpleObservation?: string;
  easyWords?: string;
  whatWasChecked: string;
  whatWasFound: string;
  whyItMatters: string;
  reliability: string;
  limitations: string;
  metrics: Record<string, string | number>;
  thresholds: Record<string, string | number>;
  affectedRegionIds: string[];
}

export interface ScreenshotOcrWord {
  text: string;
  box: { x: number; y: number; width: number; height: number };
  ocrConfidence: number;
  line: string;
  appearanceMeasurements?: {
    edge_density: number;
    laplacian_variance: number;
  };
}

export interface AiEvidenceDetectorResult {
  isAiGenerated: boolean;
  aiProbability: number;
  evidenceCategory: string;
  categoryConfidence: number;
  extractedText: string;
  textPreview: string;
}

export interface ScreenshotAnalysisResult {
  id: string;
  evidenceId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  sha256: string;
  md5: string;
  uploadTimestamp: string;
  analysisTimestamp: string;
  category: ScreenshotCategory;
  assessmentStatus: ScreenshotAssessmentStatus;
  simpleVerdict?: string;
  assessmentSummary: string;
  easyWordsSummary?: string;
  assessmentExplanation: string;
  assessmentMethod: string;
  suspiciousRegions: SuspiciousRegion[];
  moduleFindings: {
    textAndFont: ModuleFinding;
    compressionEla: ModuleFinding;
    copyMove: ModuleFinding;
    noiseAnalysis: ModuleFinding;
    resampling: ModuleFinding;
    imageBoundary: ModuleFinding;
    ocrLayout: ModuleFinding;
  };
  heatmapDataUrl: string;
  moduleOverlayDataUrls: Record<string, string>;
  originalDataUrl: string;
  annotatedDataUrl?: string;
  imageDimensions: {
    width: number;
    height: number;
  };
  imageMetadata: {
    format: string;
    exifAvailable: boolean;
    exif: Record<string, string>;
  };
  ocrText: ScreenshotOcrWord[];
  parameters: Record<string, string | number | boolean>;
  limitations: string[];
  processingTimeMs: number;
  /** Local spectral AI-origin analysis result — always populated by the client-side engine. */
  localAiOrigin?: AIOriginAssessmentResult;
  /** Optional Python Smaug & EasyOCR detector result from the ai_evidence_detector microservice */
  aiEvidenceDetector?: AiEvidenceDetectorResult;
}
