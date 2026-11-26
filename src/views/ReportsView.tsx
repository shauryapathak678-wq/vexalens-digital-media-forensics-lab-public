import { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import {
  Investigation,
  EvidenceItem,
  AnalysisFinding,
  EvidenceCertificate,
  UserProfile,
  ProvenanceEvent,
} from '@/types/forensics';
import {
  buildForensicReport,
  buildPrintableReportHtml,
  buildSimpleReportContent,
  formatTimelineDate,
  ReportLanguage,
} from '@/lib/forensics/reportBuilder';
import { exportForensicReportPDF, exportSimpleReportPDF } from '@/lib/forensics/pdfExport';
import {
  Download,
  Printer,
  ShieldCheck,
  CheckCircle2,
  KeyRound,
  BookOpen,
  Lock,
  AlertTriangle,
  Award,
} from 'lucide-react';
import { SeverityBadge } from '@/components/common/SeverityBadge';
import { calculateSHA256 } from '@/lib/forensics/crypto';
import {
  getReportVerificationUrl,
  signReport,
} from '@/lib/forensics/reportAuthentication';
import type {
  ReportAuthenticationDisplay,
  ReportAuthenticationRecord,
} from '@/lib/forensics/reportAuthentication';
import { saveReportToHistory } from '@/views/HistoryRoomView';

interface ReportsViewProps {
  currentCase?: Investigation;
  investigations: Investigation[];
  evidenceList: EvidenceItem[];
  findings: AnalysisFinding[];
  provenanceEvents?: ProvenanceEvent[];
  certificates?: EvidenceCertificate[];
  user: UserProfile;
  onSelectCase: (c: Investigation) => void;
  onOpenEvidence: (item: EvidenceItem) => void;
  onNavigateTab?: (tab: string) => void;
}

function createReportNumber(caseNumber: string): string {
  const normalizedCaseNumber = caseNumber.replace(/[^a-zA-Z0-9-]/g, '-');
  return `REP-VL-${new Date().getFullYear()}-${normalizedCaseNumber}-${Date.now()}`;
}

const OfficialLabStamp: React.FC<{ authenticated?: boolean }> = ({ authenticated = false }) => (
  <div
    className={`relative inline-flex flex-col items-center justify-center p-2 rounded-full border-2 border-dashed ${
      authenticated
        ? 'border-emerald-600 text-emerald-800 bg-emerald-50/50'
        : 'border-cyan-700 text-cyan-900 bg-cyan-50/50'
    } w-28 h-28 select-none rotate-[-4deg] shadow-sm`}
  >
    <div className="text-[8px] font-black tracking-wider uppercase">★ VEXALENS LAB ★</div>
    <div className="text-[10px] font-extrabold uppercase tracking-tight my-0.5 border-y border-current py-0.5 px-2 text-center">
      {authenticated ? 'REPORT SIGNED' : 'PREVIEW ONLY'}
    </div>
    <div className="text-[6.5px] font-mono tracking-tighter">REPORT RECORD</div>
    <div className="text-[6px] tracking-tight text-center font-bold">{authenticated ? 'SIGNATURE RECORDED' : 'NOT VERIFIED'}</div>
  </div>
);

const ExecutiveSummaryCard: React.FC<{
  conclusion: 'likely_authentic' | 'likely_manipulated' | 'inconclusive' | 'unable_to_analyze';
  conclusionLabel?: string;
  confidenceLabel: string;
  timeline: { caseRegistered: string; evidenceReceived: string; reportGenerated: string };
  whatThisMeans: string;
}> = ({ conclusion, conclusionLabel, confidenceLabel, timeline, whatThisMeans }) => {
  return (
    <section className="rounded-xl border border-slate-300 bg-slate-50 p-5 text-slate-900 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Executive assessment</p>
          <h2 className="mt-1 text-base font-bold text-slate-900">{conclusionLabel}</h2>
        </div>
        <span className="rounded-full border border-slate-300 bg-white px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
          {conclusion.replace(/_/g, ' ')}
        </span>
      </div>
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-medium text-slate-700">
          <div>
            <span className="font-semibold text-slate-900">Detector confidence: </span>
            <span className="font-mono text-slate-800">{confidenceLabel}</span>
          </div>
        </div>
        <div className="text-xs font-medium text-slate-600 bg-white/70 p-2.5 rounded-lg border border-slate-200">
          <span className="font-bold text-slate-900">Timeline: </span>
          <span>
            Case Registered: <b className="text-slate-800">{formatTimelineDate(timeline.caseRegistered)}</b> | Evidence Received: <b className="text-slate-800">{formatTimelineDate(timeline.evidenceReceived)}</b> | Report: <b className="text-slate-800">{formatTimelineDate(timeline.reportGenerated)}</b>
          </span>
        </div>
        <p className="text-xs sm:text-sm leading-relaxed text-slate-700 pt-1">
          {whatThisMeans}
        </p>
      </div>
    </section>
  );
};

export const ReportsView: React.FC<ReportsViewProps> = ({
  currentCase,
  investigations,
  evidenceList,
  findings,
  provenanceEvents = [],
  certificates = [],
  user,
  onSelectCase,
  onOpenEvidence,
  onNavigateTab,
}) => {
  const activeCase = currentCase || investigations[0];
  const caseEvidence = evidenceList.filter((e) => e.investigationId === activeCase?.id);
  const caseFindings = findings.filter((f) => f.investigationId === activeCase?.id);
  const caseEvidenceIds = new Set(caseEvidence.map((item) => item.id));
  const caseCertificates = certificates.filter((certificate) => caseEvidenceIds.has(certificate.evidenceId));
  const findingEvidenceType = (finding: AnalysisFinding) =>
    caseEvidence.find((item) => item.id === finding.evidenceId)?.mediaType;
  const isPuterImageAssessment = (finding: AnalysisFinding) =>
    finding.detectionMethod === 'AI Image Detection (Puter.js visual model)';
  const findingsForMedia = (mediaType: string) => caseFindings.filter((finding) => {
    if (mediaType === 'image' && isPuterImageAssessment(finding)) return false;
    const actualType = findingEvidenceType(finding);
    return mediaType === 'other'
      ? !['image', 'video', 'audio', 'document'].includes(actualType || '')
      : actualType === mediaType;
  });
  const observationSections = [
    { title: 'Photo observations', findings: findingsForMedia('image') },
    { title: 'Video observations', findings: findingsForMedia('video') },
    { title: 'Audio observations', findings: findingsForMedia('audio') },
    { title: 'Document and screenshot observations', findings: findingsForMedia('document') },
    { title: 'Other evidence observations', findings: findingsForMedia('other') },
    { title: 'AI image detection assessments (experimental visual opinions)', findings: caseFindings.filter(isPuterImageAssessment) },
    { title: 'Deepfake findings', findings: caseFindings.filter((finding) => finding.category === 'synthetic_deepfake' && !isPuterImageAssessment(finding)) },
  ];
  const [reportMode, setReportMode] = useState<'simple' | 'detailed'>('simple');
  const [language, setLanguage] = useState<ReportLanguage>('en');
  const [includeExaminerDetails, setIncludeExaminerDetails] = useState(true);
  const [reportCreatedAt, setReportCreatedAt] = useState(() => new Date().toISOString());
  const [reportNumber, setReportNumber] = useState<string>(() =>
    activeCase ? createReportNumber(activeCase.caseNumber) : 'REP-VL-PENDING'
  );
  const [exportError, setExportError] = useState('');
  const [exportSuccess, setExportSuccess] = useState('');
  const [isSigningReport, setIsSigningReport] = useState(false);
  const [isReportAuthenticated, setIsReportAuthenticated] = useState(false);
  const [signedReport, setSignedReport] = useState<{
    record: ReportAuthenticationRecord;
    manifest: string;
    qrDataUrl: string;
    verificationUrl: string;
  } | null>(null);

  if (!activeCase) {
    return (
      <div className="p-8 text-center text-slate-400 text-sm">
        No investigation selected for report compilation.
      </div>
    );
  }

  const reportUser = includeExaminerDetails
    ? {
        ...user,
        fullName: user.fullName.trim(),
        badgeNumber: user.badgeNumber.trim(),
        agency: user.agency.trim(),
      }
    : { ...user, fullName: '', badgeNumber: '', agency: '' };

  const caseProvenance = provenanceEvents.filter((event) => caseEvidence.some((item) => item.id === event.evidenceId));
  const reportData = buildForensicReport({
    investigation: activeCase,
    evidence: caseEvidence,
    findings: caseFindings,
    user: reportUser,
    reportId: reportNumber,
    createdAt: reportCreatedAt,
    certificates: caseCertificates,
    provenance: caseProvenance,
  });

  const analysisDate = caseFindings[0]?.createdAt || 'Not available';

  const simpleReport = buildSimpleReportContent({
    investigation: activeCase,
    evidence: caseEvidence,
    findings: caseFindings,
    provenance: caseProvenance,
    reportId: reportNumber,
    analysisDate,
    reportGeneratedAt: reportCreatedAt,
    language,
    examinerName: reportUser.fullName.trim() || undefined,
    examinerAgency: reportUser.agency.trim() || undefined,
    certificates: caseCertificates,
  });

  const reportManifest = JSON.stringify({
    mode: reportMode,
    language,
    report: reportData,
    simpleReport,
  });

  useEffect(() => {
    if (signedReport && signedReport.manifest !== reportManifest) {
      setSignedReport(null);
      setIsReportAuthenticated(false);
    }
  }, [reportManifest, signedReport]);

  const activeAuthentication: ReportAuthenticationDisplay = {
    record: signedReport?.record || {
      version: 'VEXA-REPORT-1',
      reportNumber,
      caseNumber: activeCase.caseNumber,
      reportHash: 'Pending authentication',
      examinerName: reportUser.fullName.trim() || 'Not available',
      examinerBadge: reportUser.badgeNumber.trim(),
      agency: reportUser.agency.trim(),
      issuedAt: reportCreatedAt,
      keyId: 'UNSIGNED-PREVIEW',
      signature: 'Pending authentication',
    },
    qrDataUrl: signedReport?.qrDataUrl || '',
    verificationUrl: signedReport?.verificationUrl || '',
  };
  const signedAuthentication = signedReport?.manifest === reportManifest
    ? activeAuthentication
    : undefined;

  const startNewReport = (investigation: Investigation) => {
    onSelectCase(investigation);
    setReportNumber(createReportNumber(investigation.caseNumber));
    setReportCreatedAt(new Date().toISOString());
    setExportError('');
    setExportSuccess('');
    setSignedReport(null);
    setIsReportAuthenticated(false);
  };

  const handleSignReport = async () => {
    setExportError('');
    setIsSigningReport(true);
    try {
      const reportHash = await calculateSHA256(new TextEncoder().encode(reportManifest));
      const record = await signReport({
        reportNumber: reportData.reportNumber,
        caseNumber: reportData.caseNumber,
        reportHash,
        examinerName: reportUser.fullName.trim() || 'Not available',
        examinerBadge: reportUser.badgeNumber.trim(),
        agency: reportUser.agency.trim(),
      });
      const verificationUrl = getReportVerificationUrl(record);
      const qrData = await QRCode.toDataURL(verificationUrl, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 240,
        color: { dark: '#0f172a', light: '#ffffff' },
      });
      setSignedReport({ record, manifest: reportManifest, qrDataUrl: qrData, verificationUrl });
      setIsReportAuthenticated(true);
      // Auto-save authenticated report to local history archive
      saveReportToHistory({
        id: reportNumber,
        reportNumber,
        title: reportData.title,
        caseNumber: activeCase.caseNumber,
        caseId: activeCase.id,
        historicalCaseId: activeCase.id,
        historicalCaseNumber: activeCase.caseNumber,
        generatedAt: reportCreatedAt,
        summary: simpleReport.caseSummary,
        conclusion: simpleReport.conclusion,
        findingCount: caseFindings.length,
        evidenceCount: caseEvidence.length,
        reportSnapshot: reportData,
      });
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Report signing failed.');
    } finally {
      setIsSigningReport(false);
    }
  };

  const handleExportPDF = async () => {
    if (!activeCase || !isReportAuthenticated || !signedAuthentication) return;
    setExportError('');
    setExportSuccess('');

    // Ensure saved to history upon PDF generation
    saveReportToHistory({
      id: reportNumber,
      reportNumber,
      title: reportData.title,
      caseNumber: activeCase.caseNumber,
      caseId: activeCase.id,
      historicalCaseId: activeCase.id,
      historicalCaseNumber: activeCase.caseNumber,
      generatedAt: reportCreatedAt,
      summary: simpleReport.caseSummary,
      conclusion: simpleReport.conclusion,
      findingCount: caseFindings.length,
      evidenceCount: caseEvidence.length,
      reportSnapshot: reportData,
    });

    try {
      if (language === 'hi') {
        const printableHtml = buildPrintableReportHtml({
          mode: reportMode,
          language,
          simpleReport,
          report: reportData,
          authentication: signedAuthentication,
          provenance: caseProvenance,
        });
        const printWindow = window.open('', '_blank');
        if (!printWindow) {
          setExportError('The print window was blocked. Allow pop-ups for this local app and try again.');
          return;
        }
        printWindow.opener = null;
        printWindow.document.open();
        printWindow.document.write(printableHtml);
        printWindow.document.close();
        setExportSuccess('Printable forensic report opened. Choose “Save as PDF” in the print dialog to download it.');
        return;
      }

      if (reportMode === 'simple') await exportSimpleReportPDF(simpleReport, signedAuthentication);
      else await exportForensicReportPDF(
        reportData,
        {
          simpleContent: simpleReport,
          provenanceLogs: caseProvenance.map((event) => ({
            action: event.actionType,
            actor: event.actor,
            timestamp: event.timestamp,
            hash: event.recordedSha256,
            notes: event.notes,
          })),
        },
        signedAuthentication
      );
      setExportSuccess('Forensic report PDF generated and downloaded.');
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Report export failed.');
    }
  };

  const handlePrint = () => {
    if (!isReportAuthenticated) return;
    window.print();
  };

  // Prepare deduplicated visual evidence for side-by-side presentation
  const uniqueVisualEvidence = Array.from(
    new Map(
      simpleReport.evidenceGallery
        .filter((e) => e.imageUrl || e.videoUrl)
        .map((e) => [`${e.mediaType}:${e.sha256 || e.videoUrl || e.imageUrl || e.evidenceId}`, e])
    ).values()
  );

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      {/* Header Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <div className="text-xs font-mono text-cyan-400 font-semibold tracking-wider">
            VEXALENS FORENSIC DOSSIER EXPORT
          </div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100 mt-0.5">
            Report Preview & Digital Signature
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Report detail" className="inline-flex border border-slate-700 rounded-lg overflow-hidden">
            <button
              type="button"
              aria-pressed={reportMode === 'simple'}
              onClick={() => setReportMode('simple')}
              className={`px-3 py-1.5 text-xs transition-colors ${
                reportMode === 'simple' ? 'bg-cyan-400 text-slate-950 font-bold' : 'bg-slate-900 text-slate-300 hover:text-white'
              }`}
            >
              Simple
            </button>
            <button
              type="button"
              aria-pressed={reportMode === 'detailed'}
              onClick={() => setReportMode('detailed')}
              className={`px-3 py-1.5 text-xs transition-colors ${
                reportMode === 'detailed' ? 'bg-cyan-400 text-slate-950 font-bold' : 'bg-slate-900 text-slate-300 hover:text-white'
              }`}
            >
              Detailed
            </button>
          </div>

          <label className="sr-only" htmlFor="report-language">Report language</label>
          <select
            id="report-language"
            value={language}
            onChange={(event) => setLanguage(event.target.value as ReportLanguage)}
            className="bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
          >
            <option value="en">English</option>
            <option value="hi">हिन्दी</option>
          </select>

          <select
            value={activeCase.id}
            onChange={(e) => {
              const target = investigations.find((i) => i.id === e.target.value);
              if (target) startNewReport(target);
            }}
            className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
          >
            {investigations.map((inv) => (
              <option key={inv.id} value={inv.id}>
                {inv.caseNumber}
              </option>
            ))}
          </select>

          <button
            onClick={handlePrint}
            disabled={!isReportAuthenticated}
            title={!isReportAuthenticated ? 'Authenticate this report before printing.' : undefined}
            className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Printer className="w-3.5 h-3.5 text-slate-400" />
            <span>Print View</span>
          </button>

          {/* Download button disabled until authenticated */}
          <button
            onClick={handleExportPDF}
            disabled={!isReportAuthenticated}
            title={!isReportAuthenticated ? 'Click "Authenticate & Sign Report" below to unlock download.' : undefined}
            className={`flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-bold shadow-sm transition-all ${
              isReportAuthenticated
                ? 'bg-cyan-400 text-slate-950 hover:bg-cyan-300 cursor-pointer shadow-cyan-950'
                : 'bg-slate-800 text-slate-400 cursor-not-allowed border border-slate-700'
            }`}
          >
            {!isReportAuthenticated ? <Lock className="w-3.5 h-3.5 text-amber-400" /> : <Download className="w-3.5 h-3.5" />}
            <span>{isReportAuthenticated ? 'Download Forensic Report (PDF)' : 'Authenticate to enable download'}</span>
          </button>

          {onNavigateTab && (
            <button
              type="button"
              onClick={() => onNavigateTab('history_room')}
              className="flex items-center gap-1.5 rounded-lg bg-slate-800 border border-slate-700 hover:border-cyan-500/50 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-750"
              title="Open Forensic Report History Archive"
            >
              <BookOpen className="w-3.5 h-3.5 text-cyan-400" />
              <span>Archive</span>
            </button>
          )}
          {exportSuccess && (
            <div role="status" className="border border-emerald-800 bg-emerald-950/30 px-3.5 py-2.5 rounded-lg text-xs text-emerald-200">
              {exportSuccess}
            </div>
          )}
        </div>
      </div>

      {/* Authentication Action Banner */}
      <div className="flex flex-col gap-3 rounded-xl border border-cyan-900/70 bg-slate-900/80 p-4 sm:flex-row sm:items-center sm:justify-between shadow-sm">
        <div className="flex items-start gap-3 text-sm text-slate-200">
          {isReportAuthenticated ? (
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
          ) : (
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300" />
          )}
          <div>
            <span className="block font-semibold">
              {isReportAuthenticated
                ? 'Report cryptographically signed'
                : 'Report preview is active'}
            </span>
            <span className="mt-0.5 block text-xs text-slate-400">
              {isReportAuthenticated
                ? 'The official HMAC signature has been cryptographically attached. PDF download is now unlocked.'
                  : 'Review the report below. Authenticate and sign it to add the cryptographic signature record, verification QR code, and report seal before enabling download.'}
            </span>
            <span className="mt-1 block font-mono text-[11px] text-cyan-300">
              Report ID: <span className="font-bold">{reportNumber}</span>
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={handleSignReport}
          disabled={isSigningReport || isReportAuthenticated}
          className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-xs sm:text-sm font-semibold transition-all ${
            isReportAuthenticated
              ? 'bg-emerald-950 text-emerald-300 border border-emerald-700 cursor-default'
              : 'bg-cyan-400 text-slate-950 hover:bg-cyan-300 cursor-pointer shadow-md shadow-cyan-950/40'
          }`}
        >
          {isReportAuthenticated ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <Award className="h-4 w-4" />}
          {isSigningReport ? 'Authenticating report…' : isReportAuthenticated ? 'Authenticated & Signed' : 'Authenticate & Sign Report'}
        </button>
      </div>

      {exportError && (
        <div role="alert" className="border border-rose-800 bg-rose-950/30 px-3.5 py-2.5 rounded-lg text-xs text-rose-200 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
          <span>{exportError}</span>
        </div>
      )}

      {/* Report View Sheet */}
      {reportMode === 'simple' ? (
        <article className="report-sheet report-sheet--premium space-y-6 rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl sm:p-10">
          {/* Header Banner with Lab Logo & Stamp */}
          <header className="border-b border-slate-200 pb-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-600 to-blue-800 flex items-center justify-center text-white font-black text-lg shadow-md">
                  VL
                </div>
                <div>
                  <div className="text-xs font-bold tracking-[0.18em] text-cyan-800 uppercase">
                    VEXALENS DIGITAL FORENSICS LABORATORY
                  </div>
                  <div className="text-xl sm:text-2xl font-bold tracking-tight text-slate-950">
                    Forensic Examination Screening Dossier
                  </div>
                </div>
              </div>

              <div className="hidden sm:block">
                <OfficialLabStamp authenticated={isReportAuthenticated} />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 text-xs text-slate-500 border-t border-slate-100">
              <div>
                Report ID: <span className="font-mono font-bold text-slate-800">{simpleReport.reportId}</span>
                <span className="mx-2 text-slate-300">·</span>
                Case: <span className="font-mono text-slate-800">{simpleReport.caseNumber}</span>
              </div>
              <div>
                Analysis Date: {simpleReport.analysisDate} <span className="mx-2 text-slate-300">·</span> Generated: {formatTimelineDate(reportCreatedAt)}
              </div>
            </div>
          </header>

          {/* Bold First Page Notice */}
          <section className="rounded-xl border border-rose-300 bg-rose-50/80 px-4 py-3 text-sm font-bold leading-6 text-rose-950 flex items-center gap-2.5">
            <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0" />
            <span>This is an automated screening, not a final forensic certificate. Requires expert verification.</span>
          </section>

          {/* Traffic Light System Card */}
          <ExecutiveSummaryCard
            conclusion={simpleReport.conclusion}
            conclusionLabel={simpleReport.conclusionLabel}
            confidenceLabel={simpleReport.confidenceLabel}
            timeline={simpleReport.timeline}
            whatThisMeans={simpleReport.whatThisMeans}
          />

          {/* Metrics summary */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'Evidence files', value: simpleReport.evidenceGallery.length },
              { label: 'Checks recorded', value: simpleReport.checked.length },
              { label: 'Key findings', value: simpleReport.findings.length },
            ].map((item) => (
              <div key={item.label} className="rounded-xl border border-slate-200 bg-slate-50 p-3 sm:p-4">
                <div className="text-xl font-bold tabular-nums text-slate-950">{item.value}</div>
                <div className="mt-1 text-[10px] font-medium uppercase tracking-wider text-slate-500 sm:text-xs">
                  {item.label}
                </div>
              </div>
            ))}
          </div>

          {/* Section 01: What was checked */}
          <section className="space-y-2">
            <h3 className="text-sm font-bold tracking-wide text-slate-900 uppercase font-mono">01 · What was checked</h3>
            {simpleReport.checked.length ? (
              <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-slate-700">
                {simpleReport.checked.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">No file-level checks are recorded.</p>
            )}
          </section>

          {/* Section 02: Evidence files (Side-by-Side: Dono images ko sath me rakho up niche nhi) */}
          {uniqueVisualEvidence.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold tracking-wide text-slate-900 uppercase font-mono">
                  02 · Evidence Files (Side-by-Side Comparative View)
                </h3>
                <span className="text-[11px] font-mono text-cyan-800 bg-cyan-50 px-2 py-0.5 rounded border border-cyan-200">
                  Side-by-Side
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {uniqueVisualEvidence.map((entry, idx) => (
                  <figure
                    key={entry.evidenceId}
                    className="border border-slate-200 rounded-xl overflow-hidden bg-slate-50 flex flex-col shadow-sm"
                  >
                    <div className="px-3 py-1.5 bg-slate-900 text-slate-100 text-[11px] font-semibold flex items-center justify-between">
                      <span className="text-cyan-300 font-mono">
                        {idx === 0 && uniqueVisualEvidence.length > 1 ? '[Baseline Reference]' : '[Suspect Evidence]'}
                      </span>
                      <span className="truncate max-w-[140px] text-slate-300 text-[10px]">{entry.fileName}</span>
                    </div>

                    {entry.mediaType === 'video' && entry.videoUrl ? (
                      <video
                        src={entry.videoUrl}
                        poster={entry.imageUrl}
                        controls
                        playsInline
                        preload="metadata"
                        aria-label={`${entry.fileName} video evidence`}
                        className="w-full h-44 object-contain bg-slate-950 p-1"
                      />
                    ) : entry.imageUrl ? (
                      <img
                        src={entry.imageUrl}
                        alt={`${entry.fileName} evidence`}
                        className="w-full h-44 object-contain bg-slate-950 p-1"
                      />
                    ) : (
                      <div className="w-full h-44 flex items-center justify-center text-xs text-slate-500 bg-slate-950">
                        {entry.mediaType} file
                      </div>
                    )}

                    <figcaption className="p-3 text-xs text-slate-600 space-y-1 bg-white border-t border-slate-200 flex-1">
                      <div className="font-bold text-slate-900 truncate">{entry.fileName}</div>
                      <div className="font-mono text-[10px] text-slate-500 truncate">
                        ID: {entry.evidenceId} · {entry.sha256 ? entry.sha256.slice(0, 20) + '…' : 'SHA-256 not available'}
                      </div>
                      <div className="text-[11px] text-slate-600 line-clamp-2">{entry.caption}</div>
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
          )}

          {/* Section 03: Findings by question */}
          <section className="space-y-2">
            <h3 className="text-sm font-bold tracking-wide text-slate-900 uppercase font-mono">03 · Findings by Question</h3>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-100 text-slate-700 border-b border-slate-200 font-semibold">
                    <th className="py-2 px-3">Question</th>
                    <th className="py-2 px-3">Result</th>
                    <th className="py-2 px-3">Observation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-slate-700">
                  {simpleReport.domainConclusions.map((domain) => (
                    <tr key={domain.domain} className="hover:bg-slate-50">
                      <td className="py-2 px-3 align-top font-medium text-slate-900">{domain.label}</td>
                      <td className="py-2 px-3 align-top font-mono text-[11px] font-bold text-slate-800">
                        {domain.state.replace(/_/g, ' ')}
                      </td>
                      <td className="py-2 px-3 align-top text-slate-600">{domain.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="space-y-4">
            {observationSections.map((section, index) => (
              <section key={section.title} className="space-y-2">
                <h3 className="text-sm font-bold tracking-wide text-slate-900 uppercase font-mono">
                  04.{index + 1} · {section.title}
                </h3>
                {section.findings.length ? (
                  <div className="space-y-2">
                    {section.findings.map((finding) => (
                      <div key={`${section.title}-${finding.id}`} className="border border-slate-200 rounded-lg p-3 bg-slate-50">
                        <button
                          type="button"
                          onClick={() => {
                            const item = caseEvidence.find((candidate) => candidate.id === finding.evidenceId);
                            if (item) onOpenEvidence(item);
                          }}
                          className="text-left text-xs font-bold text-cyan-800 hover:underline"
                        >
                          {caseEvidence.find((item) => item.id === finding.evidenceId)?.fileName || 'Evidence'} · Evidence ID {finding.evidenceId}
                        </button>
                        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500 mt-2">Recorded observation</p>
                        <p className="text-xs font-bold text-slate-900 mt-1">{finding.observedEvidence}</p>
                        {(finding.simpleExplanation || finding.plainEnglishSummary) && (
                          <>
                            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500 mt-2">Explanation</p>
                            <p className="text-xs text-slate-700 mt-1">{finding.simpleExplanation || finding.plainEnglishSummary}</p>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                ) : <p className="text-sm text-slate-500">No {section.title.toLowerCase()} have been recorded.</p>}
              </section>
            ))}
          </div>

          <section className="space-y-2">
            <h3 className="text-sm font-bold tracking-wide text-slate-900 uppercase font-mono">05 · Certificates</h3>
            {caseCertificates.length ? caseCertificates.map((certificate) => (
              <div key={certificate.certificateId} className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                <b>{certificate.certificateId}</b> · {certificate.fileName} · Status: {certificate.status}
                <p className="mt-1 text-xs">A certificate records file details. It does not prove who created the file or that its contents are true.</p>
              </div>
            )) : <p className="text-sm text-slate-500">No certificates are recorded for this case.</p>}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-bold tracking-wide text-slate-900 uppercase font-mono">06 · Chain of custody</h3>
            {caseProvenance.length ? (
              <ol className="space-y-2">
                {caseProvenance.map((event) => (
                  <li key={event.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                    <b>{event.actionType.replace(/_/g, ' ')}</b> · {formatTimelineDate(event.timestamp)} · {event.actor || 'Actor not recorded'}
                    <p className="mt-1">{event.notes || 'No notes recorded.'}</p>
                    <p className="mt-1 font-mono text-[10px]">SHA-256: {event.recordedSha256 || 'Not available'}</p>
                  </li>
                ))}
              </ol>
            ) : <p className="text-sm text-slate-500">No chain-of-custody events are recorded for this case.</p>}
          </section>

          {/* Section 05: Next steps */}
          <section className="space-y-2">
            <h3 className="text-sm font-bold tracking-wide text-slate-900 uppercase font-mono">05 · Recommended Next Steps</h3>
            <ol className="list-decimal pl-5 text-xs text-slate-700 space-y-1">
              {simpleReport.nextSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </section>

          {/* Technical terms */}
          <details className="border-t border-slate-200 pt-3 text-xs text-slate-600">
            <summary className="cursor-pointer font-semibold text-slate-900 flex items-center gap-1.5">
              <BookOpen className="w-3.5 h-3.5 text-cyan-700" /> Technical terms explained
            </summary>
            <div className="mt-2 space-y-1.5 pl-4">
              {simpleReport.glossary.map((entry) => (
                <p key={entry.term}>
                  <b>{entry.term}:</b> {entry.plain}
                </p>
              ))}
            </div>
          </details>

          {/* Limitations */}
          <section className="text-xs text-slate-500 border-t border-slate-200 pt-3">
            <span className="font-semibold text-slate-700">Limitations and scope: </span>
            {simpleReport.limitations}
          </section>

          {/* Examiner Signature & QR Verification Section (Displayed by Default) */}
          <section className="grid gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-[1fr_auto] sm:items-center sm:p-5">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
                <KeyRound className="h-4 w-4 text-cyan-800" /> Examiner Signature & Authenticity Verification
              </h3>

              <div className="my-3">
                {isReportAuthenticated ? (
                  <div className="flex h-14 max-w-56 items-center border-b border-slate-300 font-serif italic text-lg text-cyan-900">
                    Electronically signed
                  </div>
                ) : (
                  <div className="flex h-14 max-w-56 items-center border-b border-dashed border-slate-300 text-xs text-slate-500">
                    Digital signature pending
                  </div>
                )}
                <div className="w-56 border-b border-slate-300 mt-1" />
              </div>

              <p className="text-sm font-semibold text-slate-900">
                {isReportAuthenticated ? 'Signed by' : 'Signature pending'}: {activeAuthentication.record.examinerName || 'Not available'}
                {activeAuthentication.record.agency ? ` · ${activeAuthentication.record.agency}` : ''}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                Examiner badge: {activeAuthentication.record.examinerBadge || 'Not available'}
              </p>
              <p className="mt-1 break-all font-mono text-[10px] leading-5 text-slate-600">
                Report SHA-256: {isReportAuthenticated ? activeAuthentication.record.reportHash : 'Pending authentication'}
              </p>

              <div className="mt-2 flex items-center gap-3">
                {isReportAuthenticated && (
                  <a
                    href={activeAuthentication.verificationUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block text-xs font-semibold text-cyan-800 underline hover:text-cyan-950"
                  >
                    Open online verification
                  </a>
                )}
                <span className="text-[11px] font-mono text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                  Report ID: {reportNumber}
                </span>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-center gap-4">
              <OfficialLabStamp authenticated={isReportAuthenticated} />
              {isReportAuthenticated && activeAuthentication.qrDataUrl && (
                <div className="text-center">
                  <img
                    src={activeAuthentication.qrDataUrl}
                    alt={`QR code to verify report ${reportNumber}`}
                    className="h-28 w-28 rounded border border-slate-300 bg-white p-1 shadow-sm"
                  />
                  <span className="block mt-1 font-mono text-[9px] text-slate-500">Scan to Verify</span>
                </div>
              )}
            </div>
          </section>

          {/* Page Footer Disclaimer */}
          <footer className="border-t border-slate-200 pt-4 text-xs leading-5 text-slate-500 flex flex-wrap items-center justify-between gap-2">
            <span>Educational summary · automated checks do not establish legal authenticity</span>
            <span className="font-mono text-[11px]">Evidence IDs: {simpleReport.evidenceIds.join(', ') || 'None'}</span>
          </footer>
        </article>
      ) : (
        /* Detailed Report Mode */
        <div className="report-sheet report-sheet--premium space-y-8 rounded-2xl border border-slate-200 bg-white p-6 font-sans text-slate-900 shadow-2xl sm:p-10">
          {/* Header Band with Logo and Stamp */}
          <div className="border-b border-slate-200 pb-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-600 to-blue-800 flex items-center justify-center text-white font-black text-lg shadow-md">
                  VL
                </div>
                <div>
                  <div className="text-xs font-bold tracking-[0.18em] text-cyan-800 uppercase">
                    VEXALENS DIGITAL FORENSICS LABORATORY
                  </div>
                  <div className="text-xl sm:text-2xl font-bold tracking-tight text-slate-950">
                    DIGITAL MEDIA FORENSICS EXAMINATION REPORT
                  </div>
                </div>
              </div>

              <OfficialLabStamp authenticated={isReportAuthenticated} />
            </div>

            <div className="flex items-center justify-between text-xs font-mono text-slate-500 border-t border-slate-100 pt-2">
              <div>
                REPORT ID: <span className="text-cyan-800 font-bold">{reportData.reportNumber}</span> · CASE: {reportData.title}
              </div>
              <div>DATE: {formatTimelineDate(reportCreatedAt)}</div>
            </div>
          </div>

          {/* Bold First Page Notice */}
          <div className="rounded-xl border border-rose-300 bg-rose-50/80 px-4 py-3 text-sm font-bold leading-6 text-rose-950 flex items-center gap-2.5">
            <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0" />
            <span>This is an automated screening, not a final forensic certificate. Requires expert verification.</span>
          </div>

          {/* Traffic Light System Card */}
          <ExecutiveSummaryCard
            conclusion={simpleReport.conclusion}
            conclusionLabel={simpleReport.conclusionLabel}
            confidenceLabel={simpleReport.confidenceLabel}
            timeline={simpleReport.timeline}
            whatThisMeans={simpleReport.whatThisMeans}
          />

          {/* Case Metadata Dossier Grid */}
          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div className="space-y-1.5">
              <div className="text-slate-500">
                Lead Forensic Examiner:{' '}
                <span className="text-slate-900 font-medium">
                  {reportData.leadInvestigator || 'Not available'}
                  {reportData.badgeNumber ? ` (Badge #${reportData.badgeNumber})` : ''}
                </span>
              </div>
              <div className="text-slate-500">
                Agency / Institution:{' '}
                <span className="text-slate-900 font-medium">{reportData.agency}</span>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-slate-500">
                Examination Timestamp:{' '}
                <span className="font-mono text-slate-800">
                  {formatTimelineDate(reportData.createdAt)}
                </span>
              </div>
              <div className="text-slate-500">
                Assessment Status:{' '}
                <span className="font-mono font-bold text-slate-900">{simpleReport.conclusionLabel}</span>
              </div>
            </div>
          </div>

          {/* Section 1: Executive Summary */}
          <div className="space-y-2">
            <h3 className="text-sm font-bold tracking-wider text-slate-900 uppercase font-mono border-b border-slate-200 pb-1">
              1. Executive Summary & Objective Statement
            </h3>
            <p className="text-xs text-slate-700 leading-relaxed">{reportData.summary}</p>
          </div>

          {/* Section 2: Evidence Inventory */}
          <div className="space-y-4">
            <h3 className="text-sm font-bold tracking-wider text-slate-900 uppercase font-mono border-b border-slate-200 pb-1">
              2. Evidence Inventory & Cryptographic Hash Register
            </h3>

            <div className="rounded-lg border border-slate-200 overflow-hidden">
              <table className="w-full text-left text-xs border-collapse font-mono">
                <thead>
                  <tr className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200">
                    <th className="py-2 px-3">EVIDENCE ID / FILE</th>
                    <th className="py-2 px-3">TYPE</th>
                    <th className="py-2 px-3">ROLE</th>
                    <th className="py-2 px-3">RECORDED SHA-256</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-slate-700">
                  {reportData.evidenceList.map((e) => (
                    <tr key={e.id} className="hover:bg-slate-50">
                      <td className="py-2 px-3 font-sans font-medium text-slate-900 truncate max-w-xs">
                        <button
                          type="button"
                          onClick={() => {
                            const item = caseEvidence.find((candidate) => candidate.id === e.id);
                            if (item) onOpenEvidence(item);
                          }}
                          className="text-left text-cyan-800 underline font-semibold"
                        >
                          {e.fileName}
                        </button>
                        <span className="block text-[10px] text-slate-500">{e.id}</span>
                      </td>
                      <td className="py-2 px-3 uppercase text-slate-600">{e.mediaType}</td>
                      <td className="py-2 px-3 font-sans">
                        {e.isOriginal ? 'Baseline Reference' : 'Suspect Item'}
                      </td>
                      <td className="py-2 px-3 text-cyan-900 truncate max-w-md font-mono">
                        {e.hashStatus === 'calculated' ? e.sha256 : 'Not calculated'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Side-by-side Evidence Photos (Dono images ko sath me rakho up niche nhi) */}
            {uniqueVisualEvidence.length > 0 && (
              <div className="space-y-2 pt-2">
                <div className="text-xs font-bold uppercase tracking-wider text-slate-700 font-mono">
                  Visual Evidence Comparison (Side-by-Side)
                </div>
                <div className="grid grid-cols-2 gap-4">
                  {uniqueVisualEvidence.map((entry, idx) => (
                    <div key={entry.evidenceId} className="border border-slate-200 rounded-lg p-2 bg-slate-50 flex flex-col shadow-sm">
                      <div className="text-[10px] font-mono font-bold text-slate-700 mb-1">
                        {idx === 0 && uniqueVisualEvidence.length > 1 ? '[Baseline Reference] ' : '[Suspect Evidence] '}
                        {entry.fileName}
                      </div>
                      {entry.mediaType === 'video' && entry.videoUrl ? (
                        <video
                          src={entry.videoUrl}
                          poster={entry.imageUrl}
                          controls
                          playsInline
                          preload="metadata"
                          aria-label={`${entry.fileName} video evidence`}
                          className="w-full h-40 object-contain bg-slate-950 rounded p-1"
                        />
                      ) : entry.imageUrl ? (
                        <img src={entry.imageUrl} alt={entry.fileName} className="w-full h-40 object-contain bg-slate-950 rounded p-1" />
                      ) : null}
                      <div className="mt-1.5 text-[10px] font-mono text-slate-500 truncate">
                        SHA-256: {entry.sha256 || 'Calculated'}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Section 3: Findings */}
          <div className="space-y-3">
            <h3 className="text-sm font-bold tracking-wider text-slate-900 uppercase font-mono border-b border-slate-200 pb-1">
              3. Detailed Forensic Findings & Technical Observations
            </h3>

            <div className="space-y-3">
              {observationSections.map((section, sectionIndex) => (
                <section key={section.title} className="space-y-2">
                  <h4 className="text-xs font-bold tracking-wide text-slate-800 uppercase font-mono">
                    3.{sectionIndex + 1} · {section.title}
                  </h4>
                  {section.findings.length ? section.findings.map((f: AnalysisFinding, findingIndex) => (
                    <div key={`${section.title}-${f.id}`} className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-bold text-slate-900">Finding {sectionIndex + 1}.{findingIndex + 1}: {f.title}</span>
                        <SeverityBadge severity={f.severity} />
                      </div>
                      <p className="text-[11px] font-mono text-slate-500">Evidence: {caseEvidence.find((item) => item.id === f.evidenceId)?.fileName || f.evidenceId} · {f.evidenceId}</p>
                      <p className="text-xs text-slate-700 leading-relaxed">
                        <strong className="text-slate-900 font-extrabold">Recorded Observation: {f.observedEvidence}</strong>
                      </p>
                      <p className="text-xs text-slate-700 leading-relaxed">
                        <span className="text-slate-500 font-medium">Explanation: </span>
                        {f.plainEnglishSummary || f.simpleExplanation || 'No summary available.'}
                      </p>
                      <div className="text-[11px] font-mono text-slate-500 pt-1">
                        Method: {f.detectionMethod} · Limitations: {f.limitations || 'None documented.'}
                      </div>
                    </div>
                  )) : <p className="text-xs text-slate-500">No {section.title.toLowerCase()} have been recorded.</p>}
                </section>
              ))}
            </div>
          </div>

          <section className="space-y-3">
            <h3 className="text-sm font-bold tracking-wider text-slate-900 uppercase font-mono border-b border-slate-200 pb-1">4. Certificates</h3>
            {caseCertificates.length ? caseCertificates.map((certificate) => (
              <div key={certificate.certificateId} className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                <b>{certificate.certificateId}</b> · {certificate.fileName} · Status: {certificate.status}
                <p className="mt-1">SHA-256: {certificate.sha256Hash || 'Not available'}</p>
                <p className="mt-1">Issued: {formatTimelineDate(certificate.analysisTimestamp)} · Examiner: {certificate.examinerName || 'Not available'}</p>
                <p className="mt-1">This certificate records file details. It does not prove who created the file or that its contents are true.</p>
              </div>
            )) : <p className="text-xs text-slate-500">No certificates are recorded for this case.</p>}
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-bold tracking-wider text-slate-900 uppercase font-mono border-b border-slate-200 pb-1">5. Chain of custody</h3>
            {caseProvenance.length ? caseProvenance.map((event) => (
              <div key={event.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                <b>{event.actionType.replace(/_/g, ' ')}</b> · {formatTimelineDate(event.timestamp)} · {event.actor || 'Actor not recorded'}
                <p className="mt-1">{event.notes || 'No notes recorded.'}</p>
                <p className="mt-1 font-mono text-[10px]">SHA-256: {event.recordedSha256 || 'Not available'}</p>
              </div>
            )) : <p className="text-xs text-slate-500">No chain-of-custody events are recorded for this case.</p>}
          </section>

          {/* Section 6: Disclaimers */}
          <div className="space-y-2 border-t border-slate-200 pt-4">
            <h3 className="text-xs font-bold tracking-wider text-slate-800 uppercase font-mono">
              4. Methodological Scope & Scientific Disclaimers
            </h3>
            <ul className="list-disc list-inside space-y-1 text-[11px] text-slate-600 leading-relaxed">
              {(reportData.disclaimers || []).map((d: string, i: number) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </div>

          {/* Signed report record */}
          <div className="grid grid-cols-1 gap-6 border-t border-slate-200 pt-6 text-xs sm:grid-cols-2">
            <div className="space-y-2">
              <div className="border-b border-slate-300 pb-1 font-semibold text-slate-900">
                {signedAuthentication?.record.examinerName || 'Examiner not available'} · Lead Examiner
              </div>
              {isReportAuthenticated ? (
                <div className="my-2 flex h-12 max-w-52 items-center border-b border-slate-300 font-serif italic text-sm text-cyan-900">
                  Electronically signed
                </div>
              ) : (
                <div className="my-2 flex h-12 max-w-52 items-center border-b border-dashed border-slate-300 text-[11px] text-slate-500">
                  Signature appears after authentication
                </div>
              )}
              <div className="text-[11px] leading-5 text-slate-500">
                {isReportAuthenticated
                  ? `Report signature recorded · Badge ${signedAuthentication?.record.examinerBadge || 'not available'}`
                  : 'Authentication required before this report is digitally signed.'}
              </div>
            </div>

            <div className="space-y-2 flex flex-col justify-between">
              <div>
                <div className="border-b border-slate-300 pb-1 font-semibold text-slate-900">
                  Forensic Seal & Verification
                </div>
                <div className="text-[11px] leading-5 text-slate-500 mt-1">
                  Report ID: <span className="font-mono font-bold text-slate-800">{reportNumber}</span>
                </div>
              </div>

              <div className="flex items-center gap-4 pt-2">
                <OfficialLabStamp authenticated={isReportAuthenticated} />
                {isReportAuthenticated && activeAuthentication.qrDataUrl && (
                  <div className="text-center">
                    <img
                      src={activeAuthentication.qrDataUrl}
                      alt={`QR code to verify report ${reportNumber}`}
                      className="h-24 w-24 rounded border border-slate-300 bg-white p-1 shadow-sm"
                    />
                    <span className="block mt-1 font-mono text-[8.5px] text-slate-500">Scan to Verify</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          <footer className="border-t border-slate-200 pt-4 text-xs leading-5 text-slate-500 text-center">
            Educational summary · automated checks do not establish legal authenticity
          </footer>
        </div>
      )}
    </div>
  );
};
