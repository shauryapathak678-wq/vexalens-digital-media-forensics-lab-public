import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  FileCheck2,
  FileText,
  Mail,
  Plus,
  Play,
  Printer,
  ShieldAlert,
  UploadCloud,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { EvidenceItem, Investigation, UserProfile } from '@/types/forensics';
import type { EmailFieldComparison, EmailVerificationRecord, EmailVerifierResult } from '@/types/emailVerifier';
import { getAuthSession, onAuthStateChange } from '@/lib/supabase';
import { calculateEvidenceHashes } from '@/lib/forensics/crypto';
import { generateEmailVerifierReport } from '@/lib/forensics/emailVerifierReport';
import {
  syncCheckEmailVerifierSchema,
  syncFetchEmailVerifications,
  syncSaveEmailVerification,
  syncUpdateEmailVerification,
} from '@/lib/supabase-sync';

const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;
const MAX_EML_BYTES = 20 * 1024 * 1024;
const MAX_COMBINED_BYTES = 40 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const EMAIL_SIMULATOR_FIELDS = [
  { field: 'From', screenshot: 'security@example.test', original: 'security@example.test' },
  { field: 'To', screenshot: 'reviewer@example.test', original: 'reviewer@example.test' },
  { field: 'Subject', screenshot: 'Account activity notice — verify now', original: 'Account activity notice' },
  { field: 'Date', screenshot: '25 Nov 2025, 09:00 UTC', original: '25 Nov 2025, 09:00 UTC' },
] as const;
const EMAIL_SIMULATOR_EML = `From: Example Security <security@example.test>
To: Reviewer <reviewer@example.test>
Subject: Account activity notice
Date: Tue, 25 Nov 2025 09:00:00 +0000
Message-ID: <demo-001@example.test>
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8

This synthetic message exists only for the VexaLens email-verifier simulator.`;

const EMAIL_VERIFIER_MIGRATION_SQL = `-- Apply in Supabase Dashboard -> SQL Editor:
alter table public.evidence_items
  drop constraint if exists evidence_items_media_type_check;

alter table public.evidence_items
  add constraint evidence_items_media_type_check
  check (media_type in ('image', 'video', 'audio', 'document', 'other'));

alter table public.evidence_items
  add column if not exists item_tag uuid not null default gen_random_uuid(),
  add column if not exists md5_hash text;

create table if not exists public.email_verifications (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  screenshot_evidence_id uuid references public.evidence_items(id) on delete set null,
  eml_evidence_id uuid references public.evidence_items(id) on delete set null,
  report_evidence_id uuid references public.evidence_items(id) on delete set null,
  screenshot_sha256 text,
  eml_sha256 text,
  report_sha256 text,
  result_snapshot jsonb not null,
  investigator_notes text not null default '',
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint email_verifications_screenshot_hash_check
    check (screenshot_sha256 is null or screenshot_sha256 ~ '^[a-f0-9]{64}$'),
  constraint email_verifications_eml_hash_check
    check (eml_sha256 is null or eml_sha256 ~ '^[a-f0-9]{64}$'),
  constraint email_verifications_report_hash_check
    check (report_sha256 is null or report_sha256 ~ '^[a-f0-9]{64}$'),
  constraint email_verifications_has_evidence_check
    check (screenshot_evidence_id is not null or eml_evidence_id is not null)
);

create index if not exists email_verifications_investigation_created_idx
  on public.email_verifications (investigation_id, created_at desc);

alter table public.email_verifications enable row level security;

create policy "Users manage own email verifications"
  on public.email_verifications
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.investigations
      where investigations.id = email_verifications.investigation_id
        and investigations.user_id = auth.uid()
    )
  );

grant select, insert, update, delete on public.email_verifications to authenticated;
`;

interface EmailVerifierViewProps {
  investigations: Investigation[];
  currentCase?: Investigation;
  user: UserProfile;
  evidenceList: EvidenceItem[];
  onCreateCase: (data: Omit<Investigation, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Investigation>;
  onRequestSignIn: () => void;
  onAddEvidence: (
    item: Omit<EvidenceItem, 'id' | 'createdAt'>,
    file: File | Blob,
    hashesPromise?: Promise<{ sha256: string; md5: string }>
  ) => Promise<EvidenceItem>;
}

function getFileMime(file: File): string {
  if (file.type) return file.type;
  if (file.name.toLowerCase().endsWith('.eml')) return 'message/rfc822';
  if (file.name.toLowerCase().endsWith('.msg')) return 'application/vnd.ms-outlook';
  return '';
}

async function validateFile(file: File, kind: 'screenshot' | 'email'): Promise<void> {
  if (kind === 'screenshot') {
    const validName = /\.(png|jpe?g|webp)$/i.test(file.name);
    if (!validName || (file.type && !IMAGE_TYPES.has(file.type))) {
      throw new Error(`${file.name}: select a PNG, JPG, JPEG, or WEBP screenshot.`);
    }
    if (file.size === 0 || file.size > MAX_SCREENSHOT_BYTES) {
      throw new Error(`${file.name}: screenshot must be between 1 byte and 25 MB.`);
    }
    const signature = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const png = signature.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => signature[i] === byte);
    const jpeg = signature[0] === 255 && signature[1] === 216 && signature[2] === 255;
    const webp = signature.length >= 12
      && String.fromCharCode(...signature.slice(0, 4)) === 'RIFF'
      && String.fromCharCode(...signature.slice(8, 12)) === 'WEBP';
    if (!png && !jpeg && !webp) throw new Error(`${file.name}: the file contents are not a supported image.`);
    return;
  }
  const extension = file.name.toLowerCase().split('.').pop();
  if (extension !== 'eml' && extension !== 'msg') {
    throw new Error(`${file.name}: the original email must use the .eml or .msg extension.`);
  }
  if (file.size === 0 || file.size > MAX_EML_BYTES) {
    throw new Error(`${file.name}: original email must be between 1 byte and 20 MB.`);
  }
  if (extension === 'msg') {
    const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (![208, 207, 17, 224, 161, 177, 26, 225].every((byte, index) => signature[index] === byte)) {
      throw new Error(`${file.name}: the file contents are not a supported Outlook MSG file.`);
    }
  }
}

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function evidenceData(file: File, investigation: Investigation, user: UserProfile): Omit<EvidenceItem, 'id' | 'createdAt'> {
  const isImage = IMAGE_TYPES.has(getFileMime(file));
  return {
    investigationId: investigation.id,
    userId: user.id,
    fileName: file.name,
    fileSize: file.size,
    mimeType: getFileMime(file) || (isImage ? 'image/jpeg' : 'message/rfc822'),
    mediaType: isImage ? 'image' : 'document',
    sha256Hash: '',
    storageUrl: '',
    previewUrl: '',
    isOriginal: true,
    verified: false,
    metadata: {
      fileFormat: file.name.split('.').pop()?.toLowerCase(),
      fileSizeBytes: file.size,
    },
  };
}

function comparisonColor(status: EmailFieldComparison['status']): string {
  if (status === 'match') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
  if (status === 'mismatch') return 'border-rose-500/40 bg-rose-500/10 text-rose-200';
  if (status === 'partial_match' || status === 'ocr_uncertain') return 'border-amber-500/30 bg-amber-500/10 text-amber-100';
  return 'border-slate-500/30 bg-slate-500/10 text-slate-300';
}

function comparisonLabel(status: EmailFieldComparison['status']): string {
  return status.replaceAll('_', ' ');
}

export const EmailVerifierView: React.FC<EmailVerifierViewProps> = ({
  investigations,
  currentCase,
  user,
  evidenceList,
  onCreateCase,
  onRequestSignIn,
  onAddEvidence,
}) => {
  const [selectedCaseId, setSelectedCaseId] = useState(currentCase?.id || '');
  const [caseName, setCaseName] = useState('');
  const [caseDescription, setCaseDescription] = useState('');
  const [creatingCase, setCreatingCase] = useState(false);
  const [hasSupabaseSession, setHasSupabaseSession] = useState<boolean | null>(null);
  const [screenshots, setScreenshots] = useState<File[]>([]);
  const [emlFile, setEmlFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [records, setRecords] = useState<EmailVerificationRecord[]>([]);
  const [activeRecordId, setActiveRecordId] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSavingNotes, setIsSavingNotes] = useState(false);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedField, setSelectedField] = useState('');
  const [zoom, setZoom] = useState(1);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [showSimulator, setShowSimulator] = useState(false);

  const selectedCase = investigations.find((item) => item.id === selectedCaseId)
    || (selectedCaseId === currentCase?.id ? currentCase : undefined);
  const activeRecord = records.find((item) => item.id === activeRecordId) || records[0];
  const result = activeRecord?.result;
  const reportScreenshotUrl = useMemo(() => {
    const evidence = evidenceList.find((item) => item.id === activeRecord?.screenshotEvidenceId);
    return evidence?.previewUrl || evidence?.thumbnailUrl || (activeRecord ? null : previewUrl);
  }, [activeRecord, activeRecord?.screenshotEvidenceId, evidenceList, previewUrl]);

  useEffect(() => {
    if (currentCase && !selectedCaseId) setSelectedCaseId(currentCase.id);
  }, [currentCase, selectedCaseId]);

  useEffect(() => {
    let active = true;
    getAuthSession()
      .then((session) => {
        if (active) setHasSupabaseSession(Boolean(session));
      })
      .catch(() => {
        if (active) {
          setHasSupabaseSession(false);
          setError('Could not check your Supabase sign-in. Reconnect and try again.');
        }
      });
    const unsubscribe = onAuthStateChange((_event, session) => {
      setHasSupabaseSession(Boolean(session));
      if (session) setError('');
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!selectedCase || hasSupabaseSession !== true) {
      setRecords([]);
      setActiveRecordId('');
      return;
    }
    let cancelled = false;
    setError('');
    void syncFetchEmailVerifications(selectedCase)
      .then((loaded) => {
        if (cancelled) return;
        setRecords(loaded);
        setActiveRecordId((current) => loaded.some((item) => item.id === current) ? current : loaded[0]?.id || '');
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        console.warn('[EmailVerifier] Could not load saved email verifications from cloud:', loadError);
      });
    return () => { cancelled = true; };
  }, [hasSupabaseSession, selectedCase?.id]);

  useEffect(() => {
    setNotes(activeRecord?.investigatorNotes || '');
    setSelectedField('');
  }, [activeRecord?.id]);

  useEffect(() => {
    if (!screenshots.length) {
      setPreviewUrl(null);
      setImageSize(null);
      return;
    }
    const url = URL.createObjectURL(screenshots[0]);
    setPreviewUrl(url);
    setImageSize(null);
    return () => URL.revokeObjectURL(url);
  }, [screenshots]);

  const createCase = async () => {
    if (!caseName.trim() || creatingCase) {
      setError('Enter a case name before starting an investigation.');
      return;
    }
    setCreatingCase(true);
    setError('');
    try {
      const caseNumber = `VL-EMAIL-${Date.now()}`;
      const created = await onCreateCase({
        caseNumber,
        title: caseName.trim(),
        description: caseDescription.trim(),
        userId: user.id,
        status: 'open',
        priority: 'medium',
        leadInvestigator: user.fullName || user.email,
        evidenceCount: 0,
        tags: ['Email Verification'],
      });
      setSelectedCaseId(created.id);
      setCaseName('');
      setCaseDescription('');
      setNotice(`Investigation ${created.caseNumber} is ready.`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not create the investigation.');
    } finally {
      setCreatingCase(false);
    }
  };

  const processEvidence = async () => {
    if (!hasSupabaseSession) {
      setError('Sign in to Supabase before uploading or processing private email evidence.');
      return;
    }
    if (!selectedCase) {
      setError('Select an existing investigation or create a case before processing evidence.');
      return;
    }
    if (!screenshots.length && !emlFile) {
      setError('Choose an email screenshot, an EML file, or both.');
      return;
    }
    setIsProcessing(true);
    setError('');
    setNotice('');
    try {
      for (const screenshot of screenshots) await validateFile(screenshot, 'screenshot');
      if (emlFile) await validateFile(emlFile, 'email');
      if (screenshots.some((screenshot) => screenshot.size + (emlFile?.size || 0) > MAX_COMBINED_BYTES)) {
        throw new Error('Each screenshot and EML pair must total 40 MB or less for secure local processing.');
      }
      const schemaCheck = await syncCheckEmailVerifierSchema();
      if (!schemaCheck.schemaReady) {
        console.info('[EmailVerifier] Cloud schema status:', schemaCheck.error);
      }

      const emlBase64 = emlFile ? await toBase64(emlFile) : null;
      let emlEvidence = null;
      if (emlFile) {
        try {
          emlEvidence = await onAddEvidence(evidenceData(emlFile, selectedCase, user), emlFile);
        } catch (evErr) {
          console.warn('[EmailVerifier] Cloud evidence upload skipped; local processing active:', evErr);
        }
      }
      const targets = screenshots.length ? screenshots : [null];
      const savedRecords: EmailVerificationRecord[] = [];
      const emailFormat = emlFile?.name.toLowerCase().endsWith('.msg') ? 'msg' : 'eml';

      for (const screenshot of targets) {
        let screenshotEvidence = null;
        if (screenshot) {
          try {
            screenshotEvidence = await onAddEvidence(evidenceData(screenshot, selectedCase, user), screenshot);
          } catch (evErr) {
            console.warn('[EmailVerifier] Cloud screenshot upload skipped; local processing active:', evErr);
          }
        }
        const session = await getAuthSession();
        if (!session?.access_token) throw new Error('Sign in to Supabase before processing email evidence.');
        let response: Response;
        try {
          response = await fetch('/api/forensics/email-verifier/analyze', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              screenshotBase64: screenshot ? await toBase64(screenshot) : null,
              emlBase64,
              emailFormat,
            }),
          });
        } catch (requestError) {
          if (requestError instanceof TypeError) {
            throw new Error('Could not reach the VexaLens API. The server process was started before the email verifier API was added; restart the VexaLens development server and try again.');
          }
          throw requestError;
        }
        let responseBody: EmailVerifierResult & { error?: string };
        try {
          responseBody = await response.json() as EmailVerifierResult & { error?: string };
        } catch {
          throw new Error(`Email analysis API returned an unreadable response (HTTP ${response.status}). Check the server logs and upload size limits.`);
        }
        if (!response.ok) throw new Error(responseBody.error || `Email analysis failed (HTTP ${response.status}).`);
        const saved = await syncSaveEmailVerification(
          selectedCase,
          screenshotEvidence?.id || null,
          emlEvidence?.id || null,
          responseBody
        );
        savedRecords.push(saved);
      }
      setRecords((existing) => [...savedRecords.reverse(), ...existing]);
      setActiveRecordId(savedRecords[0]?.id || '');
      if (schemaCheck.schemaReady) {
        setNotice(`${savedRecords.length} verification record${savedRecords.length === 1 ? '' : 's'} saved with the original evidence.`);
      } else {
        setNotice(`${savedRecords.length} verification record${savedRecords.length === 1 ? '' : 's'} analyzed and saved to local investigation storage.`);
      }
    } catch (processingError) {
      setError(processingError instanceof Error ? processingError.message : 'Email evidence processing failed.');
    } finally {
      setIsProcessing(false);
    }
  };

  const saveNotes = async () => {
    if (!activeRecord) return;
    setIsSavingNotes(true);
    setError('');
    try {
      await syncUpdateEmailVerification(activeRecord.id, { investigatorNotes: notes });
      setRecords((existing) => existing.map((item) => item.id === activeRecord.id
        ? { ...item, investigatorNotes: notes, updatedAt: new Date().toISOString() }
        : item));
      setNotice('Investigator notes saved.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save investigator notes.');
    } finally {
      setIsSavingNotes(false);
    }
  };

  const exportReport = async (print: boolean) => {
    if (!activeRecord || !result || !selectedCase) return;
    setError('');
    try {
      const pdf = generateEmailVerifierReport(result, selectedCase, activeRecord);
      const hashBytes = await crypto.subtle.digest('SHA-256', await pdf.arrayBuffer());
      const reportSha256 = Array.from(new Uint8Array(hashBytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
      let reportEvidenceId = activeRecord.reportEvidenceId || undefined;
      if (!reportEvidenceId) {
        const fileName = `Email_Verification_${selectedCase.caseNumber}_${activeRecord.id.slice(0, 8)}.pdf`;
        const reportFile = new File([pdf], fileName, { type: 'application/pdf' });
        const savedEvidence = await onAddEvidence(evidenceData(reportFile, selectedCase, user), reportFile, calculateEvidenceHashes(reportFile));
        reportEvidenceId = savedEvidence.id;
      }
      await syncUpdateEmailVerification(activeRecord.id, { reportEvidenceId, reportSha256 });
      setRecords((existing) => existing.map((item) => item.id === activeRecord.id
        ? { ...item, reportEvidenceId: reportEvidenceId || null, reportSha256 }
        : item));

      const objectUrl = URL.createObjectURL(pdf);
      if (print) {
        const printWindow = window.open(objectUrl, '_blank');
        if (!printWindow) throw new Error('The PDF was saved, but the browser blocked the print window. Allow pop-ups and retry.');
      } else {
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = `Email_Verification_${selectedCase.caseNumber}.pdf`;
        link.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      setNotice(print ? 'Report saved. Use the PDF viewer print control to print it.' : 'PDF report saved to the case and downloaded.');
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : 'Could not generate or save the report.');
    }
  };

  const comparisonEntries = Object.entries(result?.comparisons || {});
  const inputStyle: React.CSSProperties = {
    background: 'var(--vl-surface-elevated)',
    border: '1px solid var(--vl-border)',
    color: 'var(--vl-text-primary)',
  };

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-5 pb-16 sm:p-8">
      <header className="flex flex-col justify-between gap-5 rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-cyan-950/30 via-slate-950/60 to-violet-950/20 p-6 sm:flex-row sm:items-center sm:p-8">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[.24em] text-cyan-300">VexaLens email forensics</p>
          <h1 className="mt-2 text-2xl font-bold text-[var(--vl-text-primary)] sm:text-3xl">Email Screenshot vs Original Email Verifier</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--vl-text-secondary)]">
            Compare visible screenshot information with a supplied EML source. A match does not establish who sent the email, and a difference does not prove deliberate forgery.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowSimulator((visible) => !visible)}
          aria-expanded={showSimulator}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-cyan-400/40 bg-cyan-500/10 px-4 py-2.5 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-500/20"
        >
          {showSimulator ? <X className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {showSimulator ? 'Hide simulator' : 'Run simulator'}
        </button>
      </header>

      {showSimulator && (
        <section aria-label="Email verifier simulator" className="space-y-4 rounded-2xl border border-cyan-500/30 bg-[var(--vl-surface)] p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[.2em] text-cyan-300">Simulator · synthetic sample</p>
              <h2 className="mt-1 text-lg font-bold text-[var(--vl-text-primary)]">Screenshot vs original EML</h2>
            </div>
            <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-[10px] font-semibold uppercase text-amber-100">
              Demonstration only
            </span>
          </div>
          <p className="text-xs leading-5 text-[var(--vl-text-secondary)]">
            This scripted example intentionally changes the subject to demonstrate a discrepancy. It does not analyze real evidence, send files, or save anything to a case.
          </p>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-[var(--vl-border-subtle)] p-4">
              <h3 className="mb-3 text-xs font-bold uppercase tracking-wide text-[var(--vl-text-primary)]">Synthetic screenshot preview</h3>
              <div className="space-y-2 rounded-lg border border-slate-300 bg-white p-4 text-left text-xs text-slate-800 shadow-sm">
                <p className="border-b border-slate-200 pb-2 font-semibold">Example Mail · demo account</p>
                <p><span className="font-semibold">From:</span> security@example.test</p>
                <p><span className="font-semibold">To:</span> reviewer@example.test</p>
                <p><span className="font-semibold">Subject:</span> Account activity notice — verify now</p>
                <p><span className="font-semibold">Date:</span> 25 Nov 2025, 09:00 UTC</p>
                <p className="border-t border-slate-200 pt-2 text-slate-600">This is a computer-generated demonstration message.</p>
              </div>
            </div>
            <div className="rounded-xl border border-[var(--vl-border-subtle)] p-4">
              <h3 className="mb-3 text-xs font-bold uppercase tracking-wide text-[var(--vl-text-primary)]">Synthetic original email (.eml)</h3>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--vl-surface-elevated)] p-3 text-[11px] leading-5 text-[var(--vl-text-secondary)]">{EMAIL_SIMULATOR_EML}</pre>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {EMAIL_SIMULATOR_FIELDS.map(({ field, screenshot, original }) => {
              const matches = screenshot === original;
              return (
                <div
                  key={field}
                  className={`rounded-xl border p-3 ${matches
                    ? 'border-emerald-500/30 bg-emerald-500/10'
                    : 'border-rose-500/40 bg-rose-500/10'}`}
                >
                  <p className={`text-xs font-bold ${matches ? 'text-emerald-200' : 'text-rose-200'}`}>
                    {field} · {matches ? 'Match' : 'Mismatch'}
                  </p>
                  <p className="mt-2 break-words text-[11px] text-[var(--vl-text-secondary)]">Screenshot: {screenshot}</p>
                  <p className="mt-1 break-words text-[11px] text-[var(--vl-text-secondary)]">Original: {original}</p>
                </div>
              );
            })}
          </div>
          <p role="status" className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-3 text-xs leading-5 text-amber-100/90">
            Simulated discrepancy: the screenshot subject differs from the original EML subject. This is not a forensic finding and is not evidence that any real email was altered.
          </p>
        </section>
      )}

      <section className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
        <div className="space-y-4 rounded-2xl border border-[var(--vl-border)] bg-[var(--vl-surface)] p-5">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-cyan-400/10 font-mono text-xs text-cyan-200">1</span>
            <h2 className="font-semibold text-[var(--vl-text-primary)]">Start an investigation</h2>
          </div>
          <label className="block text-xs text-[var(--vl-text-secondary)]">
            Existing case
            <select
              value={selectedCase?.id || ''}
              onChange={(event) => setSelectedCaseId(event.target.value)}
              className="mt-1.5 w-full rounded-lg px-3 py-2.5 text-sm"
              style={inputStyle}
            >
              <option value="">Select a case</option>
              {investigations.filter((item) => item.status !== 'closed').map((item) => (
                <option key={item.id} value={item.id}>{item.caseNumber} - {item.title}</option>
              ))}
            </select>
          </label>
          <div className="rounded-xl border border-[var(--vl-border-subtle)] p-3">
            <label className="block text-xs text-[var(--vl-text-secondary)]">
              Or create a new case
              <input value={caseName} onChange={(event) => setCaseName(event.target.value)} placeholder="Case name" className="mt-1.5 w-full rounded-lg px-3 py-2 text-sm" style={inputStyle} />
            </label>
            <textarea value={caseDescription} onChange={(event) => setCaseDescription(event.target.value)} placeholder="Optional case description" rows={2} className="mt-2 w-full resize-y rounded-lg px-3 py-2 text-sm" style={inputStyle} />
            <button type="button" onClick={createCase} disabled={creatingCase} className="mt-2 inline-flex items-center gap-2 rounded-lg border border-cyan-500/30 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-50">
              <Plus className="h-3.5 w-3.5" />{creatingCase ? 'Creating case…' : 'Create case'}
            </button>
          </div>
          {selectedCase && <p className="text-xs text-cyan-200">Active case: {selectedCase.caseNumber} · {selectedCase.title}</p>}
        </div>

        <div className="space-y-4 rounded-2xl border border-[var(--vl-border)] bg-[var(--vl-surface)] p-5">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-cyan-400/10 font-mono text-xs text-cyan-200">2</span>
            <h2 className="font-semibold text-[var(--vl-text-primary)]">Upload original evidence</h2>
          </div>
          <p className="text-xs leading-5 text-[var(--vl-text-secondary)]">
            Upload both files for comparison. Screenshot-only or EML-only processing is allowed but cannot verify fields without the other source.
          </p>
          <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-cyan-500/30 bg-cyan-500/[0.03] p-4 hover:bg-cyan-500/[0.07]">
            <UploadCloud className="h-5 w-5 shrink-0 text-cyan-300" />
            <span className="min-w-0 flex-1 text-sm text-[var(--vl-text-primary)]">
              Email screenshot(s) <span className="block text-xs text-[var(--vl-text-dim)]">PNG, JPG, JPEG, WEBP · max 25 MB each</span>
              {screenshots.length > 0 && <span className="mt-1 block truncate text-xs text-cyan-200">{screenshots.map((file) => file.name).join(', ')}</span>}
            </span>
            <input type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" multiple className="sr-only" onChange={(event) => { setError(''); setScreenshots(Array.from(event.target.files || [])); }} />
          </label>
          {previewUrl && (
            <img src={previewUrl} alt="Selected screenshot preview" className="max-h-48 max-w-full rounded-lg border border-[var(--vl-border)] object-contain" />
          )}
          <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-violet-500/30 bg-violet-500/[0.03] p-4 hover:bg-violet-500/[0.07]">
            <Mail className="h-5 w-5 shrink-0 text-violet-300" />
            <span className="min-w-0 flex-1 text-sm text-[var(--vl-text-primary)]">
              Original email source <span className="block text-xs text-[var(--vl-text-dim)]">EML or Outlook MSG · max 20 MB</span>
              {emlFile && <span className="mt-1 block truncate text-xs text-violet-200">{emlFile.name}</span>}
            </span>
            <input type="file" accept=".eml,.msg,message/rfc822,application/vnd.ms-outlook" className="sr-only" onChange={(event) => { setError(''); setEmlFile(event.target.files?.[0] || null); }} />
          </label>
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-3 text-xs leading-5 text-amber-100/90">
            Original files are saved in the selected case without modification. EML content and screenshot bytes are processed by the authenticated VexaLens backend; private email HTML is parsed as text and is never rendered or executed.
          </div>
          <button type="button" onClick={processEvidence} disabled={isProcessing || (!screenshots.length && !emlFile)} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-500 px-4 py-3 text-sm font-bold text-slate-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50">
            <FileCheck2 className="h-4 w-4" />{isProcessing ? 'Saving evidence and comparing…' : 'Analyze and save investigation'}
          </button>
        </div>
      </section>

      {(error || notice) && (
        <div role={error ? 'alert' : 'status'} className={`rounded-xl border px-4 py-3 text-sm ${error ? 'border-rose-500/30 bg-rose-500/10 text-rose-200' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="flex-1">{error || notice}</span>
            <div className="flex items-center gap-2">
              {error?.toLowerCase().includes('sign in to supabase') && (
                <button type="button" onClick={onRequestSignIn} className="shrink-0 rounded-lg border border-cyan-400/40 px-3 py-1.5 text-xs font-semibold text-cyan-100 hover:bg-cyan-500/10">
                  Sign in to Supabase
                </button>
              )}
              {(error?.toLowerCase().includes('migration') || error?.toLowerCase().includes('email_verifications')) && (
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(EMAIL_VERIFIER_MIGRATION_SQL);
                    setNotice('Copied Supabase SQL migration to clipboard! You can paste and run it in the Supabase Dashboard SQL Editor.');
                    setError('');
                  }}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-cyan-400/40 bg-cyan-500/20 px-3 py-1.5 text-xs font-semibold text-cyan-100 hover:bg-cyan-500/30"
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy Supabase Migration SQL
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {hasSupabaseSession === false && (
        <div role="status" className="flex flex-col gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4 text-sm text-amber-100 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-semibold">Supabase sign-in required</p>
            <p className="mt-1 text-xs leading-5 text-amber-100/80">This workspace currently has a local investigator profile, but no Supabase session. Sign in to load saved investigations and securely store original email evidence and analysis.</p>
          </div>
          <button type="button" onClick={onRequestSignIn} className="inline-flex shrink-0 items-center justify-center rounded-lg border border-amber-300/40 px-3 py-2 text-xs font-semibold text-amber-100 hover:bg-amber-400/10">
            Sign in to Supabase
          </button>
        </div>
      )}

      {selectedCase && records.length > 0 && (
        <section className="rounded-2xl border border-[var(--vl-border)] bg-[var(--vl-surface)] p-4 sm:p-5">
          <label className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-semibold text-[var(--vl-text-primary)]">Saved investigations</span>
            <select value={activeRecord?.id || ''} onChange={(event) => setActiveRecordId(event.target.value)} className="min-w-64 flex-1 rounded-lg px-3 py-2 text-xs" style={inputStyle}>
              {records.map((item) => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.result.conclusion}</option>)}
            </select>
          </label>
        </section>
      )}

      {result && activeRecord && selectedCase && (
        <section className="space-y-5">
          <div className="flex flex-col justify-between gap-3 rounded-2xl border border-[var(--vl-border)] bg-[var(--vl-surface)] p-5 sm:flex-row sm:items-center">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[.2em] text-cyan-300">Investigation result</p>
              <h2 className="mt-1 text-xl font-bold text-[var(--vl-text-primary)]">{result.conclusion}</h2>
              <p className="mt-1 text-xs text-[var(--vl-text-secondary)]">Saved {new Date(activeRecord.createdAt).toLocaleString()} · {activeRecord.id}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void exportReport(false)} className="inline-flex items-center gap-2 rounded-lg border border-cyan-500/30 px-3 py-2 text-xs text-cyan-200 hover:bg-cyan-500/10"><Download className="h-4 w-4" />Download PDF</button>
              <button type="button" onClick={() => void exportReport(true)} className="inline-flex items-center gap-2 rounded-lg border border-[var(--vl-border)] px-3 py-2 text-xs text-[var(--vl-text-secondary)] hover:text-[var(--vl-text-primary)]"><Printer className="h-4 w-4" />Print report</button>
            </div>
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <div className="min-w-0 rounded-2xl border border-[var(--vl-border)] bg-[var(--vl-surface)] p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-bold text-[var(--vl-text-primary)]">Screenshot evidence</h3>
                <div className="flex gap-1">
                  <button type="button" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))} className="rounded-md border border-[var(--vl-border)] p-1.5"><ZoomOut className="h-4 w-4" /></button>
                  <button type="button" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(3, value + 0.25))} className="rounded-md border border-[var(--vl-border)] p-1.5"><ZoomIn className="h-4 w-4" /></button>
                </div>
              </div>
              {reportScreenshotUrl ? (
                <div className="max-h-[34rem] overflow-auto rounded-lg bg-black/30 p-2">
                  <div className="relative mx-auto" style={{ width: `${zoom * 100}%` }}>
                    <img src={reportScreenshotUrl} alt="Original email screenshot evidence" onLoad={(event) => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} className="block h-auto w-full" />
                    {imageSize && result.screenshot.ocr.lines.map((line, index) => (
                      <button
                        key={`${line.text}-${index}`}
                        type="button"
                        aria-label={`Select extracted screenshot text: ${line.text}`}
                        title={`${line.text} (${line.confidence.toFixed(0)}% OCR confidence)`}
                        onClick={() => setSelectedField(line.text)}
                        className={`absolute border ${selectedField === line.text ? 'border-rose-400 bg-rose-400/20' : 'border-emerald-300/70 bg-emerald-300/5 hover:bg-emerald-300/20'}`}
                        style={{
                          left: `${line.box.x / imageSize.width * 100}%`,
                          top: `${line.box.y / imageSize.height * 100}%`,
                          width: `${line.box.width / imageSize.width * 100}%`,
                          height: `${line.box.height / imageSize.height * 100}%`,
                        }}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-[var(--vl-border)] text-sm text-[var(--vl-text-dim)]">Original screenshot was not provided or is not available in this case.</div>
              )}
              <p className="mt-3 text-xs text-[var(--vl-text-secondary)]">SHA-256: <code className="break-all text-cyan-200">{result.screenshot.sha256 || 'Not provided'}</code></p>
              <p className="mt-1 text-xs text-[var(--vl-text-secondary)]">OCR: {result.screenshot.ocr.status}{result.screenshot.ocr.reason ? ` - ${result.screenshot.ocr.reason}` : ''}</p>
              <details className="mt-3 rounded-lg border border-[var(--vl-border-subtle)] p-3">
                <summary className="cursor-pointer text-xs font-semibold text-[var(--vl-text-secondary)]">Selectable OCR text and confidence</summary>
                <div className="mt-3 space-y-2">
                  {result.screenshot.ocr.lines.map((line, index) => (
                    <button key={`${line.text}-${index}`} type="button" onClick={() => setSelectedField(line.text)} className={`block w-full rounded-md p-2 text-left text-xs ${selectedField === line.text ? 'bg-rose-500/10 text-rose-100' : 'bg-[var(--vl-surface-elevated)] text-[var(--vl-text-secondary)]'}`}>
                      {line.text} <span className="ml-1 font-mono text-[10px]">{line.confidence.toFixed(0)}%</span>
                    </button>
                  ))}
                  {!result.screenshot.ocr.lines.length && <p className="text-xs text-[var(--vl-text-dim)]">Not detected. No OCR text has been inferred.</p>}
                </div>
              </details>
            </div>

            <div className="min-w-0 rounded-2xl border border-[var(--vl-border)] bg-[var(--vl-surface)] p-4">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-[var(--vl-text-primary)]"><FileText className="h-4 w-4 text-violet-300" />Parsed original email</h3>
              {result.email ? (
                <>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {[
                      ['From', result.email.headers.from],
                      ['To', result.email.headers.to],
                      ['CC', result.email.headers.cc],
                      ['BCC', result.email.headers.bcc],
                      ['Reply-To', result.email.headers.replyTo],
                      ['Subject', result.email.headers.subject],
                      ['Date', result.email.headers.date],
                      ['Date in UTC', result.email.headers.dateUtc],
                      ['Message-ID', result.email.headers.messageId],
                      ['Return-Path', result.email.headers.returnPath],
                      ['X-Mailer', result.email.headers.xMailer],
                      ['User-Agent', result.email.headers.userAgent],
                      ['Content-Type', result.email.headers.contentType],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-lg border border-[var(--vl-border-subtle)] p-2.5">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--vl-text-dim)]">{label}</div>
                        <div className="mt-1 break-words text-xs text-[var(--vl-text-primary)]">{Array.isArray(value) ? value.map((item) => typeof item === 'string' ? item : item.name ? `${item.name} <${item.email}>` : item.email).join(', ') || 'Not provided' : value || 'Not provided'}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 rounded-lg border border-[var(--vl-border-subtle)] p-3">
                    <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-[var(--vl-text-dim)]">Message body (plain text only)</p>
                    <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-[var(--vl-text-secondary)]">{result.email.body.plainText || result.email.body.htmlText || 'Not provided'}</pre>
                  </div>
                  <div className="mt-3 space-y-2 rounded-lg border border-[var(--vl-border-subtle)] p-3 text-xs">
                    <p className="font-semibold text-[var(--vl-text-primary)]">Authentication evidence</p>
                    <p title="A result copied into the EML header is not independently authenticated.">SPF: {String(result.email.authentication.spf)} · DKIM: {String(result.email.authentication.dkim)} · DMARC: {String(result.email.authentication.dmarc)}</p>
                    <p className="text-amber-200">{String(result.email.authentication.verification)}</p>
                    <p>DKIM signature header present: {result.email.authentication.dkimSignaturePresent ? 'Yes' : 'No'}</p>
                  </div>
                  <p className="mt-3 text-xs text-[var(--vl-text-secondary)]">EML SHA-256: <code className="break-all text-violet-200">{result.email.sha256}</code></p>
                  <details className="mt-3 rounded-lg border border-[var(--vl-border-subtle)] p-3">
                    <summary className="cursor-pointer text-xs font-semibold text-[var(--vl-text-secondary)]">Headers, attachments and MIME structure</summary>
                    <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[10px] text-[var(--vl-text-secondary)]">{JSON.stringify({ headers: result.email.headers, attachments: result.email.attachments, bodyHtmlAsText: result.email.body.htmlText }, null, 2)}</pre>
                  </details>
                </>
              ) : (
                <div className="rounded-lg border border-dashed border-[var(--vl-border)] p-6 text-sm text-[var(--vl-text-dim)]">Original EML/MSG not provided. Screenshot findings cannot verify original headers or sender identity.</div>
              )}
            </div>
          </div>

          {result.email?.intelligence && (
            <section className="space-y-4 rounded-2xl border border-[var(--vl-border)] bg-[var(--vl-surface)] p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[.2em] text-cyan-300">Mail header intelligence</p>
                  <h3 className="mt-1 text-lg font-bold text-[var(--vl-text-primary)]">Delivery path and threat signals</h3>
                </div>
                <span className={`rounded-full border px-3 py-1 text-xs font-bold uppercase ${
                  result.email.intelligence.risk.level === 'low'
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                    : result.email.intelligence.risk.level === 'medium'
                      ? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
                      : 'border-rose-500/30 bg-rose-500/10 text-rose-200'
                }`}>
                  {result.email.intelligence.risk.level} risk · {result.email.intelligence.risk.score}/100
                </span>
              </div>

              <div className="grid gap-4 xl:grid-cols-2">
                <div className="rounded-xl border border-[var(--vl-border-subtle)] p-4">
                  <h4 className="mb-2 text-xs font-bold text-[var(--vl-text-primary)]">
                    Received path · {result.email.intelligence.deliverySummary.hopCount} hop(s)
                  </h4>
                  <p className="mb-3 text-[11px] text-[var(--vl-text-secondary)]">
                    Ordered newest to oldest. Total recorded span:{' '}
                    {result.email.intelligence.deliverySummary.totalDelaySeconds === null
                      ? 'unavailable'
                      : `${result.email.intelligence.deliverySummary.totalDelaySeconds} seconds`}
                  </p>
                  <ol className="space-y-2">
                    {result.email.intelligence.deliveryPath.map((hop, index) => (
                      <li key={`${hop.raw}-${index}`} className="rounded-lg bg-[var(--vl-surface-elevated)] p-3 text-[11px]">
                        <p className="font-semibold text-[var(--vl-text-primary)]">
                          Hop {index + 1}: {hop.fromHost || 'unknown sender'} → {hop.byHost || 'unknown receiver'}
                        </p>
                        <p className="mt-1 break-all text-[var(--vl-text-secondary)]">
                          {hop.protocol || 'protocol not stated'} · {hop.timestampUtc || hop.timestamp || 'timestamp not stated'}
                        </p>
                        {hop.ips.length > 0 && <p className="mt-1 break-all text-cyan-200">IPs: {hop.ips.join(', ')}</p>}
                        {hop.delayToOlderSeconds !== null && (
                          <p className={`mt-1 ${hop.delayToOlderSeconds < 0 ? 'text-rose-200' : 'text-[var(--vl-text-secondary)]'}`}>
                            Delay to next older hop: {hop.delayToOlderSeconds} seconds
                          </p>
                        )}
                      </li>
                    ))}
                    {result.email.intelligence.deliveryPath.length === 0 && (
                      <li className="text-xs text-[var(--vl-text-dim)]">No Received headers were present.</li>
                    )}
                  </ol>
                  <div className="mt-3 border-t border-[var(--vl-border-subtle)] pt-3 text-[11px]">
                    <p className="font-semibold text-[var(--vl-text-primary)]">Origin IP (candidate only)</p>
                    <p className="mt-1 break-words text-[var(--vl-text-secondary)]">
                      {result.email.intelligence.deliverySummary.origin
                        ? `${result.email.intelligence.deliverySummary.origin.candidateIp} · ${result.email.intelligence.deliverySummary.origin.scope} · ${result.email.intelligence.deliverySummary.origin.country || 'country unavailable'}`
                        : 'No candidate IP could be derived from the oldest Received header.'}
                    </p>
                    <p className="mt-1 text-amber-200">
                      {result.email.intelligence.deliverySummary.origin?.confidence || result.email.intelligence.deliverySummary.geoIpNote}
                    </p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="rounded-xl border border-[var(--vl-border-subtle)] p-4 text-[11px]">
                    <h4 className="mb-2 text-xs font-bold text-[var(--vl-text-primary)]">Authentication domain alignment</h4>
                    <p>From: {result.email.intelligence.authenticationAlignment.fromDomain || 'not available'}</p>
                    <p>Return-Path: {result.email.intelligence.authenticationAlignment.returnPathDomain || 'not available'} · aligned: {String(result.email.intelligence.authenticationAlignment.returnPathAligned ?? 'unknown')}</p>
                    <p>SPF identity: {result.email.intelligence.authenticationAlignment.spfDomains.join(', ') || 'not available'} · aligned: {String(result.email.intelligence.authenticationAlignment.spfAligned ?? 'unknown')}</p>
                    <p>DKIM signing domains: {result.email.intelligence.authenticationAlignment.dkimDomains.map((item) => `${item.domain} (aligned: ${String(item.aligned ?? 'unknown')})`).join(', ') || 'not available'}</p>
                    <p>Reply-To: {result.email.intelligence.authenticationAlignment.replyToDomain || 'not available'} · aligned: {String(result.email.intelligence.authenticationAlignment.replyToAligned ?? 'unknown')}</p>
                    <p className="mt-2 text-amber-200">{result.email.intelligence.authenticationAlignment.note}</p>
                  </div>
                  <div className="rounded-xl border border-[var(--vl-border-subtle)] p-4 text-[11px]">
                    <h4 className="mb-2 text-xs font-bold text-[var(--vl-text-primary)]">Threat assessment</h4>
                    <ul className="list-disc space-y-1 pl-4 text-[var(--vl-text-secondary)]">
                      {result.email.intelligence.risk.findings.map((finding) => <li key={finding}>{finding}</li>)}
                    </ul>
                    <p className="mt-2 border-t border-[var(--vl-border-subtle)] pt-2 text-amber-200">
                      Recommendation: {result.email.intelligence.risk.recommendation}
                    </p>
                  </div>
                  <div className="rounded-xl border border-[var(--vl-border-subtle)] p-4 text-[11px]">
                    <h4 className="mb-2 text-xs font-bold text-[var(--vl-text-primary)]">Extracted artifacts</h4>
                    <p className="break-all"><strong>IPs:</strong> {result.email.intelligence.artifacts.ips.map((item) => `${item.address} (${item.scope}${item.country ? `, ${item.country}` : ''})`).join(', ') || 'None'}</p>
                    <p className="mt-1 break-all"><strong>Emails:</strong> {result.email.intelligence.artifacts.emails.join(', ') || 'None'}</p>
                    <p className="mt-1 break-all"><strong>URLs:</strong> {result.email.intelligence.artifacts.urls.join(', ') || 'None'}</p>
                    <p className="mt-2 text-amber-200">{result.email.intelligence.artifacts.reputationNote}</p>
                  </div>
                </div>
              </div>
            </section>
          )}

          <section className="rounded-2xl border border-[var(--vl-border)] bg-[var(--vl-surface)] p-4 sm:p-5">
            <h3 className="mb-3 text-sm font-bold text-[var(--vl-text-primary)]">Field-by-field comparison</h3>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {comparisonEntries.map(([field, comparison]) => (
                <button key={field} type="button" onClick={() => setSelectedField(comparison.screenshot || field)} className={`min-w-0 rounded-xl border p-3 text-left ${comparisonColor(comparison.status)}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold capitalize">{field}</span>
                    <span className="rounded-full border border-current/20 px-2 py-0.5 text-[9px] uppercase">{comparisonLabel(comparison.status)}</span>
                  </div>
                  <p className="mt-2 break-words text-[11px]">Screenshot: {comparison.screenshot || 'Not detected'}</p>
                  <p className="mt-1 break-words text-[11px] opacity-80">Original: {comparison.original || 'Not provided'}</p>
                  {comparison.screenshotOnly?.length ? <p className="mt-2 break-words text-[11px]">Screenshot-only: {comparison.screenshotOnly.join(' ')}</p> : null}
                  {comparison.originalOnly?.length ? <p className="mt-1 break-words text-[11px]">Original-only: {comparison.originalOnly.join(' ')}</p> : null}
                </button>
              ))}
            </div>
          </section>

          <section className="grid gap-5 lg:grid-cols-2">
            <div className="rounded-2xl border border-[var(--vl-border)] bg-[var(--vl-surface)] p-5">
              <h3 className="mb-3 text-sm font-bold text-[var(--vl-text-primary)]">Screenshot visibility vs original</h3>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[32rem] text-left text-xs">
                  <thead><tr className="border-b border-[var(--vl-border)] text-[var(--vl-text-dim)]"><th className="py-2 pr-3">Information</th><th className="px-2 py-2">Screenshot</th><th className="px-2 py-2">Original</th></tr></thead>
                  <tbody>{result.visibility.map((item) => <tr key={item.information} className="border-b border-[var(--vl-border-subtle)]"><td className="py-2 pr-3 font-medium text-[var(--vl-text-primary)]">{item.information}</td><td className="px-2 py-2 text-[var(--vl-text-secondary)]">{item.screenshot}</td><td className="px-2 py-2 text-[var(--vl-text-secondary)]">{item.original}</td></tr>)}</tbody>
                </table>
              </div>
            </div>
            <div className="rounded-2xl border border-[var(--vl-border)] bg-[var(--vl-surface)] p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-[var(--vl-text-primary)]"><ShieldAlert className="h-4 w-4 text-amber-300" />Forensic observations and limitations</h3>
              <ul className="space-y-2">
                {result.observations.map((observation, index) => (
                  <li key={`${observation.field}-${index}`} className={`rounded-lg border p-3 text-xs ${observation.status === 'mismatch' ? 'border-rose-500/30 bg-rose-500/5' : 'border-[var(--vl-border-subtle)]'}`}>
                    <p className="font-semibold text-[var(--vl-text-primary)]">{observation.title}</p>
                    <p className="mt-1 leading-5 text-[var(--vl-text-secondary)]">{observation.description}</p>
                  </li>
                ))}
                {result.observations.length === 0 && <li className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-emerald-100"><CheckCircle2 className="mr-1 inline h-4 w-4" />No comparison discrepancies were observed in the available fields.</li>}
              </ul>
              <h4 className="mt-4 text-xs font-bold text-[var(--vl-text-primary)]">Limitations</h4>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] leading-5 text-[var(--vl-text-secondary)]">{result.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
          </section>

          <section className="rounded-2xl border border-[var(--vl-border)] bg-[var(--vl-surface)] p-5">
            <h3 className="mb-2 text-sm font-bold text-[var(--vl-text-primary)]">Investigator notes</h3>
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} placeholder="Record your observations without changing the extracted evidence." className="w-full resize-y rounded-xl px-3 py-2 text-sm" style={inputStyle} />
            <button type="button" onClick={() => void saveNotes()} disabled={isSavingNotes} className="mt-3 rounded-lg border border-cyan-500/30 px-3 py-2 text-xs font-semibold text-cyan-200 disabled:opacity-50">{isSavingNotes ? 'Saving…' : 'Save investigator notes'}</button>
          </section>
        </section>
      )}

      {!records.length && !result && (
        <div className="flex items-start gap-3 rounded-xl border border-slate-500/20 bg-slate-500/[0.04] p-4 text-xs leading-5 text-[var(--vl-text-secondary)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <p>OCR uses local Tesseract when configured with TESSERACT_PATH. Without it, EML/MSG parsing and cryptographic hashes still run, while screenshot text is marked unavailable instead of guessed. Apply pending Supabase migrations with npx supabase db push before saving investigations.</p>
        </div>
      )}
    </main>
  );
};
