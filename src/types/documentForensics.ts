export type DocumentAnalysisStatus = 'parsed' | 'partially_parsed' | 'rejected';
export type DocumentFindingSeverity = 'informational' | 'low' | 'medium' | 'high' | 'critical';

export interface DocumentFinding {
  id: string;
  category: string;
  severity: DocumentFindingSeverity;
  title: string;
  observation: string;
  source: string;
  technicalExplanation: string;
  benignExplanations: string[];
  limitations: string[];
  recommendedAction: string;
  confidence: {
    level: 'high' | 'moderate' | 'low';
    explanation: string;
  };
}

export interface DocumentInconsistency {
  id: string;
  label: string;
  status: 'agree' | 'differ' | 'not_comparable';
  observations: Array<{ source: string; value: string }>;
  benignExplanations: string[];
  limitations: string[];
  recommendedAction: string;
}

export interface DocumentAnalysisResult {
  id: string;
  evidenceId: string;
  investigationId: string;
  filename: string;
  format: 'DOCX' | 'PDF' | 'UNKNOWN';
  fileSize: number;
  sha256: string;
  uploadedAt: string;
  analyzedAt: string;
  status: DocumentAnalysisStatus;
  parserVersions: Record<string, string>;
  properties: Record<string, string | number | boolean | null>;
  structure: Record<string, unknown>;
  findings: DocumentFinding[];
  inconsistencies: DocumentInconsistency[];
  missingMetadata: string[];
  limitations: string[];
  errors: string[];
  reportStoragePath?: string;
  reportSha256?: string;
  truthScanPdf?: {
    jobId?: string;
    status: 'uploading' | 'pending' | 'processing' | 'done' | 'failed';
    model: string;
    modules: string[];
    result?: Record<string, unknown>;
    creditsDeducted?: number;
    error?: string;
  };
}
