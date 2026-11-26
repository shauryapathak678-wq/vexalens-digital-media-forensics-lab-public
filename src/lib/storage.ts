import {
  Investigation,
  EvidenceItem,
  AnalysisFinding,
  ProvenanceEvent,
  ActivityLog,
  UserProfile,
  EvidenceCertificate,
  PermanentReportRecord,
  DerivedArtifact,
} from '@/types/forensics';
import {
  SAMPLE_USER,
  INITIAL_INVESTIGATIONS,
  INITIAL_EVIDENCE,
  INITIAL_FINDINGS,
  INITIAL_PROVENANCE,
  INITIAL_ACTIVITY,
  INITIAL_CERTIFICATES,
} from './sampleData';
import { getSupabaseClient, isSupabaseConfigured } from './supabase';
import {
  syncCreateInvestigation,
  syncUpdateInvestigation,
  syncDeleteInvestigation,
  syncDeleteEvidenceItem,
  syncAddFinding,
  syncDeleteFinding,
  syncAddProvenanceEvent,
  syncLogActivity,
  syncSaveReport,
} from './supabase-sync';

const KEYS = {
  USER: 'vexalens_user_profile',
  INVESTIGATIONS: 'vexalens_investigations',
  EVIDENCE: 'vexalens_evidence_items',
  FINDINGS: 'vexalens_findings',
  PROVENANCE: 'vexalens_provenance',
  ACTIVITY: 'vexalens_activity_logs',
  REPORTS: 'vexalens_permanent_reports',
  DERIVED_ARTIFACTS: 'vexalens_derived_artifacts',
};

function getStored<T>(key: string, defaultValue: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return defaultValue;
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Error reading ${key} from storage:`, e);
    return defaultValue;
  }
}

function setStored<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error(`Error writing ${key} to storage:`, e);
  }
}

// User Profile
export function getCurrentUser(): UserProfile {
  return getStored<UserProfile>(KEYS.USER, {
    id: 'local-user',
    email: '',
    fullName: 'Local Analyst',
    badgeNumber: '',
    agency: 'Local Workspace',
    role: 'lead_analyst',
    createdAt: new Date().toISOString(),
  });
}

export function updateCurrentUser(updates: Partial<UserProfile>): UserProfile {
  const current = getCurrentUser();
  const updated = { ...current, ...updates };
  setStored(KEYS.USER, updated);
  return updated;
}

// Investigations
export function getInvestigations(): Investigation[] {
  const all = getStored<Investigation[]>(KEYS.INVESTIGATIONS, []);
  const demoIds = new Set(INITIAL_INVESTIGATIONS.map((item) => item.id));
  return all.filter((item) => !demoIds.has(item.id));
}

export function getInvestigation(id: string): Investigation | undefined {
  const list = getInvestigations();
  return list.find((i) => i.id === id);
}

export function replaceLocalInvestigationCache(investigations: Investigation[]): void {
  setStored(KEYS.INVESTIGATIONS, investigations);
}

export function createInvestigation(
  data: Omit<Investigation, 'id' | 'createdAt' | 'updatedAt'>,
  options: { sync?: boolean } = {}
): Investigation {
  const list = getInvestigations();
  const newInv: Investigation = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    evidenceCount: 0,
  };

  const updated = [newInv, ...list];
  setStored(KEYS.INVESTIGATIONS, updated);

  logActivity('CASE_CREATED', `Case ${newInv.caseNumber} ("${newInv.title}") created`, newInv.id, newInv.caseNumber);

  if (options.sync !== false && isSupabaseConfigured()) {
    void syncCreateInvestigation(newInv);
  }

  return newInv;
}

export function removeLocalInvestigation(id: string): void {
  setStored(KEYS.INVESTIGATIONS, getInvestigations().filter((item) => item.id !== id));
}

export function updateInvestigation(
  id: string,
  updates: Partial<Investigation>,
  options: { sync?: boolean } = {}
): Investigation | undefined {
  const list = getInvestigations();
  const index = list.findIndex((i) => i.id === id);
  if (index === -1) return undefined;

  const updatedItem: Investigation = {
    ...list[index],
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  list[index] = updatedItem;
  setStored(KEYS.INVESTIGATIONS, list);

  logActivity('CASE_UPDATED', `Case ${updatedItem.caseNumber} updated`, updatedItem.id, updatedItem.caseNumber);

  // Fire-and-forget sync when callers do not explicitly own the transaction.
  if (options.sync !== false && isSupabaseConfigured()) {
    void syncUpdateInvestigation(id, updates).catch(() => {});
  }

  return updatedItem;
}

export function deleteInvestigation(
  id: string,
  options?: { retainEvidenceFiles?: boolean; sync?: boolean }
): boolean {
  let list = getInvestigations();
  const item = list.find((i) => i.id === id);
  if (!item) return false;

  list = list.filter((i) => i.id !== id);
  setStored(KEYS.INVESTIGATIONS, list);

  // CRITICAL AUDIT REQUIREMENT (Module 7):
  // Never cascading-delete reports with the case!
  // Reports must remain permanently retrievable in the Reports Repository.
  const allReports = getPermanentReports();
  let preservedCount = 0;
  const updatedReports = allReports.map((r) => {
    if (r.caseId === id || r.historicalCaseId === id) {
      preservedCount++;
      return {
        ...r,
        caseId: undefined, // Unlink active foreign key
        caseDeleted: true,
        caseDeletedAt: new Date().toISOString(),
        evidenceRetained: Boolean(options?.retainEvidenceFiles),
        updatedAt: new Date().toISOString(),
      };
    }
    return r;
  });
  setStored(KEYS.REPORTS, updatedReports);

  // Handle original evidence files according to configured retention policy
  if (!options?.retainEvidenceFiles) {
    const evidence = getEvidenceItems().filter((e) => e.investigationId !== id);
    setStored(KEYS.EVIDENCE, evidence);
  }

  // Active findings associated with this specific case workspace
  const findings = getFindings().filter((f) => f.investigationId !== id);
  setStored(KEYS.FINDINGS, findings);

  logActivity(
    'CASE_DELETED_REPORTS_PRESERVED',
    `Case ${item.caseNumber} was deleted. ${preservedCount} generated report(s) permanently preserved in the Reports Repository under statutory audit retention. Evidence retained: ${Boolean(options?.retainEvidenceFiles)}.`,
    undefined,
    item.caseNumber
  );

  // Fire-and-forget only for callers that do not explicitly own the transaction.
  if (options?.sync !== false && isSupabaseConfigured()) {
    void syncDeleteInvestigation(id).catch(() => {});
  }

  return true;
}

// Evidence Items
export function replaceLocalEvidenceCache(evidence: EvidenceItem[]): void {
  setStored(KEYS.EVIDENCE, evidence);
}

export function getEvidenceItems(investigationId?: string): EvidenceItem[] {
  let all = getStored<EvidenceItem[]>(KEYS.EVIDENCE, []);
  if (!all) all = [];
  
  // Filter out any leftover demo items if no-demo mode is active
  const demoIds = new Set(INITIAL_EVIDENCE.map((item) => item.id));
  all = all.filter((item) => !demoIds.has(item.id));

  // Ensure previewUrl is valid
  all = all.map((item) => {
    if (item.previewUrl?.startsWith('blob:') && item.thumbnailUrl) {
      return { ...item, previewUrl: item.thumbnailUrl };
    }
    return item;
  });

  if (investigationId) {
    return all.filter((e) => e.investigationId === investigationId);
  }
  return all;
}

export function getEvidenceItem(id: string): EvidenceItem | undefined {
  const all = getEvidenceItems();
  return all.find((e) => e.id === id);
}

export function updateEvidenceThumbnail(id: string, thumbnailUrl: string): EvidenceItem | undefined {
  const all = getEvidenceItems();
  const updatedItem = all.find((item) => item.id === id);
  if (!updatedItem) return undefined;
  updatedItem.thumbnailUrl = thumbnailUrl;
  setStored(KEYS.EVIDENCE, all);
  return updatedItem;
}

export function updateEvidenceItem(id: string, updates: Partial<EvidenceItem>): EvidenceItem | undefined {
  const all = getEvidenceItems();
  const index = all.findIndex((item) => item.id === id);
  if (index === -1) return undefined;
  const updatedItem = { ...all[index], ...updates };
  all[index] = updatedItem;
  setStored(KEYS.EVIDENCE, all);
  return updatedItem;
}

export function addEvidenceItem(
  itemData: Omit<EvidenceItem, 'id' | 'createdAt'>,
  id?: string
): EvidenceItem {
  const all = getEvidenceItems();
  const newItem: EvidenceItem = {
    ...itemData,
    id: id || `evi_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
  };

  setStored(KEYS.EVIDENCE, [newItem, ...all]);

  // Update case evidence count
  const inv = getInvestigation(newItem.investigationId);
  if (inv) {
    updateInvestigation(inv.id, {
      evidenceCount: (inv.evidenceCount || 0) + 1,
    });
  }

  // Record intake provenance event
  addProvenanceEvent({
    evidenceId: newItem.id,
    investigationId: newItem.investigationId,
    actionType: 'intake',
    actor: getCurrentUser().fullName,
    recordedSha256: newItem.sha256Hash,
    verifiedMatch: false,
    notes: `Initial evidence intake. SHA-256 recorded: ${newItem.sha256Hash}; no trusted reference digest was supplied.`,
  });

  logActivity(
    'EVIDENCE_INGESTED',
    `Evidence "${newItem.fileName}" ingested into case ${inv?.caseNumber || 'Unknown'}`,
    newItem.investigationId,
    inv?.caseNumber
  );

  return newItem;
}

export function deleteEvidenceItem(id: string): boolean {
  let all = getEvidenceItems();
  const item = all.find((e) => e.id === id);
  if (!item) return false;

  all = all.filter((e) => e.id !== id);
  setStored(KEYS.EVIDENCE, all);

  // Update investigation count
  const inv = getInvestigation(item.investigationId);
  if (inv && inv.evidenceCount && inv.evidenceCount > 0) {
    updateInvestigation(inv.id, {
      evidenceCount: inv.evidenceCount - 1,
    });
  }

  if (isSupabaseConfigured()) {
    syncDeleteEvidenceItem(id).catch(() => {});
  }

  return true;
}

// Findings
export function getFindings(investigationId?: string): AnalysisFinding[] {
  let all = getStored<AnalysisFinding[]>(KEYS.FINDINGS, []);
  const demoIds = new Set(INITIAL_FINDINGS.map((item) => item.id));
  all = all.filter((item) => !demoIds.has(item.id));
  if (investigationId) {
    return all.filter((f) => f.investigationId === investigationId);
  }
  return all;
}

export function addFinding(findingData: Omit<AnalysisFinding, 'id' | 'createdAt'>): AnalysisFinding {
  const all = getFindings();
  const newFinding: AnalysisFinding = {
    ...findingData,
    id: `fnd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
  };

  setStored(KEYS.FINDINGS, [newFinding, ...all]);

  const inv = getInvestigation(newFinding.investigationId);
  logActivity(
    'FINDING_RECORDED',
    `Finding recorded: "${newFinding.title}" [${newFinding.severity.toUpperCase()}]`,
    newFinding.investigationId,
    inv?.caseNumber
  );

  if (isSupabaseConfigured()) {
    syncAddFinding(newFinding).catch(() => {});
  }

  return newFinding;
}

export function deleteFinding(id: string): boolean {
  let all = getFindings();
  const finding = all.find((f) => f.id === id);
  if (!finding) return false;

  all = all.filter((f) => f.id !== id);
  setStored(KEYS.FINDINGS, all);

  if (isSupabaseConfigured()) {
    syncDeleteFinding(id).catch(() => {});
  }

  return true;
}

// Provenance
export function getProvenanceEvents(evidenceId?: string): ProvenanceEvent[] {
  let all = getStored<ProvenanceEvent[]>(KEYS.PROVENANCE, []);
  const demoIds = new Set(INITIAL_PROVENANCE.map((item) => item.id));
  all = all.filter((item) => !demoIds.has(item.id));
  if (evidenceId) {
    return all.filter((p) => p.evidenceId === evidenceId);
  }
  return all;
}

export function addProvenanceEvent(eventData: Omit<ProvenanceEvent, 'id' | 'timestamp'>): ProvenanceEvent {
  const all = getProvenanceEvents();
  const newEvent: ProvenanceEvent = {
    ...eventData,
    id: `prv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
  };

  setStored(KEYS.PROVENANCE, [newEvent, ...all]);

  if (isSupabaseConfigured()) {
    syncAddProvenanceEvent(eventData).catch(() => {});
  }

  return newEvent;
}

// Activity Logs
export function getActivityLogs(): ActivityLog[] {
  const all = getStored<ActivityLog[]>(KEYS.ACTIVITY, []);
  const demoIds = new Set(INITIAL_ACTIVITY.map((item) => item.id));
  return all.filter((item) => !demoIds.has(item.id));
}

export function logActivity(eventType: string, description: string, investigationId?: string, caseNumber?: string): ActivityLog {
  const logs = getActivityLogs();
  const newLog: ActivityLog = {
    id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    userId: getCurrentUser().id,
    investigationId,
    caseNumber,
    eventType,
    description,
    timestamp: new Date().toISOString(),
  };

  setStored(KEYS.ACTIVITY, [newLog, ...logs.slice(0, 99)]); // Keep last 100

  if (isSupabaseConfigured()) {
    syncLogActivity(eventType, description, investigationId, caseNumber).catch(() => {});
  }

  return newLog;
}

// Certificates
const KEY_CERTIFICATES = 'vexalens_certificates';

export function getCertificates(): EvidenceCertificate[] {
  const all = getStored<EvidenceCertificate[]>(KEY_CERTIFICATES, []);
  const demoIds = new Set(INITIAL_CERTIFICATES.map((item) => item.certificateId));
  return all.filter((item) => !demoIds.has(item.certificateId));
}

export function getCertificate(id: string): EvidenceCertificate | undefined {
  const all = getCertificates();
  return all.find((c) => c.certificateId === id || c.evidenceId === id);
}

export function saveCertificate(cert: EvidenceCertificate): EvidenceCertificate {
  const all = getCertificates();
  const existingIdx = all.findIndex((c) => c.certificateId === cert.certificateId);
  let updated: EvidenceCertificate[];
  if (existingIdx >= 0) {
    all[existingIdx] = cert;
    updated = [...all];
  } else {
    updated = [cert, ...all];
  }
  setStored(KEY_CERTIFICATES, updated);

  logActivity(
    'CERTIFICATE_ISSUED',
    `Evidence integrity certificate ${cert.certificateId} issued for "${cert.fileName}"`,
    cert.investigationId,
    cert.caseNumber
  );

  return cert;
}

export function revokeCertificate(certificateId: string, reason: string): boolean {
  const all = getCertificates();
  const cert = all.find((c) => c.certificateId === certificateId);
  if (!cert) return false;

  cert.status = 'revoked';
  cert.revocationReason = reason;
  setStored(KEY_CERTIFICATES, all);

  logActivity(
    'CERTIFICATE_REVOKED',
    `Certificate ${certificateId} revoked: ${reason}`,
    cert.investigationId,
    cert.caseNumber
  );

  return true;
}

// Reset data to factory state
export function resetToSampleData(): void {
  setStored(KEYS.USER, SAMPLE_USER);
  setStored(KEYS.INVESTIGATIONS, INITIAL_INVESTIGATIONS);
  setStored(KEYS.EVIDENCE, INITIAL_EVIDENCE);
  setStored(KEYS.FINDINGS, INITIAL_FINDINGS);
  setStored(KEYS.PROVENANCE, INITIAL_PROVENANCE);
  setStored(KEYS.ACTIVITY, INITIAL_ACTIVITY);
  setStored(KEY_CERTIFICATES, INITIAL_CERTIFICATES);
}

export function removeDemoData(): void {
  const demoCaseIds = new Set(INITIAL_INVESTIGATIONS.map((item) => item.id));
  const demoEvidenceIds = new Set(INITIAL_EVIDENCE.map((item) => item.id));
  const demoFindingIds = new Set(INITIAL_FINDINGS.map((item) => item.id));
  const demoProvenanceIds = new Set(INITIAL_PROVENANCE.map((item) => item.id));
  const demoActivityIds = new Set(INITIAL_ACTIVITY.map((item) => item.id));
  const demoCertificateIds = new Set(INITIAL_CERTIFICATES.map((item) => item.certificateId));

  const evidence = getEvidenceItems();
  setStored(
    KEYS.INVESTIGATIONS,
    getInvestigations().filter((item) =>
      !demoCaseIds.has(item.id) &&
      !(
        item.caseNumber === 'VL-2026-001' &&
        item.title === 'Primary Forensic Investigation' &&
        !evidence.some((entry) => entry.investigationId === item.id)
      )
    )
  );
  setStored(KEYS.EVIDENCE, getEvidenceItems().filter((item) => !demoEvidenceIds.has(item.id)));
  setStored(KEYS.FINDINGS, getFindings().filter((item) => !demoFindingIds.has(item.id)));
  setStored(KEYS.PROVENANCE, getProvenanceEvents().filter((item) => !demoProvenanceIds.has(item.id)));
  setStored(KEYS.ACTIVITY, getActivityLogs().filter((item) => !demoActivityIds.has(item.id)));
  setStored(KEY_CERTIFICATES, getCertificates().filter((item) => !demoCertificateIds.has(item.certificateId)));

  if (getCurrentUser().id === SAMPLE_USER.id) {
    localStorage.removeItem(KEYS.USER);
  }
}

// ==========================================
// Module 7: Permanent Reports Repository API
// ==========================================
export function getPermanentReports(): PermanentReportRecord[] {
  return getStored<PermanentReportRecord[]>(KEYS.REPORTS, []);
}

export function getPermanentReport(idOrNumber: string): PermanentReportRecord | undefined {
  const all = getPermanentReports();
  return all.find((r) => r.id === idOrNumber || r.reportNumber === idOrNumber);
}

export function savePermanentReport(
  record: Omit<PermanentReportRecord, 'updatedAt'>
): PermanentReportRecord {
  const all = getPermanentReports();
  const existingIdx = all.findIndex(
    (r) => r.id === record.id || r.reportNumber === record.reportNumber
  );

  const completeRecord: PermanentReportRecord = {
    ...record,
    updatedAt: new Date().toISOString(),
  };

  let updatedList: PermanentReportRecord[];
  if (existingIdx >= 0) {
    all[existingIdx] = completeRecord;
    updatedList = [...all];
  } else {
    updatedList = [completeRecord, ...all];
  }

  setStored(KEYS.REPORTS, updatedList);

  logActivity(
    'REPORT_ARCHIVED',
    `Permanent forensic report ${completeRecord.reportNumber} archived in statutory repository.`,
    completeRecord.caseId,
    completeRecord.historicalCaseNumber
  );

  if (isSupabaseConfigured()) {
    syncSaveReport(completeRecord).catch(() => {});
  }

  return completeRecord;
}

export function deletePermanentReport(reportId: string): boolean {
  const currentUser = getCurrentUser();
  // Only administrators can purge statutory audit records
  if (currentUser.role !== 'administrator') {
    throw new Error('Unauthorized: Only administrators with audit clearance can purge permanent reports.');
  }

  let all = getPermanentReports();
  const item = all.find((r) => r.id === reportId);
  if (!item) return false;

  all = all.filter((r) => r.id !== reportId);
  setStored(KEYS.REPORTS, all);

  logActivity(
    'REPORT_PURGED',
    `Permanent report ${item.reportNumber} was purged by administrator ${currentUser.fullName}.`,
    item.caseId,
    item.historicalCaseNumber
  );

  return true;
}

// ==========================================
// Module 6: Derived Artifacts Management
// ==========================================
export function getDerivedArtifacts(parentEvidenceId?: string): DerivedArtifact[] {
  const all = getStored<DerivedArtifact[]>(KEYS.DERIVED_ARTIFACTS, []);
  if (parentEvidenceId) {
    return all.filter((a) => a.parentEvidenceId === parentEvidenceId);
  }
  return all;
}

export function addDerivedArtifact(
  data: Omit<DerivedArtifact, 'id' | 'createdAt'>
): DerivedArtifact {
  const all = getDerivedArtifacts();
  const newArtifact: DerivedArtifact = {
    ...data,
    id: `art_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
  };

  setStored(KEYS.DERIVED_ARTIFACTS, [newArtifact, ...all]);

  logActivity(
    'DERIVED_ARTIFACT_CREATED',
    `Derived artifact ${newArtifact.derivationType} (SHA-256: ${newArtifact.sha256Hash.slice(0, 12)}...) recorded for evidence ${data.parentEvidenceId}.`
  );

  return newArtifact;
}
