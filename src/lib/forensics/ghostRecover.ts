import { calculateSHA256 } from './crypto';

export const GHOSTRECOVER_STORAGE_KEY = 'vexalens_ghostrecover_records_v1';

export type GhostRecoverApp =
  | 'WhatsApp'
  | 'Snapchat'
  | 'Instagram Vanish Mode'
  | 'Telegram Secret Chats'
  | 'Signal'
  | 'Other';

export type GhostRecoverPlatform = 'Android' | 'iOS' | 'Other';

export type GhostRecoverEventType =
  | 'message_sent'
  | 'message_received'
  | 'disappearing_mode_enabled'
  | 'backup_created'
  | 'notification_observed'
  | 'investigator_note'
  | 'other';

export interface GhostRecoverArtifact {
  id: string;
  caseId: string;
  caseNumber: string;
  fileName: string;
  fileSizeBytes: number;
  mimeType: string;
  sha256: string;
  sourceApp: GhostRecoverApp;
  platform: GhostRecoverPlatform;
  acquisitionMethod: string;
  importedAt: string;
  operator: string;
}

export interface GhostRecoverTimelineEvent {
  id: string;
  caseId: string;
  occurredAt: string;
  recordedAt: string;
  sourceApp: GhostRecoverApp;
  eventType: GhostRecoverEventType;
  participant: string;
  summary: string;
  artifactId: string | null;
}

export interface GhostRecoverCustodyEntry {
  id: string;
  caseId: string;
  action: 'artifact_hashed' | 'timeline_event_recorded';
  actor: string;
  recordedAt: string;
  subjectId: string;
  subjectSha256: string;
  previousDigest: string | null;
  entrySha256: string;
}

export interface GhostRecoverCaseRecord {
  artifacts: GhostRecoverArtifact[];
  timeline: GhostRecoverTimelineEvent[];
  custody: GhostRecoverCustodyEntry[];
}

export interface GhostRecoverStore {
  schemaVersion: 1;
  cases: Record<string, GhostRecoverCaseRecord>;
}

type GhostRecoverCustodyInput = Omit<GhostRecoverCustodyEntry, 'previousDigest' | 'entrySha256'>;

const EMPTY_CASE_RECORD: GhostRecoverCaseRecord = {
  artifacts: [],
  timeline: [],
  custody: [],
};

export function createEmptyGhostRecoverStore(): GhostRecoverStore {
  return { schemaVersion: 1, cases: {} };
}

export function getGhostRecoverCaseRecord(store: GhostRecoverStore, caseId: string): GhostRecoverCaseRecord {
  return store.cases[caseId] || {
    artifacts: [...EMPTY_CASE_RECORD.artifacts],
    timeline: [...EMPTY_CASE_RECORD.timeline],
    custody: [...EMPTY_CASE_RECORD.custody],
  };
}

export function parseGhostRecoverStore(serialized: string): GhostRecoverStore {
  const parsed: unknown = JSON.parse(serialized);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Stored GhostRecover data has an invalid format.');
  }

  const value = parsed as Partial<GhostRecoverStore>;
  if (value.schemaVersion !== 1 || !value.cases || typeof value.cases !== 'object') {
    throw new Error('Stored GhostRecover data is not a supported version.');
  }

  for (const [caseId, record] of Object.entries(value.cases)) {
    if (
      !caseId ||
      !record ||
      !Array.isArray(record.artifacts) ||
      !Array.isArray(record.timeline) ||
      !Array.isArray(record.custody)
    ) {
      throw new Error('Stored GhostRecover case data is incomplete or invalid.');
    }
  }

  return value as GhostRecoverStore;
}

function custodyDigestPayload(
  input: GhostRecoverCustodyInput,
  previousDigest: string | null,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    ...input,
    previousDigest,
  }));
}

export async function createGhostRecoverCustodyEntry(
  input: GhostRecoverCustodyInput,
  previousDigest: string | null,
): Promise<GhostRecoverCustodyEntry> {
  const entrySha256 = await calculateSHA256(custodyDigestPayload(input, previousDigest));
  return { ...input, previousDigest, entrySha256 };
}

export async function verifyGhostRecoverCustodyChain(
  entries: readonly GhostRecoverCustodyEntry[],
): Promise<{ valid: boolean; checkedCount: number; invalidIndex: number | null }> {
  let previousDigest: string | null = null;
  for (let index = 0; index < entries.length; index += 1) {
    const { entrySha256, previousDigest: recordedPreviousDigest, ...input } = entries[index];
    if (
      recordedPreviousDigest !== previousDigest ||
      entrySha256 !== await calculateSHA256(custodyDigestPayload(input, recordedPreviousDigest))
    ) {
      return { valid: false, checkedCount: index, invalidIndex: index };
    }
    previousDigest = entrySha256;
  }
  return { valid: true, checkedCount: entries.length, invalidIndex: null };
}

export async function buildGhostRecoverReport(
  caseNumber: string,
  artifacts: readonly GhostRecoverArtifact[],
  timeline: readonly GhostRecoverTimelineEvent[],
  custody: readonly GhostRecoverCustodyEntry[],
  generatedAt: string,
) {
  const custodyVerification = await verifyGhostRecoverCustodyChain(custody);
  return {
    reportName: 'GhostRecover Investigator-Provided Artifact Report',
    reportVersion: 1,
    generatedAt,
    caseNumber,
    summary: {
      artifactCount: artifacts.length,
      timelineEventCount: timeline.length,
      custodyEntryCount: custody.length,
      custodyChainVerification: custodyVerification,
    },
    artifacts,
    timeline: [...timeline].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)),
    chainOfCustody: custody,
    scopeAndLimitations: [
      'This report covers only files provided by an investigator and timeline entries entered by an investigator.',
      'GhostRecover does not access phones, extract app-private data, recover deleted messages, bypass disappearing-message features, or decrypt secret chats.',
      'Android and iOS identify the source platform only; no direct device parsing is implemented. iOS support is limited to investigator-provided exports or acquisition files.',
      'SHA-256 identifies the exact file bytes processed in this browser; it does not prove who created the file or how it was acquired.',
      'The custody chain is an integrity aid, not a digital signature. Browser storage can be changed; preserve and compare a downloaded report using an approved evidence system.',
      'A browser file import is not a hardware write blocker. Use a validated write blocker and approved acquisition procedure for device examinations.',
    ],
  };
}
