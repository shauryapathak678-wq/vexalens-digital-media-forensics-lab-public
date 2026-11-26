import type { Investigation } from '@/types/forensics';

export type EmailComparisonStatus =
  | 'match'
  | 'partial_match'
  | 'mismatch'
  | 'not_visible'
  | 'not_provided'
  | 'not_comparable'
  | 'ocr_uncertain'
  | 'timezone_unavailable';

export interface EmailFieldComparison {
  status: EmailComparisonStatus;
  screenshot: string | null;
  original: string | null;
  similarity?: number | null;
  screenshotOnly?: string[];
  originalOnly?: string[];
}

export interface EmailOcrLine {
  text: string;
  confidence: number;
  box: { x: number; y: number; width: number; height: number };
}

export interface EmailOcrWord {
  text: string;
  confidence: number;
  box: { x: number; y: number; width: number; height: number };
  lineKey: string;
}

export interface EmailIntelligence {
  deliveryPath: Array<{
    raw: string;
    fromHost: string | null;
    byHost: string | null;
    protocol: string | null;
    timestamp: string | null;
    timestampUtc: string | null;
    ips: string[];
    delayToOlderSeconds: number | null;
  }>;
  deliverySummary: {
    hopCount: number;
    order: string;
    totalDelaySeconds: number | null;
    origin: {
      candidateIp: string;
      fromServer: string | null;
      scope: string;
      country: string | null;
      confidence: string;
    } | null;
    geoIpNote: string | null;
  };
  authenticationAlignment: {
    fromDomain: string | null;
    returnPathDomain: string | null;
    returnPathAligned: boolean | null;
    spfDomains: string[];
    spfAligned: boolean | null;
    dkimDomains: Array<{ domain: string; aligned: boolean | null }>;
    replyToDomain: string | null;
    replyToAligned: boolean | null;
    note: string;
  };
  artifacts: {
    ips: Array<{ address: string; scope: string; country: string | null; sources: string[]; reputation: string }>;
    emails: string[];
    urls: string[];
    reputationNote: string;
  };
  risk: {
    level: 'low' | 'medium' | 'high' | 'critical';
    score: number;
    findings: string[];
    recommendation: string;
  };
}

export interface EmailVerifierResult {
  schemaVersion: number;
  processedAt: string;
  screenshot: {
    sha256: string | null;
    ocr: { status: string; reason?: string | null; text: string; lines: EmailOcrLine[]; words: EmailOcrWord[] };
    fields: Record<string, { value: string; confidence: number | null; box: EmailOcrLine['box'] | null; status: string }>;
  };
  email: {
    sha256: string;
    headers: Record<string, any>;
    body: { plainText: string; htmlText: string };
    attachments: Array<{ name: string; mimeType: string; sha256: string; sizeBytes: number }>;
    authentication: Record<string, unknown>;
    intelligence?: EmailIntelligence;
  } | null;
  comparisons: Record<string, EmailFieldComparison>;
  discrepancies: string[];
  visibility: Array<{ information: string; screenshot: string; original: string }>;
  observations: Array<{
    title: string;
    description: string;
    field: string;
    significance: string;
    status: EmailComparisonStatus;
    screenshotValue: string | null;
    originalValue: string | null;
  }>;
  conclusion: 'MATCHED' | 'DISCREPANCY DETECTED' | 'PARTIALLY MATCHED' | 'UNABLE TO VERIFY';
  limitations: string[];
}

export interface EmailVerificationRecord {
  id: string;
  investigationId: string;
  screenshotEvidenceId: string | null;
  emlEvidenceId: string | null;
  screenshotSha256: string | null;
  emlSha256: string | null;
  result: EmailVerifierResult;
  investigatorNotes: string;
  reportEvidenceId: string | null;
  reportSha256: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmailVerifierCreateCase extends Omit<Investigation, 'id' | 'createdAt' | 'updatedAt'> {}
