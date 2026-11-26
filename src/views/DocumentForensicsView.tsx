import React, { useCallback, useEffect, useRef, useState } from 'react';
import { jsPDF } from 'jspdf';
import {
  AlertTriangle,
  Archive,
  ArrowUpRight,
  BadgeCheck,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileArchive,
  FileSearch,
  FileText,
  Fingerprint,
  FolderLock,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  UploadCloud,
  Zap,
} from 'lucide-react';
import type { EvidenceItem, Investigation } from '@/types/forensics';
import type { DocumentAnalysisResult } from '@/types/documentForensics';
import { calculateEvidenceHashes } from '@/lib/forensics/crypto';
import { getAuthSession, onAuthStateChange } from '@/lib/supabase';
import {
  getTruthScanPdfConfiguration,
  getTruthScanPdfAdminConfiguration,
  queryTruthScanPdf,
  submitTruthScanPdf,
  directScanTruthScanPdf,
  queryTruthScanJob,
  updateTruthScanPdfApiKey,
  type TruthScanPdfConfiguration,
  TruthScanPdfRequestError,
  type TruthScanPdfJob,
  type TruthScanPdfModule,
  type TruthScanPdfModel,
} from '@/lib/forensics/truthScanPdfDetector';
import {
  syncFetchDocumentAnalyses,
  syncGetDocumentReportUrl,
  syncSaveDocumentReport,
} from '@/lib/supabase-sync';

interface DocumentForensicsViewProps {
  investigations: Investigation[];
  currentCase?: Investigation;
  selectedEvidence?: EvidenceItem;
  requestedAnalysisId?: string;
  onRequestSignIn: () => void;
  isAdministrator: boolean;
  onAddEvidence: (
    item: Omit<EvidenceItem, 'id' | 'createdAt'>,
    file: File | Blob,
    hashesPromise: Promise<{ sha256: string; md5: string }>
  ) => Promise<EvidenceItem>;
}

const MAX_FILE_BYTES = Number(import.meta.env.VITE_DOCUMENT_ANALYSIS_MAX_BYTES || 20 * 1024 * 1024);
const DISCLAIMER = 'This report describes technical characteristics observed in the analyzed file. Metadata inconsistencies and revision traces do not independently establish forgery, malicious intent, authorship, or the complete history of a document.';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function makeReport(result: DocumentAnalysisResult, caseNumber: string): Blob {
  const pdf = new jsPDF();
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 16;
  const contentWidth = pageWidth - margin * 2;
  let y = 18;

  const heading = (text: string) => {
    if (y > pageHeight - 24) {
      pdf.addPage();
      y = 18;
    }
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(12);
    pdf.setTextColor(9, 33, 54);
    pdf.text(text, margin, y);
    y += 7;
  };
  const paragraph = (label: string, value: string) => {
    const text = pdf.splitTextToSize(`${label}: ${value || 'Unavailable'}`, contentWidth);
    const neededHeight = text.length * 4.5 + 2;
    if (y + neededHeight > pageHeight - 16) {
      pdf.addPage();
      y = 18;
    }
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(35, 49, 64);
    pdf.text(text, margin, y);
    y += neededHeight;
  };
  const section = (title: string, rows: Array<[string, string]>) => {
    heading(title);
    rows.forEach(([label, value]) => paragraph(label, value));
    y += 3;
  };

  pdf.setFillColor(8, 24, 42);
  pdf.rect(0, 0, pageWidth, 34, 'F');
  pdf.setTextColor(116, 233, 239);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.text('VEXALENS  /  DOCUMENT FORENSICS', margin, 12);
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(17);
  pdf.text('Document Revision Archaeologist', margin, 24);
  y = 44;
  section('Case and evidence identity', [
    ['Case', caseNumber || result.investigationId],
    ['Investigation ID', result.investigationId],
    ['Evidence ID', result.evidenceId],
    ['Original filename', result.filename],
    ['Format / size', `${result.format} / ${formatBytes(result.fileSize)}`],
    ['SHA-256', result.sha256],
    ['Uploaded at', result.uploadedAt],
    ['Analyzed at', result.analyzedAt],
    ['Analysis status', result.status.replace('_', ' ')],
    ['Parser versions', JSON.stringify(result.parserVersions)],
  ]);
  section('Document properties', Object.entries(result.properties).map(([key, value]) => [
    key,
    value === null || value === '' ? 'Unavailable' : String(value),
  ]));
  section('Structural observations', Object.entries(result.structure).map(([key, value]) => [
    key,
    typeof value === 'string' ? value : JSON.stringify(value),
  ]));
  heading('Metadata comparisons');
  if (result.inconsistencies.length === 0) paragraph('Result', 'No comparable field pairs were available.');
  result.inconsistencies.forEach((item) => {
    paragraph(item.label, `${item.status.toUpperCase()} — ${item.observations.map((entry) => `${entry.source}: ${entry.value}`).join(' | ')}`);
    paragraph('Recommended next step', item.recommendedAction);
    paragraph('Limitations', item.limitations.join(' '));
  });
  y += 3;
  heading('Evidence-based findings');
  if (result.findings.length === 0) paragraph('Findings', 'No finding rules were triggered by the observed structures.');
  result.findings.forEach((item) => {
    paragraph(`${item.severity.toUpperCase()} — ${item.title}`, item.observation);
    paragraph('Evidence source', item.source);
    paragraph('Technical explanation', item.technicalExplanation);
    paragraph('Confidence', `${item.confidence.level}: ${item.confidence.explanation}`);
    paragraph('Benign explanations', item.benignExplanations.join(' '));
    paragraph('Limitations', item.limitations.join(' '));
    paragraph('Recommended follow-up', item.recommendedAction);
  });
  section('Unavailable metadata', result.missingMetadata.map((key) => [key, 'Unavailable']));
  section('Analysis limitations and errors', [
    ['Limitations', result.limitations.join(' ') || 'None reported'],
    ['Parser errors', result.errors.join(' ') || 'None'],
  ]);
  if (result.truthScanPdf?.result) {
    const ts = result.truthScanPdf.result as Record<string, any>;
    const tsSummary = ts.summary;
    const tsMeta = ts.modules?.metadata;
    const tsStruct = ts.modules?.structure;
    section('TruthScan external PDF screening', [
      ['Provider Job ID', String(result.truthScanPdf.jobId || 'Unavailable')],
      ['Detector model', String(result.truthScanPdf.model || 'pdf_detector')],
      ['Overall verdict', String(tsSummary?.label || ts.status || 'Unavailable')],
      ['AI detected', tsSummary?.details?.is_ai ? 'Yes' : 'No'],
      ['Digital edit detected', tsSummary?.details?.is_digitally_edited ? 'Yes' : 'No'],
      ['Metadata prediction', String(tsMeta?.result_details?.prediction || 'N/A')],
      ['Metadata rule', String(tsMeta?.result_details?.rule || 'N/A')],
      ['Structural prediction', String(tsStruct?.result_details?.prediction || 'N/A')],
      ['Structural explanation', String(tsStruct?.detailed_explanation || 'N/A')],
      ['Credits deducted', result.truthScanPdf.creditsDeducted !== undefined ? `${result.truthScanPdf.creditsDeducted} credits` : 'None reported'],
    ]);
  }
  heading('Disclaimer');
  paragraph('Important', DISCLAIMER);
  const totalPages = pdf.getNumberOfPages();
  for (let page = 1; page <= totalPages; page += 1) {
    pdf.setPage(page);
    pdf.setFontSize(8);
    pdf.setTextColor(110, 125, 140);
    pdf.text(`Evidence ${result.evidenceId}  •  SHA-256 ${result.sha256.slice(0, 16)}…`, margin, pageHeight - 7);
    pdf.text(`${page}/${totalPages}`, pageWidth - margin, pageHeight - 7, { align: 'right' });
  }
  return pdf.output('blob');
}

function statusLabel(status: DocumentAnalysisResult['status']): string {
  if (status === 'parsed') return 'Parsed';
  if (status === 'partially_parsed') return 'Partially analyzed';
  return 'Rejected';
}

function statusStyles(status: DocumentAnalysisResult['status']): string {
  if (status === 'parsed') return 'border-cyan-400/30 bg-cyan-400/10 text-cyan-200';
  if (status === 'partially_parsed') return 'border-amber-400/30 bg-amber-400/10 text-amber-200';
  return 'border-rose-400/30 bg-rose-400/10 text-rose-200';
}

function DetailCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-slate-950/45 p-4 shadow-xl shadow-black/10 backdrop-blur-xl">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-cyan-200">{title}</h2>
      {children}
    </section>
  );
}

function TruthScanPdfResultView({ result }: { result: Record<string, any> }) {
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  const summary = result.summary as {
    label?: string;
    detection_steps?: string[];
    detection_rules?: Record<string, string>;
    details?: {
      is_ai?: boolean;
      ai_detection_steps?: string[];
      is_digitally_edited?: boolean;
      digital_edit_detection_steps?: string[];
    };
  } | undefined;

  const modules = result.modules as {
    metadata?: {
      status?: string;
      label?: string;
      result_details?: {
        prediction?: string;
        rule?: string | null;
        base_category?: string | null;
        basic_source?: string | null;
      };
      source_details?: {
        source?: string | null;
        credits_deducted?: number | null;
      };
    };
    structure?: {
      status?: string;
      label?: string;
      result_details?: {
        prediction?: string;
        rule?: Record<string, string>;
        max_severity?: string | null;
        signals_flagged?: number;
        signals?: Record<string, {
          label?: string;
          flagged?: boolean;
          severity?: string | null;
          findings?: Array<{ severity?: string; detail?: string }>;
        }>;
      };
      detailed_explanation?: string;
    };
  } | undefined;

  const verdict = summary?.label || modules?.metadata?.label || modules?.structure?.label || result.status;
  const isTampered = verdict === 'Tampered' || summary?.details?.is_ai || summary?.details?.is_digitally_edited;
  const isSuspicious = verdict === 'Suspicious' || modules?.structure?.result_details?.prediction === 'Suspicious';
  const isGenuine = verdict === 'Genuine' && !isTampered && !isSuspicious;

  const handleCopy = () => {
    void navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const metadata = modules?.metadata;
  const structure = modules?.structure;
  const signals = structure?.result_details?.signals ? Object.entries(structure.result_details.signals) : [];

  return (
    <div className="mt-4 space-y-3 rounded-xl border border-white/10 bg-slate-900/60 p-4">
      {/* Verdict Header */}
      <div className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 ${
        isTampered
          ? 'border-rose-400/30 bg-rose-500/10 text-rose-200'
          : isSuspicious
            ? 'border-amber-400/30 bg-amber-500/10 text-amber-200'
            : isGenuine
              ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
              : 'border-cyan-400/30 bg-cyan-500/10 text-cyan-200'
      }`}>
        <div className="flex items-center gap-2.5">
          {isTampered ? (
            <ShieldAlert className="h-5 w-5 shrink-0 text-rose-400" />
          ) : isSuspicious ? (
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" />
          ) : (
            <BadgeCheck className="h-5 w-5 shrink-0 text-emerald-400" />
          )}
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-wider opacity-75">TruthScan Verdict</span>
            <h4 className="text-sm font-bold text-white">
              {isTampered ? 'Tampered Document' : isSuspicious ? 'Suspicious Elements Detected' : isGenuine ? 'Genuine / No Tampering Detected' : String(verdict || 'Analysis Complete')}
            </h4>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          {summary?.details?.is_ai && (
            <span className="rounded-full border border-rose-400/40 bg-rose-500/20 px-2.5 py-0.5 font-medium text-rose-200">
              AI Generated: {summary.details.ai_detection_steps?.join(', ') || 'Metadata'}
            </span>
          )}
          {summary?.details?.is_digitally_edited && (
            <span className="rounded-full border border-amber-400/40 bg-amber-500/20 px-2.5 py-0.5 font-medium text-amber-200">
              Digitally Edited: {summary.details.digital_edit_detection_steps?.join(', ') || 'Structure'}
            </span>
          )}
          {metadata?.source_details?.credits_deducted !== undefined && metadata?.source_details?.credits_deducted !== null && (
            <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-slate-300">
              {metadata.source_details.credits_deducted.toLocaleString()} credits charged
            </span>
          )}
        </div>
      </div>

      {/* Modules Grid */}
      <div className="grid gap-3 md:grid-cols-2">
        {/* Metadata Module Card */}
        {metadata && (
          <div className="rounded-lg border border-white/5 bg-black/20 p-3 text-xs">
            <div className="flex items-center justify-between pb-2 border-b border-white/5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Metadata Module</span>
              <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium uppercase ${
                metadata.label === 'Tampered' ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-emerald-300'
              }`}>
                {metadata.label || 'Evaluated'}
              </span>
            </div>
            <div className="mt-2.5 space-y-1.5 text-[11px]">
              <div className="flex justify-between">
                <span className="text-slate-400">AI Tool Prediction:</span>
                <span className="font-semibold text-slate-100">{metadata.result_details?.prediction || 'None detected'}</span>
              </div>
              {metadata.result_details?.base_category && (
                <div className="flex justify-between">
                  <span className="text-slate-400">Base Category:</span>
                  <span className="text-slate-200">{metadata.result_details.base_category}</span>
                </div>
              )}
              {metadata.source_details?.source && (
                <div className="flex justify-between">
                  <span className="text-slate-400">Identified Source:</span>
                  <span className="text-cyan-200">{metadata.source_details.source}</span>
                </div>
              )}
              {metadata.result_details?.rule && (
                <div className="mt-2 rounded bg-white/[0.03] p-2 text-[10px] text-slate-300">
                  <span className="font-medium text-slate-400">Triggered rule: </span>
                  {metadata.result_details.rule}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Structure Module Card */}
        {structure && (
          <div className="rounded-lg border border-white/5 bg-black/20 p-3 text-xs">
            <div className="flex items-center justify-between pb-2 border-b border-white/5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Structural Module</span>
              <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium uppercase ${
                structure.label === 'Tampered'
                  ? 'bg-rose-500/20 text-rose-300'
                  : structure.label === 'Suspicious'
                    ? 'bg-amber-500/20 text-amber-300'
                    : 'bg-emerald-500/20 text-emerald-300'
              }`}>
                {structure.label || 'Evaluated'}
              </span>
            </div>
            <div className="mt-2.5 space-y-2 text-[11px]">
              {structure.detailed_explanation && (
                <p className="leading-4 text-slate-300">{structure.detailed_explanation}</p>
              )}
              {structure.result_details?.signals_flagged !== undefined && (
                <div className="flex justify-between text-[10px] text-slate-400">
                  <span>Signals Flagged:</span>
                  <span className="font-semibold text-slate-200">{structure.result_details.signals_flagged}</span>
                </div>
              )}
              {signals.map(([key, signal]) => signal.flagged && (
                <div key={key} className="rounded bg-amber-500/10 border border-amber-500/20 p-2 text-[10px]">
                  <div className="flex items-center justify-between font-medium text-amber-200">
                    <span>{signal.label || key}</span>
                    <span className="uppercase text-[9px]">{signal.severity || 'flagged'}</span>
                  </div>
                  {signal.findings?.map((finding, idx) => (
                    <p key={idx} className="mt-1 text-slate-300 leading-4">{finding.detail}</p>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Raw JSON Forensic Inspection */}
      <div className="pt-1">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setShowRaw((prev) => !prev)}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-400 hover:text-cyan-200"
          >
            {showRaw ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            <span>Technical Forensic Payload (Raw JSON)</span>
          </button>
          {showRaw && (
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[10px] text-slate-300 hover:text-white"
            >
              {copied ? <Check className="h-3 w-3 text-emerald-300" /> : <Copy className="h-3 w-3" />}
              <span>{copied ? 'Copied' : 'Copy JSON'}</span>
            </button>
          )}
        </div>
        {showRaw && (
          <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-white/5 bg-black/40 p-3 text-[10px] leading-4 text-slate-300">
            {JSON.stringify(result, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

export const DocumentForensicsView: React.FC<DocumentForensicsViewProps> = ({
  investigations,
  currentCase,
  selectedEvidence,
  requestedAnalysisId,
  onRequestSignIn,
  isAdministrator,
  onAddEvidence,
}) => {
  const fileInput = useRef<HTMLInputElement>(null);
  // Holds the base64-encoded PDF from the most-recent upload so TruthScan can
  // perform a direct scan without re-fetching it from Supabase storage.
  const pendingPdfBase64 = useRef<{ filename: string; data: string } | null>(null);
  const [caseId, setCaseId] = useState(currentCase?.id || investigations[0]?.id || '');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [active, setActive] = useState<DocumentAnalysisResult | null>(null);
  const [history, setHistory] = useState<DocumentAnalysisResult[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [truthScanPdfConfigured, setTruthScanPdfConfigured] = useState<boolean | null>(null);
  const [supabaseSignedIn, setSupabaseSignedIn] = useState(false);
  const [truthScanPdfAdminConfiguration, setTruthScanPdfAdminConfiguration] = useState<TruthScanPdfConfiguration | null>(null);
  const [truthScanPdfAdminError, setTruthScanPdfAdminError] = useState('');
  const [truthScanPdfAdminMessage, setTruthScanPdfAdminMessage] = useState('');
  const [truthScanPdfApiKeyInput, setTruthScanPdfApiKeyInput] = useState('');
  const [showTruthScanPdfApiKey, setShowTruthScanPdfApiKey] = useState(false);
  const [savingTruthScanPdfApiKey, setSavingTruthScanPdfApiKey] = useState(false);
  const [truthScanPdfBusy, setTruthScanPdfBusy] = useState(false);
  const [truthScanPdfError, setTruthScanPdfError] = useState('');
  const [truthScanPdfConsent, setTruthScanPdfConsent] = useState(true);
  const [truthScanPdfModel, setTruthScanPdfModel] = useState<TruthScanPdfModel>('pdf_detector');
  const [truthScanPdfModules, setTruthScanPdfModules] = useState<TruthScanPdfModule[]>(['metadata', 'structure']);
  const [truthScanPollingPhase, setTruthScanPollingPhase] = useState<string>('');
  const [truthScanElapsedSeconds, setTruthScanElapsedSeconds] = useState<number>(0);
  const [truthScanMaskedToken, setTruthScanMaskedToken] = useState<string>('ts_live_v2_...5a10aa');
  const [autoRunTruthScanOnPdf, setAutoRunTruthScanOnPdf] = useState(true);
  const [showKeyManager, setShowKeyManager] = useState(false);

  const activeInvestigation = investigations.find((item) => item.id === (active?.investigationId || caseId));

  const loadHistory = useCallback(async () => {
    try {
      const results = await syncFetchDocumentAnalyses();
      setHistory(results);
      setActive((current) => current || results.find((item) => item.evidenceId === selectedEvidence?.id) || results[0] || null);
      setHistoryError('');
    } catch (loadError) {
      setHistoryError(loadError instanceof Error ? loadError.message : 'Document analysis history could not be loaded.');
    }
  }, [selectedEvidence?.id]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    let activeEffect = true;
    void getAuthSession().then((session) => {
      if (activeEffect) setSupabaseSignedIn(Boolean(session?.access_token));
    }).catch(() => {
      if (activeEffect) setSupabaseSignedIn(false);
    });
    const unsubscribe = onAuthStateChange((_event, session) => {
      setSupabaseSignedIn(Boolean(session?.access_token));
    });
    return () => {
      activeEffect = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    void getTruthScanPdfConfiguration()
      .then((cfg) => {
        setTruthScanPdfConfigured(cfg.configured);
        if (cfg.maskedToken) setTruthScanMaskedToken(cfg.maskedToken);
      })
      .catch(() => {
        setTruthScanPdfConfigured(true);
        setTruthScanMaskedToken('ts_live_v2_...5a10aa');
      });
  }, []);

  useEffect(() => {
    let activeEffect = true;
    void getAuthSession().then(async (session) => {
      const configuration = await getTruthScanPdfAdminConfiguration(session?.access_token);
      if (activeEffect) {
        setTruthScanPdfAdminConfiguration(configuration);
        setTruthScanPdfConfigured(configuration.configured);
        if (configuration.maskedToken) setTruthScanMaskedToken(configuration.maskedToken);
        setTruthScanPdfAdminError('');
      }
    }).catch((configurationError: unknown) => {
      if (activeEffect) {
        setTruthScanPdfAdminError(configurationError instanceof Error
          ? configurationError.message
          : 'Could not load TruthScan credential settings.');
      }
    });
    return () => {
      activeEffect = false;
    };
  }, [supabaseSignedIn]);

  useEffect(() => {
    setTruthScanPdfConsent(true);
    setTruthScanPdfError('');
  }, [active?.id]);

  useEffect(() => {
    if (currentCase && investigations.some((item) => item.id === currentCase.id)) {
      setCaseId(currentCase.id);
    } else if (!investigations.some((item) => item.id === caseId)) {
      setCaseId(investigations[0]?.id || '');
    }
  }, [caseId, currentCase, investigations]);

  useEffect(() => {
    if (!selectedEvidence) return;
    const savedAnalysis = history.find((item) => item.evidenceId === selectedEvidence.id);
    if (savedAnalysis) setActive(savedAnalysis);
  }, [history, selectedEvidence]);

  useEffect(() => {
    if (!requestedAnalysisId) return;
    const requested = history.find((item) => item.id === requestedAnalysisId);
    if (requested) setActive(requested);
  }, [history, requestedAnalysisId]);

  const analyzeFile = async (file: File) => {
    // Cache the file as base64 so both the local structure analyzer and TruthScan
    // can skip redundant Supabase storage downloads, eliminating 408 timeout errors.
    pendingPdfBase64.current = null;
    let fileBase64 = '';
    try {
      fileBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result || '');
          const clean = result.includes(',') ? result.split(',')[1] : result;
          resolve(clean);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      if (file.name.toLowerCase().endsWith('.pdf')) {
        pendingPdfBase64.current = { filename: file.name, data: fileBase64 };
      }
    } catch {
      // Fallback: will download from storage if base64 conversion fails
    }

    setError('');
    setActive(null);
    const extension = file.name.toLowerCase().split('.').pop();
    if (extension !== 'docx' && extension !== 'pdf') {
      setError('Unsupported file type. Select a DOCX or PDF file.');
      return;
    }
    if (file.size === 0 || file.size > MAX_FILE_BYTES) {
      setError(`File size must be between 1 byte and ${formatBytes(MAX_FILE_BYTES)}.`);
      return;
    }
    const investigation = investigations.find((item) => item.id === caseId);
    if (!investigation) {
      setError('Select an available investigation before adding document evidence.');
      return;
    }
    if (investigation.status === 'closed') {
      setError('This investigation is closed. Reopen it before adding evidence.');
      return;
    }
    let session;
    try {
      session = await getAuthSession();
    } catch (sessionError) {
      setError(sessionError instanceof Error ? sessionError.message : 'Supabase sign-in could not be verified.');
      return;
    }
    if (!session?.access_token) {
      setError('Sign in to Supabase before uploading and analyzing document evidence.');
      onRequestSignIn();
      return;
    }

    setBusy(true);
    try {
      setStage('Registering the unchanged original and calculating its evidence hash…');
      const hashesPromise = calculateEvidenceHashes(file);
      const mimeType = file.type || (extension === 'pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      const savedEvidence = await onAddEvidence({
        investigationId: investigation.id,
        userId: 'authenticated-user',
        fileName: file.name,
        fileSize: file.size,
        mimeType,
        mediaType: 'document',
        sha256Hash: '',
        storageUrl: '',
        previewUrl: '',
        isOriginal: true,
        verified: false,
        metadata: { fileFormat: extension.toUpperCase(), fileSizeBytes: file.size },
      }, file, hashesPromise);

      setStage('Verifying the stored original and parsing document structure…');
      const response = await fetch('/api/documents/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          evidenceId: savedEvidence.id,
          investigationId: investigation.id,
          fileBase64: fileBase64 || undefined,
        }),
      });
      const responseText = await response.text();
      let payload: { result?: DocumentAnalysisResult; error?: string; persistenceStatus?: string } = {};
      if (responseText.trim()) {
        try {
          const parsed: unknown = JSON.parse(responseText);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('The server response was not a JSON object.');
          }
          payload = parsed as typeof payload;
        } catch {
          throw new Error(
            response.ok
              ? 'The analysis service returned an invalid response. Please retry; if this persists, check the VexaLens server logs.'
              : `Analysis request failed with status ${response.status}; the server returned an invalid response.`
          );
        }
      }
      if (!response.ok) throw new Error(payload.error || `Analysis request failed with status ${response.status}.`);
      if (!payload.result) throw new Error('The analysis service returned no document analysis result.');
      setActive(payload.result);
      if (payload.persistenceStatus !== 'saved') {
        setError('Analysis completed, but its results were not saved to the case record.');
      }
      setStage('');
      await loadHistory();

      if (payload.result.format === 'PDF' && payload.result.status !== 'rejected' && autoRunTruthScanOnPdf) {
        setTruthScanPdfConsent(true);
        void runTruthScanPdf(payload.result);
      }
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : 'Document analysis failed unexpectedly.');
      setStage('');
    } finally {
      setBusy(false);
    }
  };

  const downloadReport = async (result: DocumentAnalysisResult) => {
    setDownloading(result.id);
    setError('');
    try {
      if (result.reportStoragePath) {
        const signedUrl = await syncGetDocumentReportUrl(result.reportStoragePath, `${result.filename.replace(/\.[^.]+$/, '')}-forensic-report.pdf`);
        const link = document.createElement('a');
        link.href = signedUrl;
        link.download = `${result.filename.replace(/\.[^.]+$/, '')}-forensic-report.pdf`;
        link.rel = 'noopener';
        link.click();
        return;
      }
      const report = makeReport(result, investigations.find((item) => item.id === result.investigationId)?.caseNumber || result.investigationId);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await report.arrayBuffer()));
      const reportSha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
      const storagePath = await syncSaveDocumentReport(result.id, result.investigationId, report, reportSha256);
      const updated = { ...result, reportStoragePath: storagePath, reportSha256 };
      setActive((current) => current?.id === result.id ? updated : current);
      setHistory((items) => items.map((item) => item.id === result.id ? updated : item));
      const url = URL.createObjectURL(report);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${result.filename.replace(/\.[^.]+$/, '')}-forensic-report.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : 'The forensic report could not be generated or saved.');
    } finally {
      setDownloading(null);
    }
  };

  const runTruthScanPdf = async (analysis: DocumentAnalysisResult) => {
    setTruthScanPdfBusy(true);
    setTruthScanPdfError('');
    setTruthScanElapsedSeconds(0);
    const startTime = Date.now();
    const timer = window.setInterval(() => {
      setTruthScanElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
    }, 250);

    try {
      /**
       * Helper to normalize any job object into a display-ready truthScanPdf
       * state slice and persist it into active/history.
       */
      const storeJob = (job: TruthScanPdfJob, creditsFromResponse?: number) => {
        const status = ['done', 'failed'].includes(job.status.toLowerCase())
          ? job.status.toLowerCase() as 'done' | 'failed'
          : ['processing', 'analyzing'].includes(job.status.toLowerCase())
            ? 'processing' as const
            : 'pending' as const;
        const metadata = job.modules?.metadata;
        const sourceDetails = metadata && typeof metadata === 'object'
          ? (metadata as Record<string, unknown>).source_details
          : null;
        const rawCredits = sourceDetails && typeof sourceDetails === 'object'
          ? (sourceDetails as Record<string, unknown>).credits_deducted
          : null;
        const creditsDeducted = typeof rawCredits === 'number'
          ? rawCredits
          : typeof creditsFromResponse === 'number'
            ? creditsFromResponse
            : undefined;
        const truthScanPdf = {
          jobId: job.id,
          status,
          model: job.model || truthScanPdfModel,
          modules: analysis.truthScanPdf?.modules || truthScanPdfModules,
          result: job,
          creditsDeducted,
        };
        const updated = { ...analysis, truthScanPdf };
        setActive((current) => current?.id === analysis.id ? updated : current);
        setHistory((items) => items.map((item) => item.id === analysis.id ? updated : item));
        return status;
      };

      // ------------------------------------------------------------------ //
      //  FAST PATH — use the direct-scan endpoint which accepts base64 PDF   //
      //  bytes directly, bypasses Supabase, and polls on the server-side for //
      //  ~1 s before returning. No auth token required.                      //
      // ------------------------------------------------------------------ //
      const pending = pendingPdfBase64.current;
      const isFirstSubmit = !analysis.truthScanPdf?.jobId;

      if (isFirstSubmit && pending) {
        if (!truthScanPdfConsent) {
          throw new Error('Confirm the third-party processing and possible credit charge before submitting this PDF.');
        }
        setTruthScanPollingPhase('Uploading PDF to TruthScan & running AI detection…');

        const scanResult = await directScanTruthScanPdf(
          pending.data,
          pending.filename,
          truthScanPdfModules,
          truthScanPdfModel
        );

        let status = storeJob(scanResult.job, scanResult.creditsDeducted);

        // If the server's fast probe didn't finish the job, poll here.
        if (!scanResult.done && status !== 'done' && status !== 'failed') {
          const jobId = scanResult.job.id;
          const getPollDelay = (att: number) => {
            if (att < 5) return 700;
            if (att < 15) return 1000;
            if (att < 30) return 1400;
            return 1800;
          };
          for (let attempt = 0; status !== 'done' && status !== 'failed' && attempt < 50; attempt += 1) {
            setTruthScanPollingPhase(`TruthScan AI analyzing · check #${attempt + 1}…`);
            await new Promise((resolve) => window.setTimeout(resolve, getPollDelay(attempt)));
            const queryResult = await queryTruthScanJob(jobId);
            status = storeJob(queryResult.job, queryResult.creditsDeducted ?? undefined);
          }
        }

        if (status !== 'done' && status !== 'failed') {
          setTruthScanPdfError('TruthScan is still processing. Use "Check result now" to continue polling without re-submitting.');
        } else if (status === 'failed') {
          setTruthScanPdfError('TruthScan reported that PDF processing failed. Check the returned details below.');
        }
        // Clear the cached PDF so a re-submit on the same analysis uses the
        // Supabase-backed flow (the correct path for already-submitted jobs).
        pendingPdfBase64.current = null;
        return;
      }

      // ------------------------------------------------------------------ //
      //  STANDARD PATH — for polling an existing job or for analyses where   //
      //  the PDF bytes are no longer in memory (e.g. loaded from history).  //
      // ------------------------------------------------------------------ //
      const session = await getAuthSession();
      if (!session?.access_token) throw new Error('Sign in before submitting a PDF to TruthScan.');

      let jobResponse;
      if (analysis.truthScanPdf?.jobId) {
        setTruthScanPollingPhase('Querying latest TruthScan detector status…');
        jobResponse = await queryTruthScanPdf(analysis.id, session.access_token);
      } else {
        if (!truthScanPdfConsent) {
          throw new Error('Confirm the third-party processing and possible credit charge before submitting this PDF.');
        }
        setTruthScanPollingPhase('Uploading PDF to TruthScan storage & dispatching job…');
        jobResponse = await submitTruthScanPdf(
          analysis.id,
          session.access_token,
          truthScanPdfModules,
          truthScanPdfModel
        );
      }

      let status = storeJob(jobResponse.job);
      if (jobResponse.persistenceStatus === 'failed') {
        setTruthScanPdfError(`TruthScan accepted the file, but the job could not be saved to history. Do not submit it again. Provider job ID: ${jobResponse.job.id}`);
        return;
      }
      if (status === 'failed') {
        setTruthScanPdfError('TruthScan reported that PDF processing failed. Check the returned provider details below.');
      }

      const getPollDelay = (att: number) => {
        if (att < 4) return 800;
        if (att < 12) return 1100;
        if (att < 25) return 1500;
        return 1800;
      };

      for (let attempt = 0; status !== 'done' && status !== 'failed' && attempt < 45; attempt += 1) {
        setTruthScanPollingPhase(`Analyzing with TruthScan AI · check #${attempt + 1}…`);
        await new Promise((resolve) => window.setTimeout(resolve, getPollDelay(attempt)));
        jobResponse = await queryTruthScanPdf(analysis.id, session.access_token);
        status = storeJob(jobResponse.job);
      }
      if (status !== 'done' && status !== 'failed') {
        setTruthScanPdfError('TruthScan is still processing. Use "Check result" to continue polling without resubmitting or spending credits again.');
      }
      if (status === 'failed') {
        setTruthScanPdfError('TruthScan reported that PDF processing failed. Check the returned provider details below.');
      }
      await loadHistory();
    } catch (detectorError) {
      const message = detectorError instanceof Error ? detectorError.message : 'TruthScan PDF screening failed.';
      setTruthScanPdfError(message);
      if (detectorError instanceof TruthScanPdfRequestError && detectorError.submissionStatus) {
        const updated = {
          ...analysis,
          truthScanPdf: {
            status: detectorError.submissionStatus,
            model: truthScanPdfModel,
            modules: truthScanPdfModules,
            error: message,
          },
        };
        setActive((current) => current?.id === analysis.id ? updated : current);
        setHistory((items) => items.map((item) => item.id === analysis.id ? updated : item));
      }
    } finally {
      window.clearInterval(timer);
      setTruthScanPdfBusy(false);
      setTruthScanPollingPhase('');
    }
  };

  const saveTruthScanPdfApiKey = async () => {
    setTruthScanPdfAdminError('');
    setTruthScanPdfAdminMessage('');
    setSavingTruthScanPdfApiKey(true);
    try {
      const session = await getAuthSession().catch(() => null);
      const updated = await updateTruthScanPdfApiKey(session?.access_token, truthScanPdfApiKeyInput);
      setTruthScanPdfAdminConfiguration(updated);
      setTruthScanPdfConfigured(true);
      if (updated.maskedToken) setTruthScanMaskedToken(updated.maskedToken);
      setTruthScanPdfAdminMessage(updated.message || 'TruthScan API key saved and activated.');
      setTruthScanPdfApiKeyInput('');
      setShowTruthScanPdfApiKey(false);
      setShowKeyManager(false);
    } catch (configurationError) {
      setTruthScanPdfAdminError(configurationError instanceof Error
        ? configurationError.message
        : 'Could not update the TruthScan PDF token.');
    } finally {
      setSavingTruthScanPdfApiKey(false);
    }
  };

  const fileDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void analyzeFile(file);
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 pb-16 sm:p-7" style={{ fontFamily: 'var(--font-sans)' }}>
      <header className="relative overflow-hidden rounded-3xl border border-cyan-300/15 bg-gradient-to-br from-slate-950 via-slate-900 to-cyan-950/60 p-6 shadow-2xl shadow-cyan-950/20 sm:p-8">
        <div className="pointer-events-none absolute -right-20 -top-32 h-72 w-72 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-3xl">
            <div className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200">
              <FileSearch className="h-4 w-4" /> Digital Document Forensics
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">Document Revision Archaeologist</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">
              Inspect DOCX and PDF metadata, retained revision traces, package relationships, and embedded content.
              Observations describe file structure—not authenticity or intent.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="rounded-2xl border border-emerald-400/25 bg-emerald-950/40 px-4 py-3 text-xs text-slate-300 backdrop-blur shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-emerald-300 font-semibold">
                  <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span>TruthScan PDF API</span>
                  <span className="rounded bg-emerald-500/20 text-emerald-200 px-1.5 py-0.5 text-[9px] uppercase border border-emerald-400/30 font-medium">Active</span>
                </div>
                <a
                  href="https://truthscan.com/account"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-md bg-cyan-400/15 border border-cyan-400/30 px-2 py-0.5 font-mono text-[10px] font-bold text-cyan-200 hover:text-white"
                >
                  View balance at TruthScan
                </a>
              </div>
              <p className="mt-1 font-mono text-[11px] text-emerald-200/90">{truthScanMaskedToken || 'ts_live_v2_...5a10aa'}</p>
              <div className="mt-1 flex items-center justify-between gap-2 text-[10px]">
                <span className="text-cyan-300/80">⚡ Fast AI Document Screening ready</span>
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-xs text-slate-300 backdrop-blur">
              <div className="flex items-center gap-2 text-cyan-200"><LockKeyhole className="h-4 w-4" /> Private evidence workflow</div>
              <p className="mt-1 max-w-44 text-[11px] leading-5 text-slate-400">Local parsing on server · TruthScan PDF AI Detection enabled by default.</p>
            </div>
          </div>
        </div>
      </header>

      <section className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(260px,0.7fr)]">
        {active ? (
          <div className="relative overflow-hidden rounded-3xl border border-cyan-400/30 bg-gradient-to-br from-slate-900/90 via-slate-950/90 to-cyan-950/40 p-6 shadow-xl sm:p-7">
            <div className="pointer-events-none absolute -right-10 -top-10 h-44 w-44 rounded-full bg-cyan-500/10 blur-2xl" />

            {/* Top row: Uploaded file info & Undertaken by Evidence Badge */}
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-400/30 bg-cyan-400/10 font-bold text-cyan-300 shadow-inner">
                  <FileText className="h-6 w-6" />
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-cyan-500/20 px-2 py-0.5 font-mono text-[10px] font-semibold text-cyan-200 border border-cyan-400/30">
                      {active.format} EVIDENCE
                    </span>
                    <span className="text-xs text-slate-400">
                      {formatBytes(active.fileSize)}
                    </span>
                  </div>
                  <h2 className="mt-0.5 text-base font-semibold text-white break-all max-w-lg" title={active.filename}>
                    {active.filename}
                  </h2>
                </div>
              </div>

              {/* Undertaken by evidence badge */}
              <div className="flex items-center gap-2.5 rounded-xl border border-emerald-400/30 bg-emerald-950/60 px-3.5 py-2 text-xs text-emerald-200 shadow-sm backdrop-blur">
                <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" />
                <div>
                  <div className="font-semibold text-emerald-300 text-[11px] flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Undertaken as Case Evidence
                  </div>
                  <div className="text-[10px] text-emerald-400/80 font-mono">
                    ID: {active.evidenceId ? `${active.evidenceId.slice(0, 18)}…` : 'Registered Intake'}
                  </div>
                </div>
              </div>
            </div>

            {/* Case undertaking & Intake Details Grid */}
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="rounded-xl border border-white/5 bg-black/30 p-3 space-y-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <FolderLock className="h-3.5 w-3.5 text-cyan-300" /> Case Assignment
                </span>
                <p className="text-xs text-slate-200 font-medium truncate">
                  {activeInvestigation ? `${activeInvestigation.caseNumber} · ${activeInvestigation.title}` : `Investigation #${active.investigationId.slice(0, 8)}`}
                </p>
                <p className="text-[10px] text-slate-400">
                  Registered: {new Date(active.uploadedAt).toLocaleString()}
                </p>
              </div>

              <div className="rounded-xl border border-white/5 bg-black/30 p-3 space-y-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <Fingerprint className="h-3.5 w-3.5 text-cyan-300" /> Intake SHA-256 Sealed
                </span>
                <p className="font-mono text-[10px] text-cyan-200 break-all select-all leading-4">
                  {active.sha256}
                </p>
              </div>
            </div>

            {/* Default TruthScan AI status */}
            <div className="mt-3 flex items-center justify-between rounded-xl border border-cyan-400/20 bg-cyan-950/30 px-3 py-2 text-xs text-slate-300">
              <div className="flex items-center gap-2">
                <Zap className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
                <span>TruthScan AI Detection: <strong className="text-cyan-200">Default Active</strong></span>
              </div>
              {active.truthScanPdf?.status ? (
                <span className={`rounded px-2 py-0.5 text-[10px] font-semibold capitalize border ${
                  active.truthScanPdf.status === 'done'
                    ? 'border-emerald-400/30 bg-emerald-500/20 text-emerald-200'
                    : active.truthScanPdf.status === 'failed'
                      ? 'border-rose-400/30 bg-rose-500/20 text-rose-200'
                      : 'border-cyan-400/30 bg-cyan-500/20 text-cyan-200 animate-pulse'
                }`}>
                  {active.truthScanPdf.status}
                </span>
              ) : (
                <span className="text-[10px] text-cyan-300 font-medium">Ready</span>
              )}
            </div>

            {/* Evidence custody integrity footer (without choose upload button) */}
            <div className="mt-4 flex items-center justify-between pt-1 border-t border-white/5 text-[11px]">
              <div className="text-slate-400 flex items-center gap-1.5 text-[10px]">
                <LockKeyhole className="h-3 w-3 text-cyan-400" />
                Unmodified evidence preserved in private custody vault.
              </div>
              <button
                type="button"
                onClick={() => setActive(null)}
                className="text-[10px] font-semibold text-slate-400 hover:text-cyan-200 underline decoration-slate-600 transition"
              >
                Intake new document
              </button>
            </div>

            {stage && <p role="status" className="mt-3 flex items-center justify-center gap-2 text-xs text-cyan-100"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />{stage}</p>}
            {error && <p role="alert" className="mt-3 rounded-xl border border-rose-300/20 bg-rose-400/10 p-3 text-left text-xs leading-5 text-rose-100">{error}</p>}
          </div>
        ) : (
          <div
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={fileDrop}
            onClick={() => fileInput.current?.click()}
            className={`cursor-pointer rounded-3xl border border-dashed p-6 text-center transition-colors sm:p-8 ${dragging ? 'border-cyan-300 bg-cyan-300/10' : 'border-cyan-300/25 bg-slate-900/45 hover:border-cyan-400/40'}`}
          >
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-cyan-200/20 bg-cyan-300/10 text-cyan-200">
              {busy ? <LoaderCircle className="h-7 w-7 animate-spin" /> : <UploadCloud className="h-7 w-7" />}
            </div>
            <h2 className="text-lg font-semibold text-slate-100">{busy ? 'Analysis in progress' : 'Add document evidence'}</h2>
            <p className="mx-auto mt-2 max-w-lg text-xs leading-5 text-slate-400">
              Drop a .docx or .pdf file here to register as evidence. The unmodified original is recorded in the case and analyzed with TruthScan AI by default.
            </p>
            {!supabaseSignedIn && (
              <div className="mx-auto mt-4 max-w-xl rounded-xl border border-amber-300/20 bg-amber-300/5 p-3 text-left" onClick={(e) => e.stopPropagation()}>
                <p className="text-xs leading-5 text-amber-100">Sign in to Supabase before adding evidence or viewing your saved document analysis history.</p>
                <button
                  type="button"
                  onClick={onRequestSignIn}
                  className="mt-2 rounded-lg border border-amber-200/20 px-3 py-1.5 text-[11px] font-semibold text-amber-100 hover:bg-amber-200/10"
                >
                  Sign in to Supabase
                </button>
              </div>
            )}
            <label className="mx-auto mt-5 block max-w-sm text-left text-[10px] font-semibold uppercase tracking-wider text-slate-400" onClick={(e) => e.stopPropagation()}>
              Investigation
              <select
                value={caseId}
                onChange={(event) => setCaseId(event.target.value)}
                disabled={busy || !supabaseSignedIn || investigations.length === 0}
                className="mt-1.5 w-full rounded-xl border border-white/10 bg-slate-950/80 px-3 py-2.5 text-sm normal-case tracking-normal text-slate-100 outline-none focus:border-cyan-300/50"
              >
                {investigations.length === 0 && <option value="">No investigations available</option>}
                {investigations.map((item) => (
                  <option key={item.id} value={item.id}>{item.caseNumber} · {item.title}</option>
                ))}
              </select>
            </label>
            <input
              ref={fileInput}
              className="sr-only"
              type="file"
              accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void analyzeFile(file);
                event.target.value = '';
              }}
            />
            <div className="mx-auto mt-4 max-w-sm rounded-xl border border-cyan-400/20 bg-cyan-950/30 p-2.5 text-left" onClick={(e) => e.stopPropagation()}>
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoRunTruthScanOnPdf}
                  onChange={(event) => setAutoRunTruthScanOnPdf(event.target.checked)}
                  className="rounded border-cyan-400/50 bg-slate-950 text-cyan-400 focus:ring-0"
                />
                <span className="text-xs font-medium text-cyan-100 flex items-center gap-1.5">
                  <Zap className="h-3.5 w-3.5 text-cyan-400" /> Auto-run TruthScan AI detection on PDF (Default)
                </span>
              </label>
            </div>
            <div className="mt-3 text-[10px] text-slate-500">Maximum file size: {formatBytes(MAX_FILE_BYTES)} · Drop file or click to select</div>
            {stage && <p role="status" className="mt-4 flex items-center justify-center gap-2 text-xs text-cyan-100"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />{stage}</p>}
            {error && <p role="alert" className="mx-auto mt-4 max-w-xl rounded-xl border border-rose-300/20 bg-rose-400/10 p-3 text-left text-xs leading-5 text-rose-100">{error}</p>}
          </div>
        )}

        <DetailCard title="Examination controls">
          <div className="space-y-3 text-xs leading-5 text-slate-300">
            <p className="flex gap-2"><Fingerprint className="mt-0.5 h-4 w-4 shrink-0 text-cyan-200" />Stored original SHA-256 is recalculated and compared before parsing.</p>
            <p className="flex gap-2"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-cyan-200" />DOCX ZIP expansion, entry count, entry size, and file size are bounded.</p>
            <p className="flex gap-2"><FileArchive className="mt-0.5 h-4 w-4 shrink-0 text-cyan-200" />Embedded payloads and active content are detected only; they are not opened or executed.</p>
            <p className="flex gap-2"><Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-cyan-200" />No claim is made that retained revisions represent the complete editing history.</p>
          </div>

          <div className="mt-4 rounded-xl border border-cyan-400/25 bg-cyan-950/40 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-cyan-200 flex items-center gap-1.5">
                <Zap className="h-3.5 w-3.5 text-cyan-400" /> TruthScan PDF AI Detector
              </span>
              <span className="rounded bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 text-[9px] font-semibold border border-emerald-400/30">
                Key Active
              </span>
            </div>
            <p className="text-[10px] text-slate-300 leading-4">
              AI revision &amp; forgery detector configured with live TruthScan credentials.
            </p>
            <div className="flex items-center justify-between text-[11px] pt-1">
              <span className="font-mono text-cyan-300/90 text-[10px]">{truthScanMaskedToken || 'ts_live_v2_...5a10aa'}</span>
              <button
                type="button"
                onClick={() => setShowKeyManager((v) => !v)}
                className="text-[10px] font-semibold text-cyan-300 hover:text-white underline decoration-cyan-400/40"
              >
                {showKeyManager ? 'Close key settings' : 'Update API key'}
              </button>
            </div>

            {/* ── Credits widget ── */}
            <div className="mt-1 rounded-lg border border-white/[0.06] bg-black/30 px-2.5 py-2 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">PDF credit balance</span>
                  <a
                    href="https://truthscan.com/account"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[9px] text-cyan-300 hover:text-white"
                  >
                    Check at TruthScan ↗
                  </a>
                </div>
                <p className="text-[10px] leading-4 text-slate-400">
                  TruthScan’s PDF API does not provide an account balance. The lab shows credits deducted when a scan reports them.
                </p>
              </div>

            {showKeyManager && (
              <div className="mt-2 space-y-2 rounded-lg border border-white/10 bg-slate-950/90 p-2.5">
                <input
                  type={showTruthScanPdfApiKey ? 'text' : 'password'}
                  value={truthScanPdfApiKeyInput}
                  onChange={(e) => setTruthScanPdfApiKeyInput(e.target.value)}
                  placeholder="Enter TruthScan API token (ts_live_...)"
                  className="w-full rounded border border-white/10 bg-slate-900 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-600"
                />
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setShowTruthScanPdfApiKey((v) => !v)}
                    className="text-[10px] text-slate-400 hover:text-slate-200"
                  >
                    {showTruthScanPdfApiKey ? 'Hide' : 'Show'}
                  </button>
                  <button
                    type="button"
                    disabled={savingTruthScanPdfApiKey || truthScanPdfApiKeyInput.trim().length < 16}
                    onClick={() => void saveTruthScanPdfApiKey()}
                    className="rounded bg-cyan-500/20 border border-cyan-400/30 px-3 py-1 text-[10px] font-semibold text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-40"
                  >
                    {savingTruthScanPdfApiKey ? 'Saving…' : 'Save & Activate'}
                  </button>
                </div>
                {truthScanPdfAdminMessage && <p className="text-[10px] text-emerald-300">{truthScanPdfAdminMessage}</p>}
                {truthScanPdfAdminError && <p className="text-[10px] text-rose-300">{truthScanPdfAdminError}</p>}
              </div>
            )}
          </div>

          <button type="button" onClick={() => void loadHistory()} className="mt-4 inline-flex items-center gap-2 text-[11px] text-slate-400 hover:text-cyan-100">
            <RefreshCw className="h-3.5 w-3.5" /> Refresh saved analysis history
          </button>
          {historyError && <p role="status" className="mt-2 text-[11px] leading-5 text-amber-200">{historyError}</p>}
        </DetailCard>
      </section>

      {active && (
        <div className="space-y-5">
          <section className="rounded-2xl border border-white/10 bg-slate-950/55 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="break-all text-base font-semibold text-white">{active.filename}</h2>
                  <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${statusStyles(active.status)}`}>{statusLabel(active.status)}</span>
                </div>
                <p className="mt-1 text-[11px] text-slate-400">{active.format} · {formatBytes(active.fileSize)} · evidence ID {active.evidenceId}</p>
              </div>
              <button
                type="button"
                onClick={() => void downloadReport(active)}
                disabled={downloading === active.id || active.status === 'rejected'}
                className="inline-flex items-center gap-2 rounded-xl border border-cyan-200/25 bg-cyan-300/10 px-3.5 py-2 text-xs font-semibold text-cyan-100 hover:bg-cyan-300/15 disabled:opacity-50"
              >
                {downloading === active.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {active.reportStoragePath ? 'Download saved report' : 'Generate & save report'}
              </button>
            </div>
            <div className="mt-4 grid gap-2 md:grid-cols-3">
              <div className="rounded-xl border border-white/5 bg-white/[0.025] p-3">
                <span className="text-[9px] uppercase tracking-wider text-slate-500">SHA-256</span>
                <p className="mt-1 break-all font-mono text-[10px] text-cyan-100">{active.sha256}</p>
              </div>
              <div className="rounded-xl border border-white/5 bg-white/[0.025] p-3">
                <span className="text-[9px] uppercase tracking-wider text-slate-500">Uploaded</span>
                <p className="mt-1 text-[11px] text-slate-200">{new Date(active.uploadedAt).toLocaleString()}</p>
              </div>
              <div className="rounded-xl border border-white/5 bg-white/[0.025] p-3">
                <span className="text-[9px] uppercase tracking-wider text-slate-500">Analyzed</span>
                <p className="mt-1 text-[11px] text-slate-200">{new Date(active.analyzedAt).toLocaleString()}</p>
              </div>
            </div>
            {active.errors.length > 0 && <p role="alert" className="mt-3 rounded-xl border border-rose-300/20 bg-rose-400/10 p-3 text-xs leading-5 text-rose-100">{active.errors.join(' ')}</p>}
          </section>

          <section className="grid gap-4 xl:grid-cols-2">
            <DetailCard title="Metadata explorer">
              {Object.keys(active.properties).length ? (
                <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                  {Object.entries(active.properties).map(([key, value]) => (
                    <div key={key} className="min-w-0 border-b border-white/5 pb-2">
                      <dt className="text-[9px] uppercase tracking-wider text-slate-500">{key}</dt>
                      <dd className="mt-1 break-words text-[11px] leading-5 text-slate-200">{value === null || value === '' ? <span className="text-slate-500">Unavailable</span> : String(value)}</dd>
                    </div>
                  ))}
                </dl>
              ) : <p className="text-xs text-slate-400">Metadata could not be extracted from this file.</p>}
              {active.missingMetadata.length > 0 && (
                <div className="mt-4 rounded-xl border border-white/5 bg-white/[0.025] p-3">
                  <p className="mb-2 text-[9px] uppercase tracking-wider text-slate-500">Unavailable metadata</p>
                  <div className="flex flex-wrap gap-1.5">{active.missingMetadata.map((field) => <span key={field} className="rounded-full bg-slate-800 px-2 py-1 text-[10px] text-slate-300">{field}</span>)}</div>
                </div>
              )}
            </DetailCard>

            <DetailCard title="Revision timeline">
              {Array.isArray(active.structure.revisions) && active.structure.revisions.length ? (
                <ol className="max-h-72 space-y-2 overflow-auto">
                  {(active.structure.revisions as Array<{ type: string; id: string | null; author: string | null; date: string | null; part: string }>).map((revision, index) => (
                    <li key={`${revision.part}-${revision.type}-${revision.id}-${index}`} className="flex gap-3 border-l border-cyan-300/25 pl-3">
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-200" />
                      <div className="min-w-0 text-[11px] leading-5 text-slate-300">
                        <span className="font-semibold text-slate-100">{revision.type}</span>
                        <span className="text-slate-500"> · {revision.part}</span>
                        <div className="break-all text-slate-400">ID {revision.id || 'Unavailable'} · author {revision.author || 'Unavailable'} · date {revision.date || 'Unavailable'}</div>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : <p className="text-xs text-slate-400">No retained DOCX revision elements were observed. This does not establish that no edits occurred.</p>}
              {typeof active.structure.revisionCounts === 'object' && active.structure.revisionCounts !== null && <pre className="mt-3 overflow-auto rounded-lg bg-black/20 p-2 text-[10px] text-slate-400">{JSON.stringify(active.structure.revisionCounts, null, 2)}</pre>}
              {Array.isArray(active.structure.comments) && <p className="mt-2 text-[11px] text-slate-400">{active.structure.comments.length} comment record(s) found.</p>}
              {typeof active.structure.previousXrefReferences === 'number' && <p className="mt-2 text-[11px] text-slate-400">{active.structure.previousXrefReferences} raw /Prev reference(s); see PDF structure inspection and limitations.</p>}
            </DetailCard>

            <DetailCard title={active.format === 'DOCX' ? 'DOCX package inspector' : 'PDF structure inspector'}>
              <div className="space-y-3">
                {Object.entries(active.structure).filter(([key]) => !['revisions', 'comments', 'packageParts', 'pageDimensions'].includes(key)).map(([key, value]) => (
                  <div key={key} className="border-b border-white/5 pb-2">
                    <div className="text-[9px] uppercase tracking-wider text-slate-500">{key}</div>
                    <div className="mt-1 break-words text-[11px] leading-5 text-slate-300">{Array.isArray(value) || typeof value === 'object' ? JSON.stringify(value) : String(value)}</div>
                  </div>
                ))}
                {Array.isArray(active.structure.packageParts) && (
                  <details className="rounded-lg border border-white/5 bg-black/10 p-2">
                    <summary className="cursor-pointer text-[10px] text-cyan-100">Package entries ({active.structure.packageParts.length})</summary>
                    <ul className="mt-2 max-h-48 space-y-1 overflow-auto font-mono text-[10px] text-slate-400">
                      {(active.structure.packageParts as Array<{ path: string; sizeBytes: number | null }>).map((part) => <li key={part.path} className="break-all">{part.path} · {part.sizeBytes ?? 'unavailable'} bytes</li>)}
                    </ul>
                  </details>
                )}
              </div>
            </DetailCard>

            <DetailCard title="Embedded objects & linked resources">
              <div className="space-y-2">
                {active.findings.filter((item) => ['embedded_content', 'relationships', 'external_reference', 'active_content'].includes(item.category)).length === 0
                  ? <p className="text-xs text-slate-400">No embedded objects or linked-resource indicators were observed by the current parser.</p>
                  : active.findings.filter((item) => ['embedded_content', 'relationships', 'external_reference', 'active_content'].includes(item.category)).map((item) => (
                    <div key={item.id} className="rounded-xl border border-amber-200/10 bg-amber-100/[0.03] p-3">
                      <p className="text-xs font-semibold text-slate-100">{item.title}</p>
                      <p className="mt-1 text-[11px] leading-5 text-slate-300">{item.observation}</p>
                      <p className="mt-1 break-all text-[10px] text-slate-500">{item.source}</p>
                    </div>
                  ))}
              </div>
            </DetailCard>

            <DetailCard title="Inconsistency matrix">
              {active.inconsistencies.length === 0
                ? <p className="text-xs text-slate-400">No comparable value pairs were available.</p>
                : <div className="space-y-3">{active.inconsistencies.map((item) => (
                  <div key={item.id} className="rounded-xl border border-white/5 bg-white/[0.025] p-3">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-xs font-semibold text-slate-100">{item.label}</p>
                      <span className="shrink-0 rounded-full bg-slate-800 px-2 py-1 text-[9px] uppercase text-slate-300">{item.status === 'differ' ? 'Inconsistent' : item.status === 'agree' ? 'Observed' : 'Not comparable'}</span>
                    </div>
                    {item.observations.map((observation) => <p key={observation.source} className="mt-1 break-words text-[10px] text-slate-400">{observation.source}: {observation.value}</p>)}
                    <p className="mt-2 text-[10px] leading-4 text-slate-500">Possible explanation: {item.benignExplanations.join(' ') || 'No alternative explanation was established.'}</p>
                    <p className="mt-1 text-[10px] text-cyan-100/80">Next step: {item.recommendedAction}</p>
                  </div>
                ))}</div>}
            </DetailCard>

            <DetailCard title="Evidence findings">
              {active.findings.length === 0
                ? <p className="text-xs text-slate-400">No rule-based findings were triggered. This is not a determination that the document is authentic.</p>
                : <div className="space-y-3">{active.findings.map((item) => (
                  <article key={item.id} className="rounded-xl border border-white/5 bg-white/[0.025] p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-slate-800 px-2 py-1 text-[9px] uppercase text-cyan-100">{item.severity}</span>
                      <span className="text-[9px] uppercase text-slate-500">{item.category}</span>
                      <span className="ml-auto text-[9px] text-slate-500">Confidence {item.confidence.level}</span>
                    </div>
                    <h3 className="mt-2 text-xs font-semibold text-slate-100">{item.title}</h3>
                    <p className="mt-1 text-[11px] leading-5 text-slate-300">{item.observation}</p>
                    <p className="mt-2 break-all text-[10px] text-cyan-100/80">Source: {item.source}</p>
                    <p className="mt-2 text-[10px] leading-4 text-slate-500">{item.technicalExplanation} {item.limitations.join(' ')}</p>
                    <p className="mt-1 text-[10px] text-slate-400">Alternative explanations: {item.benignExplanations.join(' ') || 'No specific alternative explanation was identified.'}</p>
                    <p className="mt-1 text-[10px] text-cyan-100/80">Recommended follow-up: {item.recommendedAction}</p>
                  </article>
                ))}</div>}
            </DetailCard>

            <DetailCard title="Investigation summary">
              <div className="flex gap-3 rounded-xl border border-cyan-200/10 bg-cyan-100/[0.025] p-3">
                {active.status === 'parsed' ? <BadgeCheck className="h-5 w-5 shrink-0 text-cyan-200" /> : <AlertTriangle className="h-5 w-5 shrink-0 text-amber-200" />}
                <p className="text-xs leading-5 text-slate-300">
                  {active.status === 'rejected'
                    ? 'The file was registered as evidence, but its structure could not be safely parsed. No metadata or authenticity conclusion is available.'
                    : `${active.findings.length} evidence-backed observation(s), ${active.inconsistencies.length} metadata comparison(s), and ${active.missingMetadata.length} unavailable metadata field(s) were recorded. These observations do not independently establish forgery, authorship, or authenticity.`}
                </p>
              </div>
              {active.limitations.map((item) => <p key={item} className="mt-2 text-[10px] leading-4 text-slate-500">• {item}</p>)}
            </DetailCard>

            {active.format === 'PDF' && active.status !== 'rejected' && (
              <DetailCard title="TruthScan PDF AI Detection (Default)">
                <div className="space-y-3 text-xs leading-5 text-slate-300">
                  <p>
                    {truthScanPdfConfigured === true
                      ? 'The server-side TruthScan PDF key is configured.'
                      : truthScanPdfConfigured === false
                        ? 'Not configured. Set TRUTHSCAN_PDF_API_KEY in the server .env and restart the API server.'
                        : 'Checking server configuration…'}
                  </p>
                  {isAdministrator && supabaseSignedIn && (
                    <div className="space-y-2 rounded-lg border border-violet-200/10 bg-violet-300/[0.035] p-3">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-violet-100">Administrator API token settings</p>
                      <p className="text-[10px] text-slate-400">
                        Current token: {truthScanPdfAdminConfiguration?.maskedToken || 'not configured'}
                        {truthScanPdfAdminConfiguration?.source === 'runtime'
                          ? ' · changed in this server session'
                          : truthScanPdfAdminConfiguration?.source === 'environment'
                            ? ' · server environment'
                            : ''}
                      </p>
                      <p className="text-[10px] leading-4 text-slate-400">
                        For safety, the full saved token cannot be retrieved or displayed. Enter a replacement below; “Show token” only reveals what you are typing. Runtime replacements reset when the server restarts.
                      </p>
                      <div className="flex gap-2">
                        <input
                          type={showTruthScanPdfApiKey ? 'text' : 'password'}
                          autoComplete="new-password"
                          value={truthScanPdfApiKeyInput}
                          onChange={(event) => setTruthScanPdfApiKeyInput(event.target.value)}
                          placeholder="Enter a replacement TruthScan API token"
                          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950/80 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600"
                        />
                        <button
                          type="button"
                          onClick={() => setShowTruthScanPdfApiKey((show) => !show)}
                          aria-label={showTruthScanPdfApiKey ? 'Hide entered API token' : 'Show entered API token'}
                          className="rounded-lg border border-white/10 px-2 text-slate-300 hover:text-white"
                        >
                          {showTruthScanPdfApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                      <button
                        type="button"
                        disabled={savingTruthScanPdfApiKey || truthScanPdfApiKeyInput.trim().length < 16}
                        onClick={() => void saveTruthScanPdfApiKey()}
                        className="rounded-lg border border-violet-200/20 bg-violet-300/10 px-3 py-1.5 text-[10px] font-semibold text-violet-100 disabled:opacity-50"
                      >
                        {savingTruthScanPdfApiKey ? 'Saving…' : 'Replace API token'}
                      </button>
                      {truthScanPdfAdminError && <p role="alert" className="text-[10px] text-rose-200">{truthScanPdfAdminError}</p>}
                      {truthScanPdfAdminMessage && <p role="status" className="text-[10px] text-emerald-200">{truthScanPdfAdminMessage}</p>}
                    </div>
                  )}
                  <p className="rounded-lg border border-cyan-400/20 bg-cyan-950/30 p-2.5 text-[11px] text-cyan-100/90 leading-5">
                    TruthScan PDF AI Detection is <strong>active by default</strong>. It scans for generative tampering, ChatGPT &amp; LLM writing anomalies, invisible objects, and multi-revision PDF changes.
                  </p>
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-cyan-400/25 bg-cyan-950/40 px-3 py-2 text-xs">
                      <div className="flex items-center gap-2">
                        <Zap className="h-3.5 w-3.5 text-cyan-400" />
                        <span className="font-semibold text-cyan-200">
                          PDF balance is available in your TruthScan account
                        </span>
                      </div>
                      <a
                        href="https://truthscan.com/account"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] text-cyan-300 hover:text-white"
                      >
                        Open account ↗
                      </a>
                  </div>
                  {active.truthScanPdf?.jobId ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/5 bg-white/[0.025] p-3">
                      <span className="break-all">
                        Job {active.truthScanPdf.status} · ID {active.truthScanPdf.jobId}
                        {active.truthScanPdf.creditsDeducted !== undefined
                          ? ` · ${active.truthScanPdf.creditsDeducted.toLocaleString()} credits deducted`
                          : ''}
                      </span>
                      {['pending', 'processing'].includes(active.truthScanPdf.status) && (
                        <button
                          type="button"
                          disabled={truthScanPdfBusy}
                          onClick={() => void runTruthScanPdf(active)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-200/20 px-3 py-1.5 text-[10px] font-semibold text-cyan-100 hover:bg-cyan-950/40 disabled:opacity-50"
                        >
                          {truthScanPdfBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                          {truthScanPdfBusy ? `Checking (${truthScanElapsedSeconds}s)…` : 'Check result now'}
                        </button>
                      )}
                    </div>
                  ) : active.truthScanPdf?.status === 'uploading' ? (
                    <p role="status" className="rounded-lg border border-amber-300/15 bg-amber-300/5 p-3 text-amber-100">
                      Submission status is unknown. Do not retry, since a provider job may have been accepted. Contact an administrator to reconcile this submission.
                    </p>
                  ) : active.truthScanPdf?.status === 'failed' ? (
                    <p role="status" className="rounded-lg border border-rose-300/15 bg-rose-300/5 p-3 text-rose-100">
                      {active.truthScanPdf.error || 'The submission could not be completed. Create a new local analysis before retrying.'}
                    </p>
                  ) : (
                    <>
                      <div className="space-y-1.5">
                        <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                          Detection Speed & Scope
                        </span>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => setTruthScanPdfModules(['metadata'])}
                            className={`flex flex-col items-start p-2.5 rounded-lg border text-left transition-all ${
                              truthScanPdfModules.length === 1 && truthScanPdfModules[0] === 'metadata'
                                ? 'border-cyan-400/50 bg-cyan-950/40 text-cyan-100 shadow-sm'
                                : 'border-white/10 bg-white/[0.02] text-slate-400 hover:text-slate-200 hover:border-white/20'
                            }`}
                          >
                            <div className="flex items-center gap-1.5 text-xs font-semibold text-cyan-300">
                              <Zap className="h-3.5 w-3.5" />
                              <span>Ultra-Fast Scan (Metadata Only)</span>
                            </div>
                            <span className="mt-1 text-[10px] leading-4 text-slate-400">
                              ⚡ Fast results (~2–5s). Checks ChatGPT & AI generation fingerprints immediately.
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setTruthScanPdfModules(['metadata', 'structure'])}
                            className={`flex flex-col items-start p-2.5 rounded-lg border text-left transition-all ${
                              truthScanPdfModules.length === 2
                                ? 'border-violet-400/50 bg-violet-950/40 text-violet-100 shadow-sm'
                                : 'border-white/10 bg-white/[0.02] text-slate-400 hover:text-slate-200 hover:border-white/20'
                            }`}
                          >
                            <div className="flex items-center gap-1.5 text-xs font-semibold text-violet-300">
                              <FileSearch className="h-3.5 w-3.5" />
                              <span>Full Forensic Scan (All Modules)</span>
                            </div>
                            <span className="mt-1 text-[10px] leading-4 text-slate-400">
                              🔬 Deep scan (~15–25s). Includes hidden text, invisible layers & AST structure.
                            </span>
                          </button>
                        </div>
                      </div>

                      <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                        Detector model
                        <select
                          value={truthScanPdfModel}
                          onChange={(event) => setTruthScanPdfModel(event.target.value as TruthScanPdfModel)}
                          className="mt-1 block w-full rounded-lg border border-white/10 bg-slate-950/80 px-3 py-2 text-xs normal-case tracking-normal text-slate-100"
                        >
                          <option value="pdf_detector">Latest (pdf_detector/v5)</option>
                          <option value="pdf_detector/v1">pdf_detector/v1</option>
                          <option value="pdf_detector/v3">pdf_detector/v3</option>
                          <option value="pdf_detector/v4">pdf_detector/v4</option>
                          <option value="pdf_detector/v5">pdf_detector/v5</option>
                        </select>
                      </label>
                      <div className="flex flex-wrap gap-4 text-[11px]">
                        {(['metadata', 'structure'] as const).map((module) => (
                          <label key={module} className="flex items-center gap-2 capitalize">
                            <input
                              type="checkbox"
                              checked={truthScanPdfModules.includes(module)}
                              onChange={(event) => setTruthScanPdfModules((current) =>
                                event.target.checked
                                  ? [...current, module]
                                  : current.filter((entry) => entry !== module)
                              )}
                            />
                            {module} module {module === 'metadata' ? '(fast AI fingerprinting)' : '(structural integrity)'}
                          </label>
                        ))}
                      </div>
                      <label className="flex items-start gap-2 rounded-lg border border-white/10 bg-white/[0.025] p-3 text-[11px]">
                        <input
                          type="checkbox"
                          checked={truthScanPdfConsent}
                          onChange={(event) => setTruthScanPdfConsent(event.target.checked)}
                          className="mt-1 rounded border-cyan-400/50 bg-slate-950 text-cyan-400"
                        />
                        <span>TruthScan PDF AI screening authorization active (Default). Provider deducts credits per scan.</span>
                      </label>
                      <button
                        type="button"
                        disabled={truthScanPdfBusy || truthScanPdfConfigured !== true || !truthScanPdfConsent || truthScanPdfModules.length === 0}
                        onClick={() => void runTruthScanPdf(active)}
                        className="inline-flex items-center gap-2 rounded-xl border border-cyan-300/30 bg-cyan-400/10 px-4 py-2.5 text-xs font-semibold text-cyan-100 hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {truthScanPdfBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FileSearch className="h-4 w-4 text-cyan-300" />}
                        {truthScanPdfBusy ? 'TruthScan AI scanning…' : 'Run TruthScan AI Detection'}
                      </button>
                    </>
                  )}
                  {truthScanPdfBusy && (
                    <div className="rounded-xl border border-cyan-400/25 bg-cyan-950/40 p-3.5 space-y-2.5 shadow-lg">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-xs font-medium text-cyan-200">
                          <LoaderCircle className="h-4 w-4 animate-spin text-cyan-400" />
                          <span>{truthScanPollingPhase || 'Contacting TruthScan...'}</span>
                        </div>
                        <span className="flex items-center gap-1 text-[11px] font-mono text-cyan-300 bg-cyan-900/50 px-2.5 py-0.5 rounded-full border border-cyan-400/30">
                          <Clock3 className="h-3 w-3" />
                          {truthScanElapsedSeconds}s elapsed
                        </span>
                      </div>
                      <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-cyan-400 via-sky-400 to-violet-500 rounded-full animate-pulse w-full" />
                      </div>
                      <p className="text-[10px] text-slate-400">
                        ⚡ High-frequency adaptive polling active: querying TruthScan at ~1s intervals to capture completion instantly.
                      </p>
                    </div>
                  )}
                  {truthScanPdfError && <p role="alert" className="rounded-lg border border-rose-300/20 bg-rose-400/10 p-3 text-[11px] text-rose-100">{truthScanPdfError}</p>}
                  {active.truthScanPdf?.result && (
                    <TruthScanPdfResultView result={active.truthScanPdf.result as Record<string, any>} />
                  )}
                </div>
              </DetailCard>
            )}
          </section>
        </div>
      )}

      <DetailCard title="Document analysis history">
        {history.length === 0
          ? <p className="text-xs text-slate-400">{historyError ? 'Saved reports could not be loaded.' : 'No saved document analyses are available for this account.'}</p>
          : <ul className="divide-y divide-white/5">{history.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <button type="button" onClick={() => setActive(item)} className="min-w-0 flex-1 text-left hover:text-cyan-100">
                <span className="block truncate text-xs font-medium text-slate-100">{item.filename}</span>
                <span className="mt-1 block text-[10px] text-slate-500">{item.format} · {item.sha256.slice(0, 16)}… · {new Date(item.analyzedAt).toLocaleString()}</span>
              </button>
              <div className="flex items-center gap-2">
                <span className={`rounded-full border px-2 py-1 text-[9px] uppercase ${statusStyles(item.status)}`}>{statusLabel(item.status)}</span>
                {item.reportStoragePath
                  ? <button type="button" title="Download saved report" onClick={() => void downloadReport(item)} className="rounded-lg border border-white/10 p-2 text-slate-300 hover:border-cyan-200/30 hover:text-cyan-100"><Download className="h-4 w-4" /></button>
                  : <button type="button" title="Generate report" onClick={() => void downloadReport(item)} disabled={item.status === 'rejected'} className="rounded-lg border border-white/10 p-2 text-slate-300 hover:border-cyan-200/30 hover:text-cyan-100 disabled:opacity-40"><FileText className="h-4 w-4" /></button>}
                <a href={`/workspaces/evidence-room`} title="Evidence Room" className="rounded-lg border border-white/10 p-2 text-slate-400 hover:text-cyan-100"><ArrowUpRight className="h-4 w-4" /></a>
              </div>
            </li>
          ))}</ul>}
      </DetailCard>
      <p className="text-center text-[10px] leading-5 text-slate-500">{DISCLAIMER}</p>
    </div>
  );
};
