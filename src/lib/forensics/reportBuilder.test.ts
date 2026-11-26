import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import { buildForensicReport, buildPrintableReportHtml, buildSimpleReportContent } from './reportBuilder';
import { createForensicReportPDF, createSimpleReportPDF } from './pdfExport';
import type { ReportAuthenticationDisplay } from './reportAuthentication';
import type { EvidenceItem, Investigation, UserProfile } from '@/types/forensics';

const investigation: Investigation = {
  id: 'case-1',
  caseNumber: 'CASE-1',
  title: 'Test case',
  description: '',
  userId: 'user-1',
  status: 'open',
  priority: 'low',
  leadInvestigator: 'Analyst',
  createdAt: '2026-10-15T10:00:00.000Z',
  updatedAt: '2026-10-15T10:00:00.000Z',
};

const evidence: EvidenceItem = {
  id: 'evidence-1',
  investigationId: 'case-1',
  userId: 'user-1',
  fileName: 'photo.jpg',
  fileSize: 100,
  mimeType: 'image/jpeg',
  mediaType: 'image',
  sha256Hash: 'a'.repeat(64),
  storageUrl: 'blob:test',
  previewUrl: 'blob:test',
  isOriginal: false,
  verified: false,
  metadata: { fileFormat: 'image/jpeg' },
  createdAt: '2026-10-15T10:00:00.000Z',
};

const user: UserProfile = {
  id: 'user-1',
  email: '',
  fullName: 'Analyst',
  badgeNumber: '',
  agency: 'Local Workspace',
  role: 'investigator',
  createdAt: '2026-10-15T10:00:00.000Z',
};

describe('simple report content', () => {
  it('uses unable-to-analyze when a case has no evidence', () => {
    const report = buildSimpleReportContent({
      investigation,
      evidence: [],
      findings: [],
      reportId: 'REPORT-1',
      analysisDate: '2026-10-15T11:00:00.000Z',
    });

    expect(report.conclusion).toBe('unable_to_analyze');
    expect(report.findings).toEqual([]);
    expect(report.evidenceIds).toEqual([]);
  });

  it('keeps available hash and metadata checks inconclusive, not likely authentic', () => {
    const report = buildSimpleReportContent({
      investigation,
      evidence: [evidence],
      findings: [],
      reportId: 'REPORT-2',
      analysisDate: '2026-10-15T11:00:00.000Z',
      language: 'hi',
    });

    expect(report.conclusion).toBe('inconclusive');
    expect(report.checked).toHaveLength(2);
    expect(report.conclusionLabel).toBe('निष्कर्ष अस्पष्ट');
    expect(report.evidenceIds).toEqual(['evidence-1']);
  });

  it('uses unable-to-analyze when evidence has no recognized completed checks', () => {
    const report = buildSimpleReportContent({
      investigation,
      evidence: [{ ...evidence, sha256Hash: 'DEMO-NOT-CALCULATED', metadata: {} }],
      findings: [],
      reportId: 'REPORT-NO-CHECKS',
      analysisDate: 'Not recorded',
    });

    expect(report.conclusion).toBe('unable_to_analyze');
  });

  it('includes only actual evidence fields and methods in a detailed report snapshot', () => {
    const report = buildForensicReport({
      investigation,
      evidence: [{ ...evidence, previewUrl: 'https://third-party.example/image.jpg' }],
      findings: [],
      user,
      reportId: 'REPORT-3',
      createdAt: '2026-10-15T11:00:00.000Z',
    });

    expect(report.evidenceList[0]).toMatchObject({
      id: 'evidence-1',
      fileSizeBytes: 100,
      hashStatus: 'calculated',
      mimeType: 'image/jpeg',
    });
    expect(report.methodologiesUsed).toEqual(['SHA-256 file digest', 'Available metadata inspection']);
    expect(report.methodologiesUsed).not.toContain('AI detector');
    expect(report.evidenceList[0].verified).toBe(false);
  });

  it('separates media findings and includes only recorded certificates and custody events', () => {
    const video = { ...evidence, id: 'evidence-video', mediaType: 'video' as const, fileName: 'clip.mp4', mimeType: 'video/mp4' };
    const audio = { ...evidence, id: 'evidence-audio', mediaType: 'audio' as const, fileName: 'recording.wav', mimeType: 'audio/wav' };
    const recordedFinding = {
      id: 'finding-deepfake',
      investigationId: 'case-1',
      evidenceId: 'evidence-1',
      title: 'Model signal recorded',
      severity: 'medium' as const,
      category: 'synthetic_deepfake' as const,
      observedEvidence: 'A model signal was recorded.',
      simpleExplanation: 'This is one model result, not proof.',
      detectionMethod: 'Test detector',
      detectorVersion: '1',
      createdAt: '2026-10-15T11:00:00.000Z',
    };
    const report = buildForensicReport({
      investigation,
      evidence: [evidence, video, audio],
      findings: [recordedFinding],
      user,
      reportId: 'REPORT-SECTIONS',
      createdAt: '2026-10-15T11:00:00.000Z',
      certificates: [{
        certificateId: 'CERT-1',
        evidenceId: 'evidence-1',
        investigationId: 'case-1',
        caseNumber: 'CASE-1',
        fileName: 'photo.jpg',
        fileSizeBytes: 100,
        sha256Hash: 'a'.repeat(64),
        uploadTimestamp: '2026-10-15T10:00:00.000Z',
        analysisTimestamp: '2026-10-15T11:00:00.000Z',
        softwareVersion: '1',
        algorithmsApplied: [],
        manifestHash: 'b'.repeat(64),
        signature: 'c'.repeat(64),
        verificationPublicKeyId: 'test-key',
        status: 'valid',
        examinerName: 'Analyst',
        examinerBadge: '',
        agency: 'Local Workspace',
      }],
      provenance: [{
        id: 'custody-1',
        evidenceId: 'evidence-1',
        investigationId: 'case-1',
        actionType: 'custody_transfer',
        actor: 'Analyst',
        recordedSha256: 'a'.repeat(64),
        verifiedMatch: true,
        notes: 'Transferred for review.',
        timestamp: '2026-10-15T12:00:00.000Z',
      }],
    });
    const simple = buildSimpleReportContent({
      investigation,
      evidence: [evidence, video, audio],
      findings: [recordedFinding],
      reportId: 'REPORT-SECTIONS',
      analysisDate: '2026-10-15T11:00:00.000Z',
    });
    const html = buildPrintableReportHtml({ mode: 'detailed', language: 'en', simpleReport: simple, report });

    expect(html).toContain('Photo observations');
    expect(html).toContain('Video observations');
    expect(html).toContain('Audio observations');
    expect(html).toContain('Deepfake findings');
    expect(html.match(/A model signal was recorded\./g)).toHaveLength(2);
    expect(html).toContain('CERT-1');
    expect(html).toContain('Recorded chain of custody');
    expect(html).toContain('Transferred for review.');
  });

  it('uses the recorded observation separately from its explanation and does not invent detector confidence', () => {
    const report = buildSimpleReportContent({
      investigation,
      evidence: [evidence],
      findings: [{
        id: 'finding-observation',
        investigationId: 'case-1',
        evidenceId: 'evidence-1',
        title: 'Observed pixel anomaly',
        severity: 'medium',
        category: 'visual_anomaly',
        observedEvidence: 'A localized pixel discontinuity was recorded.',
        simpleExplanation: 'This may result from ordinary editing or compression.',
        detectionMethod: 'Test analysis',
        detectorVersion: 'test-1',
        createdAt: '2026-10-15T11:00:00.000Z',
      }],
      reportId: 'REPORT-OBSERVATION',
      analysisDate: '2026-10-15T11:00:00.000Z',
    });

    expect(report.findings[0]).toMatchObject({
      observation: 'A localized pixel discontinuity was recorded.',
      explanation: 'This may result from ordinary editing or compression.',
      text: 'A localized pixel discontinuity was recorded.',
    });
    expect(report.confidenceLabel).toContain('no scored detector result');
    expect(report.detectorCount).toBe(0);
  });

  it('records a clean model result as checked, not proof of authenticity', () => {
    const report = buildSimpleReportContent({
      investigation,
      evidence: [evidence],
      findings: [{
        id: 'finding-clean-model',
        investigationId: 'case-1',
        evidenceId: 'evidence-1',
        title: 'Synthetic-content detector result',
        severity: 'nominal',
        category: 'synthetic_deepfake',
        observedEvidence: 'No synthetic-content indicator was reported.',
        detectionMethod: 'Configured synthetic-content detector',
        detectorVersion: 'test-1',
        rawDetectorScore: 0.05,
        createdAt: '2026-10-15T11:00:00.000Z',
      }],
      reportId: 'REPORT-CLEAN-MODEL',
      analysisDate: '2026-10-15T11:00:00.000Z',
    });

    expect(report.conclusion).toBe('inconclusive');
    expect(report.domainConclusions.find((domain) => domain.domain === 'ai_content')).toMatchObject({
      state: 'checked',
      note: expect.stringContaining('does not establish authenticity'),
    });
  });

  it('includes a playable video and a safe poster frame in report previews', () => {
    const videoEvidence: EvidenceItem = {
      ...evidence,
      id: 'evidence-video',
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      mediaType: 'video',
      previewUrl: 'https://storage.example.test/video.mp4?token=signed',
      thumbnailUrl: 'data:image/jpeg;base64,ZmFrZQ==',
    };
    const simple = buildSimpleReportContent({
      investigation,
      evidence: [videoEvidence],
      findings: [],
      reportId: 'REPORT-VIDEO',
      analysisDate: '2026-10-15T11:00:00.000Z',
    });
    const report = buildForensicReport({
      investigation,
      evidence: [videoEvidence],
      findings: [],
      user,
      reportId: 'REPORT-VIDEO',
      createdAt: '2026-10-15T11:00:00.000Z',
    });
    const html = buildPrintableReportHtml({ mode: 'simple', language: 'en', simpleReport: simple, report });

    expect(simple.evidenceGallery[0].videoUrl).toBe(videoEvidence.previewUrl);
    expect(simple.evidenceGallery[0].imageUrl).toBe(videoEvidence.thumbnailUrl);
    expect(html).toContain('<video');
    expect(html).toContain('controls');
    expect(html).toContain('poster="data:image/jpeg;base64,ZmFrZQ=="');
    expect(html).not.toContain('javascript:');
  });

  it('creates a printable Hindi report and escapes case-supplied HTML', () => {
    const report = buildForensicReport({
      investigation: { ...investigation, title: '<script>bad()</script>' },
      evidence: [evidence],
      findings: [],
      user,
      reportId: 'REPORT-4',
      createdAt: '2026-10-15T11:00:00.000Z',
    });
    const simple = buildSimpleReportContent({
      investigation,
      evidence: [evidence],
      findings: [],
      reportId: 'REPORT-4',
      analysisDate: 'Not recorded',
      language: 'hi',
    });
    const reportHash = 'c'.repeat(64);
    const html = buildPrintableReportHtml({
      mode: 'simple',
      language: 'hi',
      simpleReport: simple,
      report,
      authentication: {
        record: {
          version: 'VEXA-REPORT-1',
          reportNumber: 'REPORT-4',
          caseNumber: 'CASE-1',
          reportHash,
          examinerName: 'Analyst',
          examinerBadge: 'A-123',
          agency: 'Test Lab',
          issuedAt: '2026-10-15T11:00:00.000Z',
          keyId: 'VEXA-HMAC-LOCAL',
          signature: 'd'.repeat(64),
        },
        verificationUrl: 'https://example.test/api/reports/verify?record=signed',
        qrDataUrl: 'data:image/png;base64,AAAA',
        signatureImageUrl: '/assets/examiner-signature.png',
      },
    });

    expect(html).toContain('lang="hi"');
    expect(html).toContain('निष्कर्ष अस्पष्ट');
    expect(html).toContain('परीक्षक के हस्ताक्षर और QR सत्यापन');
    expect(html).toContain(reportHash);
    expect(html).toContain('Digital signature:');
    expect(html).toContain('REPORT SIGNED');
    expect(html).toContain('.observation{font-weight:800}');
    expect(html).toContain('Electronically signed');
    expect(html).not.toContain('/assets/examiner-signature.png');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>bad()');
    expect(html).not.toContain('third-party.example');
  });

  it('generates valid PDF headers for simple and detailed reports', async () => {
    const report = buildForensicReport({
      investigation,
      evidence: [evidence],
      findings: [],
      user,
      reportId: 'REPORT-5',
      createdAt: '2026-10-15T11:00:00.000Z',
    });
    const simple = buildSimpleReportContent({
      investigation,
      evidence: [evidence],
      findings: [],
      reportId: 'REPORT-5',
      analysisDate: 'Not recorded',
    });
    const simplePdf = (await createSimpleReportPDF(simple)).output('arraybuffer');
    const detailedPdf = (await createForensicReportPDF(report)).output('arraybuffer');
    const decoder = new TextDecoder();

    expect(decoder.decode(simplePdf.slice(0, 4))).toBe('%PDF');
    expect(decoder.decode(detailedPdf.slice(0, 4))).toBe('%PDF');
    expect(simplePdf.byteLength).toBeGreaterThan(500);
    expect(detailedPdf.byteLength).toBeGreaterThan(500);
  });

  it('renders a premium cover and evidence-based dashboard without invented authenticity claims', async () => {
    const report = buildForensicReport({
      investigation,
      evidence: [evidence],
      findings: [],
      user,
      reportId: 'REPORT-PREMIUM',
      createdAt: '2026-10-15T11:00:00.000Z',
    });
    const simple = buildSimpleReportContent({
      investigation,
      evidence: [evidence],
      findings: [],
      reportId: 'REPORT-PREMIUM',
      analysisDate: 'Not available',
    });

    const simplePdf = (await createSimpleReportPDF(simple)).output();
    const detailedPdf = (await createForensicReportPDF(report, { simpleContent: simple })).output();

    expect(simplePdf).toContain('(DIGITAL MEDIA FORENSIC ANALYSIS) Tj');
    expect(simplePdf).toContain('(REPORT) Tj');
    expect(simplePdf).toContain('CONFIDENTIAL');
    expect(simplePdf).toContain('FORENSIC FINDINGS DASHBOARD');
    expect(simplePdf).toContain('CASE ID');
    expect(simplePdf).toContain('REPORT ID');
    expect(simplePdf).not.toContain('BASELINE MATCHED');
    expect(detailedPdf).toContain('(DIGITAL MEDIA FORENSIC ANALYSIS) Tj');
    expect(detailedPdf).toContain('FORENSIC FINDINGS DASHBOARD');
    expect(detailedPdf).not.toContain('INTEGRITY VERIFIED');
  });

  it('includes a signed report fingerprint and QR verification code in both PDF formats', async () => {
    const report = buildForensicReport({
      investigation,
      evidence: [evidence],
      findings: [],
      user,
      reportId: 'REPORT-SIGNED',
      createdAt: '2026-10-15T11:00:00.000Z',
    });
    const simple = buildSimpleReportContent({
      investigation,
      evidence: [evidence],
      findings: [],
      reportId: 'REPORT-SIGNED',
      analysisDate: '2026-10-15T11:00:00.000Z',
    });
    const reportHash = 'c'.repeat(64);
    const authentication: ReportAuthenticationDisplay = {
      record: {
        version: 'VEXA-REPORT-1',
        reportNumber: 'REPORT-SIGNED',
        caseNumber: 'CASE-1',
        reportHash,
        examinerName: 'Analyst',
        examinerBadge: 'A-123',
        agency: 'Test Lab',
        issuedAt: '2026-10-15T11:00:00.000Z',
        keyId: 'VEXA-HMAC-LOCAL',
        signature: 'd'.repeat(64),
      },
      verificationUrl: 'https://example.test/api/reports/verify?record=signed',
      qrDataUrl: await QRCode.toDataURL('https://example.test/verify'),
      signatureImageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    };

    const simplePdf = (await createSimpleReportPDF(simple, authentication)).output('arraybuffer');
    const unsignedSimplePdf = (await createSimpleReportPDF(simple)).output('arraybuffer');
    const detailedPdf = (await createForensicReportPDF(report, undefined, authentication)).output('arraybuffer');
    const unsignedDetailedPdf = (await createForensicReportPDF(report)).output('arraybuffer');

    expect(simplePdf.byteLength).toBeGreaterThan(unsignedSimplePdf.byteLength);
    expect(detailedPdf.byteLength).toBeGreaterThan(unsignedDetailedPdf.byteLength);
  });
});

describe('simple report conclusions and domain separation', () => {
  it('reports likely_manipulated only for a model-scored synthetic indicator', () => {
    const report = buildSimpleReportContent({
      investigation,
      evidence: [evidence],
      findings: [
        {
          id: 'finding-1',
          investigationId: 'case-1',
          evidenceId: 'evidence-1',
          title: 'Synthetic texture indicator',
          severity: 'critical',
          category: 'synthetic_deepfake',
          observedEvidence: 'Model output flagged synthetic texture.',
          detectionMethod: 'Configured synthetic-content detector',
          detectorVersion: 'test-1',
          rawDetectorScore: 0.93,
          scoreInterpretation: 'Model score; not a calibrated probability.',
          createdAt: '2026-10-15T11:00:00.000Z',
        },
      ],
      reportId: 'REPORT-MANIP',
      analysisDate: '2026-10-15T11:00:00.000Z',
    });

    expect(report.conclusion).toBe('likely_manipulated');
    expect(report.conclusionLabel).toBe('Model-indicated synthetic content (review required)');
    expect(report.domainConclusions.find((d) => d.domain === 'ai_content')?.state).toBe('likely_manipulated');
  });

  it('does not treat an ELA-only or metadata finding as manipulation', () => {
    const report = buildSimpleReportContent({
      investigation,
      evidence: [evidence],
      findings: [
        {
          id: 'finding-2',
          investigationId: 'case-1',
          evidenceId: 'evidence-1',
          title: 'ELA residual variance',
          severity: 'high',
          category: 'compression',
          observedEvidence: 'ELA variance measured 42.1.',
          detectionMethod: 'Canvas JPEG recompression ELA diagnostic',
          detectorVersion: 'ELA-1',
          createdAt: '2026-10-15T11:00:00.000Z',
        },
      ],
      reportId: 'REPORT-ELA',
      analysisDate: '2026-10-15T11:00:00.000Z',
    });

    expect(report.conclusion).toBe('inconclusive');
    expect(report.domainConclusions.find((d) => d.domain === 'ai_content')?.state).toBe('unable_to_analyze');
    expect(report.domainConclusions.find((d) => d.domain === 'manipulation')?.state).toBe('unable_to_analyze');
  });

  it('records Puter visual review separately without treating it as a validated AI detector result', () => {
    const report = buildSimpleReportContent({
      investigation,
      evidence: [evidence],
      findings: [
        {
          id: 'puter-visual-review',
          investigationId: 'case-1',
          evidenceId: 'evidence-1',
          title: 'AI Image Detection: Possible AI-Generated',
          severity: 'inconclusive',
          category: 'synthetic_deepfake',
          observedEvidence: 'Puter returned a visual category and image-specific observations.',
          simpleExplanation: 'Experimental visual assessment only.',
          detectionMethod: 'AI Image Detection (Puter.js visual model)',
          detectorVersion: 'google/gemini-3-flash-preview',
          createdAt: '2026-10-15T11:00:00.000Z',
        },
      ],
      reportId: 'REPORT-PUTER-VISUAL',
      analysisDate: '2026-10-15T11:00:00.000Z',
    });

    expect(report.domainConclusions.find((domain) => domain.domain === 'ai_content')).toMatchObject({
      state: 'checked',
      note: expect.stringContaining('experimental'),
    });
    expect(report.conclusion).toBe('inconclusive');
  });

  it('exposes a definition for every glossary term in both languages', () => {
    for (const language of ['en', 'hi'] as const) {
      const report = buildSimpleReportContent({
        investigation,
        evidence: [evidence],
        findings: [],
        reportId: `REPORT-${language}`,
        analysisDate: '2026-10-15T11:00:00.000Z',
        language,
      });
      expect(report.glossary.length).toBeGreaterThan(0);
      expect(report.glossary.every((entry) => entry.term && entry.plain)).toBe(true);
      expect(report.domainConclusions).toHaveLength(6);
    }
  });
});