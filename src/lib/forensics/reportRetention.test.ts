import { describe, it, expect, beforeEach } from 'vitest';
import {
  createInvestigation,
  getInvestigations,
  deleteInvestigation,
  addEvidenceItem,
  getEvidenceItems,
  addFinding,
  getFindings,
  savePermanentReport,
  getPermanentReports,
  getPermanentReport,
  deletePermanentReport,
  updateCurrentUser,
} from '@/lib/storage';
import { PermanentReportRecord, ForensicReport } from '@/types/forensics';

// Polyfill localStorage for Node test runner
const memoryStorage = new Map<string, string>();
const mockLocalStorage = {
  getItem: (key: string) => (memoryStorage.has(key) ? memoryStorage.get(key)! : null),
  setItem: (key: string, val: string) => memoryStorage.set(key, String(val)),
  removeItem: (key: string) => memoryStorage.delete(key),
  clear: () => memoryStorage.clear(),
};
if (typeof globalThis.localStorage === 'undefined') {
  (globalThis as any).localStorage = mockLocalStorage;
}

describe('Permanent Report Repository & Statutory Case Deletion (Module 7)', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
    updateCurrentUser({ role: 'administrator', fullName: 'Chief Auditor' });
  });

  it('proves that generated reports permanently survive case deletion', () => {
    // 1. Create an investigation case
    const newCase = createInvestigation({
      caseNumber: 'VL-AUDIT-2026-901',
      title: 'Homicide Digital Evidence Forensic Review',
      description: 'Examination of suspected altered video and photographs.',
      userId: 'examiner_01',
      status: 'in_progress',
      priority: 'critical',
      leadInvestigator: 'Inspector Sharma',
    });

    const activeCases = getInvestigations();
    expect(activeCases.some((c) => c.id === newCase.id)).toBe(true);

    // 2. Add evidence and findings
    const evidence = addEvidenceItem({
      investigationId: newCase.id,
      userId: 'examiner_01',
      fileName: 'surveillance_capture.mp4',
      fileSize: 12500000,
      mimeType: 'video/mp4',
      mediaType: 'video',
      sha256Hash: 'a1b2c3d4e5f607182930415263748596a1b2c3d4e5f607182930415263748596',
      storageUrl: 'local://evidence/surveillance.mp4',
      previewUrl: 'blob:http://localhost:3000/mock-video',
      isOriginal: true,
      verified: true,
      metadata: {},
    });

    const finding = addFinding({
      investigationId: newCase.id,
      evidenceId: evidence.id,
      title: 'Facial Boundary Seam Anomaly',
      severity: 'warning',
      category: 'synthetic_deepfake',
      observedEvidence: 'Local gradient disparity measured at 64.5%.',
      detectionMethod: 'VexaLens Face Seam Analyzer',
      detectorVersion: 'v1.3',
      evidenceLabel: 'observed_fact',
    });

    // 3. Generate and archive a statutory report
    const reportSnapshot: ForensicReport = {
      id: 'REP-AUDIT-2026-001',
      investigationId: newCase.id,
      caseNumber: newCase.caseNumber,
      reportNumber: 'REP-AUDIT-2026-001',
      title: `Forensic Media Dossier — ${newCase.title}`,
      summary: 'Automated forensic examination complete under ISO/IEC 27037 standards.',
      leadInvestigator: 'Inspector Sharma',
      badgeNumber: 'SH-9012',
      agency: 'State Forensics Laboratory',
      createdAt: new Date().toISOString(),
      evidenceList: [
        {
          id: evidence.id,
          fileName: evidence.fileName,
          mediaType: evidence.mediaType,
          sha256: evidence.sha256Hash,
          fileSizeBytes: evidence.fileSize,
          mimeType: evidence.mimeType,
          hashStatus: 'calculated',
          metadata: {},
          isOriginal: true,
        },
      ],
      findings: [finding],
    };

    const archivedReport: PermanentReportRecord = {
      id: 'REP-AUDIT-2026-001',
      reportNumber: 'REP-AUDIT-2026-001',
      caseId: newCase.id,
      historicalCaseId: newCase.id,
      historicalCaseNumber: newCase.caseNumber,
      title: `Forensic Media Dossier — ${newCase.title}`,
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      summary: 'Examination complete.',
      conclusion: 'likely_manipulated',
      findingCount: 1,
      evidenceCount: 1,
      reportSnapshot,
      pdfExportAvailable: true,
      caseDeleted: false,
      evidenceRetained: true,
      evidenceRetentionPolicy: 'statutory_permanent',
      tamperVerified: true,
    };

    savePermanentReport(archivedReport);

    // Verify initial storage
    expect(getPermanentReports().length).toBe(1);
    expect(getPermanentReport('REP-AUDIT-2026-001')).toBeDefined();

    // 4. NOW DELETE THE INVESTIGATION CASE
    const deleteSuccess = deleteInvestigation(newCase.id, { retainEvidenceFiles: false });
    expect(deleteSuccess).toBe(true);

    // Verify the case is removed from active workspace
    const casesAfterDeletion = getInvestigations();
    expect(casesAfterDeletion.some((c) => c.id === newCase.id)).toBe(false);

    // 5. CRITICAL AUDIT PROOF:
    // Report must still exist in Permanent Reports Repository!
    const survivingReports = getPermanentReports();
    expect(survivingReports.length).toBe(1);

    const survivingReport = getPermanentReport('REP-AUDIT-2026-001');
    expect(survivingReport).toBeDefined();

    // Verify statutory case deletion retention metadata
    expect(survivingReport?.caseDeleted).toBe(true);
    expect(survivingReport?.caseDeletedAt).toBeDefined();
    expect(survivingReport?.historicalCaseId).toBe(newCase.id);
    expect(survivingReport?.historicalCaseNumber).toBe(newCase.caseNumber);
    expect(survivingReport?.evidenceRetained).toBe(false);

    // Verify that the frozen snapshot with evidence list & findings is intact!
    expect(survivingReport?.reportSnapshot.findings.length).toBe(1);
    expect(survivingReport?.reportSnapshot.findings[0].title).toBe('Facial Boundary Seam Anomaly');
    expect(survivingReport?.reportSnapshot.evidenceList[0].sha256).toBe(evidence.sha256Hash);
  });

  it('respects retainEvidenceFiles option when case is deleted', () => {
    const newCase = createInvestigation({
      caseNumber: 'VL-VAULT-2026-555',
      title: 'Custody Vault Preservation Case',
      description: 'Preserving evidence files in secure vault.',
      userId: 'examiner_02',
      status: 'open',
      priority: 'high',
      leadInvestigator: 'Analyst Roy',
    });

    const evidence = addEvidenceItem({
      investigationId: newCase.id,
      userId: 'examiner_02',
      fileName: 'retained_doc.png',
      fileSize: 450000,
      mimeType: 'image/png',
      mediaType: 'image',
      sha256Hash: '99887766554433221100aabbccddeeff99887766554433221100aabbccddeeff',
      storageUrl: 'local://evidence/retained_doc.png',
      previewUrl: 'blob:http://localhost:3000/doc',
      isOriginal: true,
      verified: true,
      metadata: {},
    });

    // Delete case while choosing to retain evidence files
    deleteInvestigation(newCase.id, { retainEvidenceFiles: true });

    // Original evidence remains preserved in the storage vault
    const evidenceInVault = getEvidenceItems();
    expect(evidenceInVault.some((e) => e.id === evidence.id)).toBe(true);
  });

  it('enforces role authorization on permanent report purging', () => {
    // Save a report
    savePermanentReport({
      id: 'REP-SECURE-999',
      reportNumber: 'REP-SECURE-999',
      historicalCaseId: 'inv_x',
      historicalCaseNumber: 'VL-CASE-X',
      title: 'Confidential Audit Dossier',
      version: 1,
      createdAt: new Date().toISOString(),
      summary: 'Confidential examination.',
      conclusion: 'likely_authentic',
      findingCount: 0,
      evidenceCount: 0,
      reportSnapshot: {
        caseNumber: 'VL-CASE-X',
        reportNumber: 'REP-SECURE-999',
        title: 'Confidential Audit Dossier',
        summary: '',
        leadInvestigator: 'Examiner',
        badgeNumber: 'B1',
        agency: 'Agency',
        createdAt: new Date().toISOString(),
        evidenceList: [],
        findings: [],
      },
      pdfExportAvailable: true,
      caseDeleted: true,
      evidenceRetained: false,
      evidenceRetentionPolicy: 'statutory_permanent',
      tamperVerified: true,
    });

    // Demote current user to investigator (non-admin)
    updateCurrentUser({ role: 'investigator' });

    // Deletion should throw authorization error
    expect(() => deletePermanentReport('REP-SECURE-999')).toThrow(/Unauthorized/);

    // Promote to administrator
    updateCurrentUser({ role: 'administrator' });
    const success = deletePermanentReport('REP-SECURE-999');
    expect(success).toBe(true);
    expect(getPermanentReport('REP-SECURE-999')).toBeUndefined();
  });
});
