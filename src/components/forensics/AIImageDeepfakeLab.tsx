import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { EvidenceItem, Investigation } from '@/types/forensics';
import { calculateEvidenceHashes } from '@/lib/forensics/crypto';
import { extractMediaMetadata } from '@/lib/forensics/metadata';
import { generateThumbnail } from '@/lib/forensics/image';
import {
  analyzeDeepSafeEvidence,
  createFailedDeepSafeAnalysis,
  DeepSafeImageAnalysis,
  DeepSafeModelId,
  DeepSafeModelResult,
  DeepSafeHealth,
  fetchDeepSafeHealth,
  formatDeepSafeScore,
  findReusableDeepSafeAnalysis,
  DEEPSAFE_MODEL_VERSION,
} from '@/lib/forensics/deepsafeImageDetector';
import { downloadDeepSafeImageReport } from '@/lib/forensics/deepsafeImageReport';
import {
  syncFetchDeepSafeImageDetectionHistory,
  syncSaveDeepSafeImageDetection,
} from '@/lib/supabase-sync';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  ExternalLink,
  FileImage,
  FileText,
  Fingerprint,
  LoaderCircle,
  RefreshCw,
  ScanFace,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  XCircle,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Local Face Deepfake Detector — types
// ---------------------------------------------------------------------------
interface LocalFaceFaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LocalFaceResult {
  assessment: 'no_strong_signal' | 'possible_deepfake' | 'no_face_detected';
  label: string;
  fake_score: number | null;
  face: LocalFaceFaceBox | null;
  model_id: string;
  model_url: string;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// LocalFaceDeepfakePanel sub-component
// ---------------------------------------------------------------------------
function LocalFaceDeepfakePanel({ selectedImage }: { selectedImage: EvidenceItem | null | undefined }) {
  const [result, setResult] = useState<LocalFaceResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clear result whenever the selected image changes
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [selectedImage?.id]);

  const runLocalFaceScan = useCallback(async () => {
    if (!selectedImage) return;
    setRunning(true);
    setError(null);
    setResult(null);

    try {
      // Fetch the image bytes from the signed Supabase URL in the browser
      const imgResponse = await fetch(selectedImage.previewUrl);
      if (!imgResponse.ok) {
        throw new Error(`Could not fetch evidence image (HTTP ${imgResponse.status}).`);
      }
      const blob = await imgResponse.blob();

      // POST raw bytes to the Express proxy, which forwards to the Python backend
      const contentType = blob.type || 'image/jpeg';
      const apiResponse = await fetch('/api/forensics/contrastive-deepfake', {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: blob,
      });

      let payload: unknown;
      try {
        payload = await apiResponse.json();
      } catch {
        throw new Error('The local deepfake service returned an unreadable response.');
      }

      if (!apiResponse.ok) {
        const detail =
          payload &&
          typeof payload === 'object' &&
          'error' in payload &&
          typeof (payload as { error?: unknown }).error === 'string'
            ? (payload as { error: string }).error
            : `Local deepfake service failed (HTTP ${apiResponse.status}).`;
        throw new Error(detail);
      }

      setResult(payload as LocalFaceResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Local face scan failed.');
    } finally {
      setRunning(false);
    }
  }, [selectedImage]);

  const assessmentStyle = (assessment: LocalFaceResult['assessment']): string => {
    if (assessment === 'possible_deepfake') return 'text-rose-300';
    if (assessment === 'no_face_detected') return 'text-amber-300';
    return 'text-emerald-300';
  };

  const scoreColor = (score: number): string => {
    if (score >= 0.7) return 'text-rose-300';
    if (score >= 0.4) return 'text-amber-300';
    return 'text-emerald-300';
  };

  return (
    <div className="rounded-xl border border-violet-900/50 bg-slate-950/60 p-5 space-y-4">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <ScanFace className="h-4 w-4 text-violet-400 shrink-0" />
          <h3 className="text-sm font-bold text-white">Local Face Deepfake Detector</h3>
        </div>
        <p className="mt-1.5 text-[11px] leading-5 text-slate-400">
          Runs the Hugging Face EfficientNet-B4 face-forgery model on the local VexaLens backend.
          The first face scan downloads its approximately 141&thinsp;MB checkpoint. The image is not
          sent to an inference provider.
        </p>
      </div>

      {/* Run button */}
      <button
        type="button"
        onClick={() => void runLocalFaceScan()}
        disabled={running || !selectedImage}
        className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {running ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ScanFace className="h-3.5 w-3.5" />}
        {running ? 'Analyzing…' : 'Run local face scan'}
      </button>

      {/* Limitations disclaimer (always visible) */}
      <p className="text-[10px] leading-5 text-slate-500">
        This research model is for manipulated face images, not general AI-generated images. It
        analyzes the largest face detected in the image; no face means no verdict. Its score is
        uncalibrated and cannot prove that an image is real or fake. This scan uses the RetinaFace
        face detector described by the model card; its score can still miss face swaps.
      </p>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-950/20 p-3 text-xs text-rose-200">
          {error}
        </div>
      )}

      {/* Result panel */}
      {result && (
        <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4 space-y-3">
          <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500">Simple result</p>

          <div className="flex items-start justify-between gap-4">
            <div>
              <p className={`text-lg font-black ${assessmentStyle(result.assessment)}`}>
                {result.label}
              </p>
              {result.face && (
                <p className="mt-1 text-[11px] text-slate-400">
                  Largest detected face: x={result.face.x}, y={result.face.y},{' '}
                  {result.face.width}&thinsp;×&thinsp;{result.face.height}&thinsp;px.
                </p>
              )}
            </div>
            {result.fake_score !== null && (
              <div className="text-right shrink-0">
                <p className="text-[9px] text-slate-500">Uncalibrated model fake score</p>
                <p className={`mt-0.5 text-2xl font-black tabular-nums ${scoreColor(result.fake_score)}`}>
                  {(result.fake_score * 100).toFixed(1)}%
                </p>
              </div>
            )}
          </div>

          {result.limitations.length > 0 && (
            <ul className="space-y-1.5 text-[11px] leading-5 text-slate-400">
              {result.limitations.map((limitation, idx) => (
                <li key={idx} className="flex gap-2">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-violet-400" />
                  {limitation}
                </li>
              ))}
            </ul>
          )}

          <a
            href={result.model_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-violet-400 hover:text-violet-300 hover:underline"
          >
            Hugging Face model card
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Image Attribution & Provenance Detector — types & component
// ---------------------------------------------------------------------------
interface AttributionEvidenceItem {
  check: string;
  field: string;
  value: string;
  tool: string | null;
  level: string | null;
}

interface AttributionResult {
  file_name: string;
  verdict: 'Confirmed' | 'Likely' | 'Weak hint' | 'Not detected';
  tools: string[];
  evidence_list: AttributionEvidenceItem[];
  checks_skipped: Array<{ check: string; reason: string }>;
  disclaimer?: string;
  check_details: {
    check_a_metadata: {
      found: boolean;
      tools: string[];
      evidence: AttributionEvidenceItem[];
    };
    check_b_c2pa: {
      manifest_found: boolean;
      signer: string | null;
      claim_generator: string | null;
      actions: Array<{ action: string; softwareAgent: string; digitalSourceType: string }>;
      evidence: AttributionEvidenceItem[];
      skipped: boolean;
      skip_reason: string | null;
    };
    check_c_invisible_watermark: {
      found: boolean;
      decoded_payload: string | null;
      evidence: AttributionEvidenceItem[];
      synthid_note: string;
      skipped: boolean;
      skip_reason: string | null;
    };
    check_d_filename: {
      found: boolean;
      tools: string[];
      evidence: AttributionEvidenceItem[];
    };
  };
}

function AIAttributionPanel({ selectedImage }: { selectedImage: EvidenceItem | null | undefined }) {
  const [result, setResult] = useState<AttributionResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setResult(null);
    setError(null);
  }, [selectedImage?.id]);

  const runAttributionScan = useCallback(async () => {
    if (!selectedImage) return;
    setRunning(true);
    setError(null);
    setResult(null);

    try {
      const imgResponse = await fetch(selectedImage.previewUrl);
      if (!imgResponse.ok) {
        throw new Error(`Could not fetch evidence image (HTTP ${imgResponse.status}).`);
      }
      const blob = await imgResponse.blob();

      const contentType = blob.type || 'image/jpeg';
      const apiResponse = await fetch('/api/forensics/ai-attribution', {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: blob,
        signal: AbortSignal.timeout(40_000),
      });

      let payload: unknown;
      try {
        payload = await apiResponse.json();
      } catch {
        throw new Error('The attribution service returned an unreadable response.');
      }

      if (!apiResponse.ok) {
        const detail =
          payload &&
          typeof payload === 'object' &&
          'error' in payload &&
          typeof (payload as { error?: unknown }).error === 'string'
            ? (payload as { error: string }).error
            : `Attribution service failed (HTTP ${apiResponse.status}).`;
        throw new Error(detail);
      }

      setResult(payload as AttributionResult);
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.message.toLowerCase().includes('time limit') || err.message.toLowerCase().includes('timed out'))) {
        setError('Attribution analysis timed out (capped strictly at under 40 seconds).');
      } else {
        setError(err instanceof Error ? err.message : 'AI attribution scan failed.');
      }
    } finally {
      setRunning(false);
    }
  }, [selectedImage]);

  const verdictBadgeStyle = (verdict: AttributionResult['verdict']) => {
    switch (verdict) {
      case 'Confirmed':
        return 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300';
      case 'Likely':
        return 'border-amber-500/50 bg-amber-500/10 text-amber-300';
      case 'Weak hint':
        return 'border-sky-500/50 bg-sky-500/10 text-sky-300';
      case 'Not detected':
      default:
        return 'border-slate-600 bg-slate-800 text-slate-300';
    }
  };

  return (
    <div className="rounded-xl border border-sky-900/50 bg-slate-950/60 p-5 space-y-4">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <Fingerprint className="h-4 w-4 text-sky-400 shrink-0" />
          <h3 className="text-sm font-bold text-white">AI Image Attribution &amp; Provenance Inspector</h3>
        </div>
        <p className="mt-1.5 text-[11px] leading-5 text-slate-400">
          Runs 4-stage local offline forensic checks (Metadata, C2PA Content Credentials, Invisible Watermark, and Context)
          for OpenAI, Google Gemini, Midjourney, Stable Diffusion, ComfyUI, and Adobe Firefly / Photoshop.
        </p>
      </div>

      {/* Run button */}
      <button
        type="button"
        onClick={() => void runAttributionScan()}
        disabled={running || !selectedImage}
        className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {running ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
        {running ? 'Analyzing image provenance…' : 'Run AI attribution scan'}
      </button>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-950/20 p-3 text-xs text-rose-200">
          {error}
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500">Attribution Verdict</p>
              <div className="mt-1 flex items-center gap-2">
                <span className={`inline-block rounded-md border px-2.5 py-1 text-xs font-black uppercase ${verdictBadgeStyle(result.verdict)}`}>
                  {result.verdict}
                </span>
                {result.tools.length > 0 && (
                  <span className="text-sm font-bold text-white">
                    {result.tools.join(', ')}
                  </span>
                )}
              </div>
            </div>
          </div>

          {result.verdict === 'Not detected' && result.disclaimer && (
            <div className="rounded-lg border border-slate-700/60 bg-slate-950/80 p-3 text-xs leading-5 text-slate-300">
              {result.disclaimer}
            </div>
          )}

          {/* Breakdown of the 4 checks */}
          <div className="grid gap-2.5 pt-1 text-xs sm:grid-cols-2">
            {/* Check A */}
            <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
              <p className="font-semibold text-slate-300">Check A: Metadata &amp; Raw Bytes</p>
              <p className="mt-1 text-[11px] text-slate-400">
                {result.check_details.check_a_metadata.found ? (
                  <span className="text-emerald-300 font-semibold">Evidence detected</span>
                ) : (
                  <span className="text-slate-500">Nothing found</span>
                )}
              </p>
              {result.check_details.check_a_metadata.evidence.length > 0 && (
                <div className="mt-2 space-y-1">
                  {result.check_details.check_a_metadata.evidence.map((ev, i) => (
                    <div key={i} className="text-[10px] text-slate-400">
                      <span className="text-sky-300">{ev.field}:</span> {ev.value}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Check B */}
            <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
              <p className="font-semibold text-slate-300">Check B: C2PA Content Credentials</p>
              <p className="mt-1 text-[11px]">
                {result.check_details.check_b_c2pa.manifest_found ? (
                  <span className="text-emerald-300 font-semibold">
                    C2PA Manifest present ({result.check_details.check_b_c2pa.signer || 'Signed'})
                  </span>
                ) : (
                  <span className="text-slate-500">No C2PA manifest found</span>
                )}
              </p>
              {result.check_details.check_b_c2pa.claim_generator && (
                <p className="mt-1 text-[10px] text-slate-400">
                  Generator: {result.check_details.check_b_c2pa.claim_generator}
                </p>
              )}
            </div>

            {/* Check C */}
            <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
              <p className="font-semibold text-slate-300">Check C: Invisible Watermark</p>
              <p className="mt-1 text-[11px]">
                {result.check_details.check_c_invisible_watermark.found ? (
                  <span className="text-emerald-300 font-semibold">Stable Diffusion dwtDct payload found</span>
                ) : (
                  <span className="text-slate-500">Not found</span>
                )}
              </p>
              <p className="mt-1 text-[9px] leading-4 text-slate-500">
                {result.check_details.check_c_invisible_watermark.synthid_note}
              </p>
            </div>

            {/* Check D */}
            <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
              <p className="font-semibold text-slate-300">Check D: Filename Hints</p>
              <p className="mt-1 text-[11px]">
                {result.check_details.check_d_filename.found ? (
                  <span className="text-sky-300 font-semibold">
                    Hint matched ({result.check_details.check_d_filename.tools.join(', ')})
                  </span>
                ) : (
                  <span className="text-slate-500">No AI naming pattern</span>
                )}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type AddEvidence = (
  item: Omit<EvidenceItem, 'id' | 'createdAt'>,
  file: File | Blob,
  hashesPromise: Promise<{ sha256: string; md5: string }>,
) => Promise<EvidenceItem>;

interface AIImageDeepfakeLabProps {
  evidenceList: EvidenceItem[];
  selectedItem?: EvidenceItem;
  investigations: Investigation[];
  currentCase?: Investigation;
  onSelectEvidence: (item: EvidenceItem) => void;
  onAddEvidence: AddEvidence;
}

const MODEL_NAMES: Record<DeepSafeModelId, string> = {
  npr_deepfakedetection: 'NPR Deepfake Detection',
  universalfakedetect: 'UniversalFakeDetect',
};

const assessmentLabels: Record<DeepSafeImageAnalysis['ensemble']['assessment'], string> = {
  possible_ai_generated: 'Possible AI-generated or manipulated',
  non_flagged_consistent: 'More consistent with non-flagged photographic content',
  inconclusive: 'Inconclusive',
  analysis_failed: 'Analysis failed',
};

function getAssessmentLabel(analysis: DeepSafeImageAnalysis): string {
  if (analysis.analysis_version === '1.1.0' && analysis.ensemble.assessment === 'inconclusive') {
    return 'Scores only — no validated aggregate verdict';
  }
  return assessmentLabels[analysis.ensemble.assessment];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function readImageDimensions(fileOrUrl: File | string): Promise<{ width: number; height: number }> {
  const image = new Image();
  const objectUrl = typeof fileOrUrl === 'string' ? null : URL.createObjectURL(fileOrUrl);
  const source = objectUrl || fileOrUrl as string;
  return new Promise((resolve, reject) => {
    image.onload = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        reject(new Error('The image dimensions could not be read.'));
        return;
      }
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      reject(new Error('The browser could not decode this image.'));
    };
    image.src = source;
  });
}

function statusStyle(status: string): string {
  if (status === 'completed' || status === 'available') {
    return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300';
  }
  if (status === 'failed' || status === 'unavailable') {
    return 'border-rose-500/40 bg-rose-500/10 text-rose-300';
  }
  if (status === 'not_configured') {
    return 'border-amber-500/40 bg-amber-500/10 text-amber-300';
  }
  return 'border-slate-600 bg-slate-800 text-slate-300';
}

function ModelResultCard({
  result,
  running,
}: {
  result?: DeepSafeModelResult;
  running: boolean;
}) {
  const modelId = result?.model_id;
  const modelName = result?.model_name || (modelId ? MODEL_NAMES[modelId] : 'DeepSafe model');
  const status = running ? 'running' : result?.status || 'not_run';
  return (
    <article className="rounded-xl border border-slate-700/80 bg-slate-950/60 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-white">{modelName}</h3>
          <p className="mt-1 text-[11px] text-slate-500">
            Model manifest {result?.model_version || DEEPSAFE_MODEL_VERSION}
          </p>
        </div>
        <span className={`rounded-full border px-2 py-1 text-[10px] font-bold uppercase ${statusStyle(status)}`}>
          {status.replace(/_/g, ' ')}
        </span>
      </div>
      {running ? (
        <div className="flex items-center gap-2 text-xs text-cyan-300">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Running real model inference…
        </div>
      ) : result?.status === 'completed' ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-slate-900 p-3">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">Uncalibrated fake-class score</p>
              <p className="mt-1 font-mono text-lg font-bold text-white">
                {result.score === null ? '—' : formatDeepSafeScore(result.score)}
              </p>
            </div>
            <div className="rounded-lg bg-slate-900 p-3">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">Raw model logit</p>
              <p className="mt-1 font-mono text-lg font-bold text-white">
                {result.raw_logit?.toFixed(6) ?? 'Not reported'}
              </p>
            </div>
          </div>
          <p className="text-[11px] leading-5 text-slate-400">{result.score_meaning}</p>
          {result.inference_time_seconds !== null && (
            <p className="text-[10px] text-slate-500">
              Model runtime: {result.inference_time_seconds.toFixed(2)} s
            </p>
          )}
        </>
      ) : (
        <p className="text-xs leading-5 text-rose-200">
          {result?.error || 'No model output was returned. This is not a negative result.'}
        </p>
      )}
      {!running && result?.raw_output !== null && result?.raw_output !== undefined && (
        <details className="border-t border-slate-800 pt-2">
          <summary className="cursor-pointer text-[11px] font-semibold text-cyan-300">View raw model output</summary>
          <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-900 p-3 text-[10px] leading-4 text-slate-300">
            {JSON.stringify(result.raw_output, null, 2)}
          </pre>
        </details>
      )}
    </article>
  );
}

export const AIImageDeepfakeLab: React.FC<AIImageDeepfakeLabProps> = ({
  evidenceList,
  selectedItem,
  investigations,
  currentCase,
  onSelectEvidence,
  onAddEvidence,
}) => {
  const imageEvidence = evidenceList.filter((item) => item.mediaType === 'image');
  const selectedImage = selectedItem?.mediaType === 'image' ? selectedItem : undefined;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [targetInvestigationId, setTargetInvestigationId] = useState(currentCase?.id || investigations[0]?.id || '');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [health, setHealth] = useState<DeepSafeHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<DeepSafeImageAnalysis | null>(null);
  const [history, setHistory] = useState<DeepSafeImageAnalysis[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [analysisRunning, setAnalysisRunning] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (currentCase?.id && investigations.some((item) => item.id === currentCase.id)) {
      setTargetInvestigationId(currentCase.id);
    } else if (!investigations.some((item) => item.id === targetInvestigationId)) {
      setTargetInvestigationId(investigations[0]?.id || '');
    }
  }, [currentCase?.id, investigations, targetInvestigationId]);

  const refreshHealth = useCallback(async () => {
    setHealthLoading(true);
    setHealthError(null);
    try {
      setHealth(await fetchDeepSafeHealth());
    } catch (error) {
      setHealth(null);
      setHealthError(error instanceof Error ? error.message : 'DeepSafe health could not be checked.');
    } finally {
      setHealthLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  const refreshHistory = useCallback(async () => {
    if (!selectedImage) {
      setHistory([]);
      setHistoryError(null);
      setAnalysis(null);
      return;
    }
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const savedRuns = await syncFetchDeepSafeImageDetectionHistory(
        selectedImage.investigationId,
        selectedImage.id,
      );
      setHistory(savedRuns);
      setAnalysis((current) =>
        current?.evidence_id === selectedImage.id ? current : savedRuns[0] || null,
      );
    } catch (error) {
      setHistory([]);
      setHistoryError(error instanceof Error ? error.message : 'DeepSafe history could not be loaded.');
    } finally {
      setHistoryLoading(false);
    }
  }, [selectedImage?.id, selectedImage?.investigationId]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  const handleUpload = async (file?: File) => {
    if (!file) return;
    setUploadError(null);
    if (!targetInvestigationId) {
      setUploadError('Select or create an investigation before adding image evidence.');
      return;
    }
    if (file.size <= 0 || file.size > 25 * 1024 * 1024) {
      setUploadError('Choose a non-empty image no larger than 25 MB.');
      return;
    }
    const extension = file.name.split('.').pop()?.toLowerCase();
    const expectedMime = extension === 'png'
      ? 'image/png'
      : extension === 'jpg' || extension === 'jpeg'
        ? 'image/jpeg'
        : null;
    if (!expectedMime || (file.type && file.type !== expectedMime)) {
      setUploadError('DeepSafe supports JPEG/JPG and PNG images only.');
      return;
    }

    const normalizedFile = file.type === expectedMime
      ? file
      : new File([file], file.name, { type: expectedMime, lastModified: file.lastModified });
    const previewUrl = URL.createObjectURL(normalizedFile);
    setUploading(true);
    try {
      const dimensions = await readImageDimensions(normalizedFile);
      if (dimensions.width * dimensions.height > 30_000_000) {
        throw new Error('The image exceeds the 30-megapixel analysis limit.');
      }
      const [metadata, thumbnailUrl] = await Promise.all([
        extractMediaMetadata(normalizedFile),
        generateThumbnail(normalizedFile),
      ]);
      metadata.fileSizeBytes = normalizedFile.size;
      metadata.fileFormat = expectedMime;
      metadata.dimensions = dimensions;
      const hashesPromise = calculateEvidenceHashes(normalizedFile);
      const savedItem = await onAddEvidence(
        {
          investigationId: targetInvestigationId,
          userId: currentCase?.userId || '',
          fileName: normalizedFile.name,
          fileSize: normalizedFile.size,
          mimeType: expectedMime,
          mediaType: 'image',
          sha256Hash: '',
          storageUrl: previewUrl,
          previewUrl,
          thumbnailUrl: thumbnailUrl || undefined,
          isOriginal: false,
          verified: false,
          metadata,
        },
        normalizedFile,
        hashesPromise,
      );
      onSelectEvidence(savedItem);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'The image evidence could not be uploaded.');
    } finally {
      URL.revokeObjectURL(previewUrl);
      setUploading(false);
    }
  };

  const reusableAnalysis = selectedImage?.sha256Hash
    ? findReusableDeepSafeAnalysis(
      [ ...(analysis ? [analysis] : []), ...history ],
      selectedImage.investigationId,
      selectedImage.id,
      selectedImage.sha256Hash,
    )
    : null;

  const runAnalysis = async () => {
    if (!selectedImage) return;
    if (reusableAnalysis) {
      setAnalysis(reusableAnalysis);
      setSaveError(null);
      return;
    }

    setAnalysisRunning(true);
    setSaveError(null);
    const savedDimensions = selectedImage.metadata.dimensions;
    let dimensions = savedDimensions && savedDimensions.width && savedDimensions.height
      ? savedDimensions
      : null;
    try {
      if (!dimensions) dimensions = await readImageDimensions(selectedImage.previewUrl);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Image dimensions could not be read.');
    }
    if (!dimensions || !selectedImage.sha256Hash) {
      setAnalysisRunning(false);
      setSaveError('This evidence is missing a verified SHA-256 or image dimensions. Re-upload it through this lab.');
      return;
    }

    try {
      const result = await analyzeDeepSafeEvidence(selectedImage.investigationId, selectedImage.id);
      if (
        result.evidence_id !== selectedImage.id ||
        result.investigation_id !== selectedImage.investigationId ||
        result.image.sha256.toLowerCase() !== selectedImage.sha256Hash.toLowerCase()
      ) {
        throw new Error('The DeepSafe response did not match the selected evidence record.');
      }
      setAnalysis(result);
      try {
        await syncSaveDeepSafeImageDetection(result);
        await refreshHistory();
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : 'The analysis could not be saved to Supabase.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'DeepSafe image analysis failed.';
      const failedResult = createFailedDeepSafeAnalysis(
        {
          investigationId: selectedImage.investigationId,
          id: selectedImage.id,
          fileName: selectedImage.fileName,
          mimeType: selectedImage.mimeType,
          fileSize: selectedImage.fileSize,
          sha256Hash: selectedImage.sha256Hash,
          width: dimensions.width,
          height: dimensions.height,
        },
        message,
      );
      setAnalysis(failedResult);
      try {
        await syncSaveDeepSafeImageDetection(failedResult);
        await refreshHistory();
      } catch (saveError) {
        setSaveError(saveError instanceof Error ? saveError.message : 'The failed analysis could not be saved.');
      }
    } finally {
      setAnalysisRunning(false);
    }
  };

  const activeModelHealth = health?.models;
  const modelsStartingUp = Boolean(
    health?.available && Object.values(health.models).some((model) => !model.loaded),
  );

  return (
    <section className="space-y-5 rounded-2xl border border-cyan-900/50 bg-slate-950/60 p-4 shadow-xl shadow-black/20 sm:p-6">
      <header className="flex flex-col justify-between gap-4 border-b border-slate-800 pb-4 sm:flex-row sm:items-start">
        <div>
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-300">
            <FileImage className="h-4 w-4" />
            AI Image Deepfake Detection Lab
          </div>
          <h2 className="mt-1 text-xl font-black text-white">DeepSafe image screening</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-400">
            Runs NPR Deepfake Detection and UniversalFakeDetect on the preserved evidence image.
            Model scores are uncalibrated outputs, not proof of authenticity or manipulation.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshHealth()}
          disabled={healthLoading}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-cyan-500 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${healthLoading ? 'animate-spin' : ''}`} />
          Check models
        </button>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]">
        <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-300">
            <UploadCloud className="h-4 w-4 text-cyan-300" />
            Evidence intake
          </div>
          <label className="block text-[11px] text-slate-400" htmlFor="deepsafe-investigation">
            Investigation
          </label>
          <select
            id="deepsafe-investigation"
            value={targetInvestigationId}
            onChange={(event) => setTargetInvestigationId(event.target.value)}
            disabled={uploading || investigations.length === 0}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white disabled:opacity-50"
          >
            <option value="">Select an investigation</option>
            {investigations.map((investigation) => (
              <option key={investigation.id} value={investigation.id}>
                {investigation.caseNumber} — {investigation.title}
              </option>
            ))}
          </select>
          <input
            ref={fileInputRef}
            type="file"
            accept=".jpg,.jpeg,.png,image/jpeg,image/png"
            className="hidden"
            onChange={(event) => void handleUpload(event.target.files?.[0])}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || !targetInvestigationId}
            className="flex min-h-24 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-cyan-700/70 bg-slate-950/70 px-4 py-5 text-center text-xs text-slate-300 transition hover:border-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uploading ? <LoaderCircle className="h-5 w-5 animate-spin text-cyan-300" /> : <UploadCloud className="h-5 w-5 text-cyan-300" />}
            <span className="font-semibold">{uploading ? 'Preserving image evidence…' : 'Upload JPEG, JPG, or PNG evidence'}</span>
            <span className="text-[10px] text-slate-500">Maximum 25 MB · uploaded to the existing private evidence store</span>
          </button>
          {uploadError && <p role="alert" className="text-xs text-rose-300">{uploadError}</p>}
          {imageEvidence.length > 0 && (
            <>
              <label className="block text-[11px] text-slate-400" htmlFor="deepsafe-evidence">
                Or select an existing image evidence item
              </label>
              <select
                id="deepsafe-evidence"
                value={selectedImage?.id || ''}
                onChange={(event) => {
                  const item = imageEvidence.find((entry) => entry.id === event.target.value);
                  if (item) onSelectEvidence(item);
                }}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
              >
                <option value="">Select image evidence</option>
                {imageEvidence.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.fileName}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>

        <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="flex items-center justify-between gap-2 text-xs font-bold uppercase tracking-wide text-slate-300">
            <span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-cyan-300" /> Model services</span>
            {health?.available && <span className="text-[10px] font-semibold text-emerald-300">Both endpoints healthy</span>}
          </div>
          {healthError && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[11px] leading-5 text-amber-200">
              {healthError}
            </div>
          )}
          {(['npr_deepfakedetection', 'universalfakedetect'] as DeepSafeModelId[]).map((modelId) => {
            const model = activeModelHealth?.[modelId];
            return (
              <div key={modelId} className="flex items-center justify-between gap-3 rounded-lg bg-slate-950/80 p-3">
                <div>
                  <p className="text-xs font-semibold text-white">{MODEL_NAMES[modelId]}</p>
                  <p className="mt-1 text-[10px] text-slate-500">
                    {model ? `v${model.model_version}${model.loaded ? ' · loaded' : ' · loading at startup'}` : 'Status not checked'}
                  </p>
                </div>
                <span className={`rounded-full border px-2 py-1 text-[9px] font-bold uppercase ${statusStyle(model?.status || 'unknown')}`}>
                  {model?.status?.replace(/_/g, ' ') || 'unknown'}
                </span>
              </div>
            );
          })}
          <p className="text-[10px] leading-4 text-slate-500">
            Models preload at service startup and stay resident. Health means an endpoint responds; it does not mean a prediction has been made.
          </p>
          {modelsStartingUp && (
            <p role="status" className="text-[11px] leading-5 text-amber-200">
              Models are warming up. Analysis becomes available after both report loaded.
            </p>
          )}
        </div>
      </div>

      {selectedImage ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(220px,0.7fr)_minmax(0,1.3fr)]">
          <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-300">
              <FileImage className="h-4 w-4 text-cyan-300" /> Original evidence
            </div>
            <div className="flex min-h-44 items-center justify-center overflow-hidden rounded-lg border border-slate-800 bg-black">
              <img src={selectedImage.previewUrl} alt={`Original evidence ${selectedImage.fileName}`} className="max-h-80 max-w-full object-contain" />
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-[10px]">
              <dt className="text-slate-500">Filename</dt><dd className="break-all text-slate-200">{selectedImage.fileName}</dd>
              <dt className="text-slate-500">Format</dt><dd className="text-slate-200">{selectedImage.mimeType}</dd>
              <dt className="text-slate-500">Size</dt><dd className="text-slate-200">{formatBytes(selectedImage.fileSize)}</dd>
              <dt className="text-slate-500">Dimensions</dt>
              <dd className="text-slate-200">
                {selectedImage.metadata.dimensions
                  ? `${selectedImage.metadata.dimensions.width} × ${selectedImage.metadata.dimensions.height}`
                  : 'Read from original when analysis starts'}
              </dd>
              <dt className="text-slate-500">SHA-256</dt>
              <dd className="break-all font-mono text-cyan-200">{selectedImage.sha256Hash || 'Not available'}</dd>
            </dl>
            <button
              type="button"
              onClick={() => void runAnalysis()}
              disabled={analysisRunning || uploading || historyLoading || modelsStartingUp}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-cyan-500 px-4 py-2.5 text-xs font-black text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {analysisRunning ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}
              {analysisRunning
                ? 'Analyzing preserved evidence…'
                : modelsStartingUp
                  ? 'Models warming up…'
                  : reusableAnalysis
                    ? 'Use Saved Analysis'
                    : 'Start DeepSafe Analysis'}
            </button>
            {reusableAnalysis && (
              <p role="status" className="text-[10px] leading-4 text-slate-400">
                Reusing the completed result for this evidence SHA-256 and model version; no new evidence download or inference request is needed.
              </p>
            )}
            {saveError && <p role="alert" className="text-[11px] leading-5 text-rose-300">{saveError}</p>}
          </div>

          <div className="space-y-4">
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-300">
                  <ActivityIcon />
                  Individual model results
                </div>
                {analysis && (
                  <button
                    type="button"
                    onClick={() => downloadDeepSafeImageReport(analysis)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-[10px] font-semibold text-cyan-200 hover:border-cyan-500"
                  >
                    <Download className="h-3.5 w-3.5" /> Download PDF report
                  </button>
                )}
              </div>
              <div className="grid gap-3 xl:grid-cols-2">
                <ModelResultCard result={analysis?.models.npr_deepfakedetection} running={analysisRunning} />
                <ModelResultCard result={analysis?.models.universalfakedetect} running={analysisRunning} />
              </div>
            </div>

            {analysis && (
              <div className={`rounded-xl border p-4 ${
                analysis.ensemble.assessment === 'possible_ai_generated' || analysis.ensemble.assessment === 'analysis_failed'
                  ? 'border-rose-500/40 bg-rose-950/20'
                  : analysis.ensemble.assessment === 'non_flagged_consistent'
                    ? 'border-emerald-500/40 bg-emerald-950/20'
                    : 'border-amber-500/40 bg-amber-950/20'
              }`}>
                <div className="flex items-start gap-3">
                  {analysis.ensemble.assessment === 'non_flagged_consistent'
                    ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" />
                    : analysis.ensemble.assessment === 'inconclusive'
                      ? <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
                      : <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-300" />}
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Assessment status</p>
                    <h3 className="mt-1 text-lg font-black text-white">{getAssessmentLabel(analysis)}</h3>
                    <p className="mt-2 text-xs leading-5 text-slate-200">
                      {analysis.analysis_version === '1.1.0'
                        ? 'The models are reported independently. No thresholded classification or combined verdict is provided because a threshold has not been validated for this use.'
                        : 'This is a legacy result produced by the earlier thresholded voting workflow. Treat it as historical and not as a validated forensic verdict.'}
                    </p>
                    <p className="mt-2 text-[11px] leading-5 text-slate-400">{analysis.ensemble.method}</p>
                    <ul className="mt-3 space-y-2 text-xs leading-5 text-slate-200">
                      {analysis.ensemble.observations.map((observation, index) => (
                        <li key={`${index}-${observation}`} className="flex gap-2">
                          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-300" />
                          {observation}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-3 text-[10px] text-slate-500">
                      Processed {new Date(analysis.analyzed_at).toLocaleString()} · {analysis.processing_status} · {analysis.duration_ms} ms
                    </p>
                  </div>
                </div>
              </div>
            )}

            {analysis?.error_detail && (
              <div className="rounded-xl border border-rose-500/30 bg-rose-950/20 p-3 text-xs text-rose-200">
                {analysis.error_detail}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 p-8 text-center">
          <FileImage className="mx-auto h-8 w-8 text-slate-500" />
          <p className="mt-3 text-sm font-semibold text-slate-300">Upload or select an image evidence item to begin.</p>
          <p className="mt-1 text-xs text-slate-500">Video and audio evidence are not analyzed by this image module.</p>
        </div>
      )}

      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-300">
            <Clock3 className="h-4 w-4 text-cyan-300" /> Analysis history
          </h3>
          {historyLoading && <LoaderCircle className="h-4 w-4 animate-spin text-cyan-300" />}
        </div>
        {historyError && <p role="alert" className="text-xs text-amber-200">{historyError}</p>}
        {!historyError && history.length === 0 && (
          <p className="text-xs text-slate-500">
            {selectedImage ? 'No saved DeepSafe analyses for this evidence item.' : 'Select evidence to view its saved analysis history.'}
          </p>
        )}
        {history.length > 0 && (
          <div className="space-y-2">
            {history.map((item, index) => (
              <button
                type="button"
                key={`${item.analyzed_at}-${index}`}
                onClick={() => setAnalysis(item)}
                className={`grid w-full grid-cols-1 gap-2 rounded-lg border p-3 text-left transition sm:grid-cols-[1fr_auto_auto] sm:items-center ${
                  analysis?.analyzed_at === item.analyzed_at ? 'border-cyan-500/50 bg-cyan-500/5' : 'border-slate-800 bg-slate-950/50 hover:border-slate-600'
                }`}
              >
                <span className="text-xs font-semibold text-slate-200">{getAssessmentLabel(item)}</span>
                <span className="text-[10px] text-slate-400">{item.processing_status}</span>
                <span className="text-[10px] text-slate-500">{new Date(item.analyzed_at).toLocaleString()}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <LocalFaceDeepfakePanel selectedImage={selectedImage ?? null} />

      <AIAttributionPanel selectedImage={selectedImage ?? null} />

      <details className="rounded-xl border border-slate-800 bg-slate-900/30 p-4">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-300">
          <FileText className="h-4 w-4 text-cyan-300" /> Technical details and limitations
        </summary>
        <ul className="mt-3 space-y-2 text-[11px] leading-5 text-slate-400">
          <li>DeepSafe source revision: 2285e8aaa30b2df0508d570172643d1cae40703f. Model manifest versions are reported separately for each detector.</li>
          <li>Both models return a sigmoid-transformed fake-class logit and its raw logit. Higher fake-class scores indicate a stronger model output for the fake label; these values are not calibrated probabilities.</li>
          <li>No 0.5 decision threshold, hard voting, score averaging, or combined verdict is applied. Model outputs remain independent.</li>
          <li>NPR uses the upstream 256 × 256 test resize and ImageNet normalization. UniversalFakeDetect uses its upstream 224 center crop and CLIP normalization.</li>
          <li>The raw serving response may contain a default-threshold class field; VexaLens preserves it for audit but does not use it as a classification.</li>
          <li>JPEG/JPG and PNG only. Images are limited to 25 MB and 30 megapixels. The original remains in VexaLens private evidence storage.</li>
          <li>This screening does not localize manipulated regions and cannot establish that an image is genuine or fake.</li>
          <li>Failed model calls are recorded separately and are never converted into a non-flagged prediction.</li>
        </ul>
      </details>
    </section>
  );
};

function ActivityIcon() {
  return <ShieldCheck className="h-4 w-4 text-cyan-300" />;
}
