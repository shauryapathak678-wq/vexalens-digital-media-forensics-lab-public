import React, { useState, useEffect, useRef, useCallback } from 'react';
import { EvidenceItem, ELAParams, AnalysisFinding } from '@/types/forensics';
import { performELA, ELAResult } from '@/lib/forensics/ela';
import { formatShortHash } from '@/lib/forensics/crypto';
import { getEvidenceSignedUrl } from '@/lib/supabase-sync';
import { updateEvidenceItem } from '@/lib/storage';
import { generateThumbnail } from '@/lib/forensics/image';
import {
  estimateAgesInImage,
  type AgeEstimateResponse,
} from '@/lib/forensics/ageEstimator';
import {
  Sliders,
  Layers,
  ZoomIn,
  AlertTriangle,
  FileCheck2,
  Camera,
  Cpu,
  Clock,
  Plus,
  UserSearch,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Info,
  Upload,
} from 'lucide-react';

interface ImageForensicsViewProps {
  evidenceList: EvidenceItem[];
  selectedItem?: EvidenceItem;
  onSelectEvidence: (item: EvidenceItem) => void;
  onAddFinding: (finding: Omit<AnalysisFinding, 'id' | 'createdAt'>) => void;
}

export const ImageForensicsView: React.FC<ImageForensicsViewProps> = ({
  evidenceList,
  selectedItem,
  onSelectEvidence,
  onAddFinding,
}) => {
  const imagesOnly = evidenceList.filter((e) => e.mediaType === 'image');
  const activeItem = selectedItem || imagesOnly[0];

  const [activeTab, setActiveTab] = useState<'ela' | 'metadata' | 'age_estimate'>('ela');
  const [elaParams, setElaParams] = useState<ELAParams>({
    quality: 0.95,
    diffGain: 1,
    colorChannel: 'rgb',
    invert: false,
    luminanceOnly: false,
    zThreshold: 6,
  });

  const [elaResult, setElaResult] = useState<ELAResult | null>(null);
  const [isProcessingELA, setIsProcessingELA] = useState(false);
  const [elaError, setElaError] = useState<string | null>(null);
  const [displayImageUrl, setDisplayImageUrl] = useState<string>('');
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  const [isResolvingImage, setIsResolvingImage] = useState(false);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [viewMode, setViewMode] = useState<'side_by_side' | 'ela_only' | 'original_only'>('side_by_side');

  // ── Age Estimator state ──────────────────────────────────────────────────
  const [ageResult, setAgeResult] = useState<AgeEstimateResponse | null>(null);
  const [ageResultEvidenceId, setAgeResultEvidenceId] = useState<string | null>(null);
  const [isEstimatingAge, setIsEstimatingAge] = useState(false);
  const [ageError, setAgeError] = useState<string | null>(null);
  const [selfReportedGender, setSelfReportedGender] = useState<Record<number, string>>({});
  const [selfReportedGenderCustom, setSelfReportedGenderCustom] = useState<Record<number, string>>({});
  const ageImgRef = useRef<HTMLImageElement>(null);
  const ageCanvasRef = useRef<HTMLCanvasElement>(null);

  // ── Image Source Resolution with Multi-tier Fallback ───────────────────
  useEffect(() => {
    if (!activeItem) {
      setDisplayImageUrl('');
      setElaResult(null);
      setImageDimensions(null);
      setElaError(null);
      setImageLoadFailed(false);
      return;
    }

    let isMounted = true;
    setIsResolvingImage(true);
    setImageLoadFailed(false);
    setElaError(null);

    const resolveCandidate = async () => {
      // Tier 1: Check previewUrl
      if (activeItem.previewUrl) {
        if (activeItem.previewUrl.startsWith('blob:')) {
          try {
            const probe = await fetch(activeItem.previewUrl, { method: 'HEAD' });
            if (probe.ok || probe.type === 'basic') {
              if (isMounted) {
                setDisplayImageUrl(activeItem.previewUrl);
                setIsResolvingImage(false);
              }
              return;
            }
          } catch {
            // Blob URL expired or inaccessible across sessions
          }
        } else {
          if (isMounted) {
            setDisplayImageUrl(activeItem.previewUrl);
            setIsResolvingImage(false);
          }
          return;
        }
      }

      // Tier 2: Refresh signed URL from Supabase storage if storageUrl is available
      if (activeItem.storageUrl) {
        try {
          const signed = await getEvidenceSignedUrl(activeItem.storageUrl);
          if (signed) {
            if (isMounted) {
              setDisplayImageUrl(signed);
              setIsResolvingImage(false);
            }
            return;
          }
        } catch {}
      }

      // Tier 3: Use durable base64 thumbnail if available
      if (activeItem.thumbnailUrl) {
        if (isMounted) {
          setDisplayImageUrl(activeItem.thumbnailUrl);
          setIsResolvingImage(false);
        }
        return;
      }

      // Tier 4: Direct storageUrl if it looks like an absolute URL
      if (activeItem.storageUrl && /^https?:\/\//i.test(activeItem.storageUrl)) {
        if (isMounted) {
          setDisplayImageUrl(activeItem.storageUrl);
          setIsResolvingImage(false);
        }
        return;
      }

      if (isMounted) {
        setDisplayImageUrl(activeItem.previewUrl || '');
        setIsResolvingImage(false);
      }
    };

    resolveCandidate();

    return () => {
      isMounted = false;
    };
  }, [activeItem?.id, activeItem?.previewUrl, activeItem?.thumbnailUrl, activeItem?.storageUrl]);

  // ── Trigger ELA calculation when active image source or parameters change ───
  useEffect(() => {
    if (!displayImageUrl) {
      setElaResult(null);
      setIsProcessingELA(false);
      return;
    }

    let isMounted = true;
    setIsProcessingELA(true);
    setElaError(null);

    const runELA = async () => {
      try {
        const result = await performELA(
          displayImageUrl,
          elaParams,
          activeItem?.fileName || 'evidence.jpg',
          activeItem?.metadata,
          activeItem?.mimeType,
          displayImageUrl
        );
        if (isMounted) {
          setElaResult(result);
          setImageDimensions({ width: result.width, height: result.height });
          setElaError(null);
        }
      } catch (err: any) {
        console.error('ELA computation error:', err);
        if (isMounted) {
          setElaResult(null);
          setElaError(err?.message || 'Error Level Analysis computation failed.');

          // If the failed image was previewUrl and thumbnailUrl is available, automatically try thumbnailUrl
          if (
            displayImageUrl === activeItem?.previewUrl &&
            activeItem?.thumbnailUrl &&
            activeItem.thumbnailUrl !== displayImageUrl
          ) {
            setDisplayImageUrl(activeItem.thumbnailUrl);
          }
        }
      } finally {
        if (isMounted) {
          setIsProcessingELA(false);
        }
      }
    };

    const timer = setTimeout(() => {
      runELA();
    }, 30);

    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [
    displayImageUrl,
    elaParams.quality,
    elaParams.diffGain,
    elaParams.zThreshold,
    elaParams.colorChannel,
    elaParams.invert,
    elaParams.luminanceOnly,
    activeItem?.fileName,
    activeItem?.mimeType,
  ]);

  const handleImageLoadError = async () => {    // If previewUrl failed in <img>, try fresh signed URL or thumbnailUrl
    if (activeItem?.storageUrl && displayImageUrl !== activeItem.storageUrl) {
      try {
        const freshSignedUrl = await getEvidenceSignedUrl(activeItem.storageUrl);
        if (freshSignedUrl && freshSignedUrl !== displayImageUrl) {
          setDisplayImageUrl(freshSignedUrl);
          return;
        }
      } catch {}
    }

    if (activeItem?.thumbnailUrl && displayImageUrl !== activeItem.thumbnailUrl) {
      setDisplayImageUrl(activeItem.thumbnailUrl);
      return;
    }

    setImageLoadFailed(true);
    setElaError('Image file could not be loaded from storage or session cache.');
    setIsProcessingELA(false);
  };

  const handleImageLoaded = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth && img.naturalHeight) {
      setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight });
    }
    setImageLoadFailed(false);
  };

  const handleRelinkImageFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeItem) return;

    try {
      const newBlobUrl = URL.createObjectURL(file);
      const newThumbnail = await generateThumbnail(file);

      // Update in activeItem and local storage
      activeItem.previewUrl = newBlobUrl;
      if (newThumbnail) activeItem.thumbnailUrl = newThumbnail;

      updateEvidenceItem(activeItem.id, {
        previewUrl: newBlobUrl,
        thumbnailUrl: newThumbnail || activeItem.thumbnailUrl,
      });

      setDisplayImageUrl(newBlobUrl);
      setImageLoadFailed(false);
      setElaError(null);
    } catch (err: any) {
      alert('Failed to read selected image file: ' + (err?.message || 'Unknown error'));
    }
  };

  const triggerRetryELA = () => {
    if (displayImageUrl) {
      const current = displayImageUrl;
      setDisplayImageUrl('');
      setTimeout(() => setDisplayImageUrl(current), 50);
    }
  };

  const handleRecordELAFinding = () => {
    if (!activeItem || !elaResult) return;
    onAddFinding({
      investigationId: activeItem.investigationId,
      evidenceId: activeItem.id,
      title: `ELA diagnostic on ${activeItem.fileName}: ${elaResult.ela_verdict.replace(/_/g, ' ')}`,
      severity: 'nominal',
      category: 'compression',
      observedEvidence: `Reliability: ${elaResult.reliability}. ELA verdict: ${elaResult.ela_verdict}.`,
      plainEnglishSummary: 'This records differences introduced by recompressing the image for ELA. The measurement alone does not establish editing, authenticity, or AI origin.',
      detectionMethod: `JPEG ELA with ${elaResult.metrics?.blockSize}px blocks and z>${elaResult.metrics?.zThreshold}`,
      limitations: 'ELA does not establish AI origin or authenticity. Recompression, platform sharing, or editing can affect the measurements; reliability reasons and confidence must be considered.',
      detectorVersion: 'VexaLens-ELA-Engine-v2.1',
    });
    alert('ELA diagnostic recorded. It is not a manipulation classification.');
  };

  useEffect(() => {
    setAgeResult(null);
    setAgeResultEvidenceId(null);
    setAgeError(null);
    setSelfReportedGender({});
    setSelfReportedGenderCustom({});
  }, [activeItem?.id]);

  // ── Age Estimator: draw source-pixel face boxes on the preview ───────────
  useEffect(() => {
    if (
      !ageResult
      || ageResultEvidenceId !== activeItem?.id
      || !ageResult.faces.length
      || !ageImgRef.current
      || !ageCanvasRef.current
    ) return;

    const img = ageImgRef.current;
    const canvas = ageCanvasRef.current;

    const draw = () => {
      const { naturalWidth: nw, naturalHeight: nh } = img;
      const { offsetWidth: dw, offsetHeight: dh } = img;
      if (!nw || !nh || !dw || !dh) return;

      canvas.width = dw;
      canvas.height = dh;
      canvas.style.width = `${dw}px`;
      canvas.style.height = `${dh}px`;

      const scaleX = dw / nw;
      const scaleY = dh / nh;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, dw, dh);

      ageResult.faces.forEach((face) => {
        const [x, y, width, height] = face.bbox;
        const rx = x * scaleX;
        const ry = y * scaleY;
        const rw = Math.max(12, width * scaleX);
        const rh = Math.max(12, height * scaleY);

        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = 2;
        ctx.shadowColor = '#22d3ee88';
        ctx.shadowBlur = 6;
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.shadowBlur = 0;

        const label = `Face ${face.face_number}: ${face.age_range || 'Unable to estimate'}`;
        ctx.font = 'bold 12px system-ui';
        const tw = ctx.measureText(label).width;
        const lx = rx;
        const ly = ry > 20 ? ry - 5 : ry + rh + 16;
        ctx.fillStyle = 'rgba(8,25,45,0.85)';
        ctx.fillRect(lx - 2, ly - 13, tw + 8, 18);
        ctx.fillStyle = '#22d3ee';
        ctx.fillText(label, lx + 2, ly);
      });
    };

    if (img.complete && img.naturalWidth) draw();
    img.addEventListener('load', draw);
    window.addEventListener('resize', draw);
    return () => {
      img.removeEventListener('load', draw);
      window.removeEventListener('resize', draw);
    };
  }, [activeItem?.id, ageResult, ageResultEvidenceId, displayImageUrl]);

  const handleRunAgeEstimate = useCallback(async () => {
    const targetUrl = displayImageUrl || activeItem?.previewUrl || activeItem?.thumbnailUrl;
    if (!targetUrl || !activeItem) return;
    setIsEstimatingAge(true);
    setAgeError(null);
    setAgeResult(null);

    try {
      const resp = await fetch(targetUrl);
      if (!resp.ok) throw new Error(`Could not read the evidence image (HTTP ${resp.status}).`);
      const blob = await resp.blob();
      const file = new File([blob], activeItem.fileName, { type: blob.type || 'image/jpeg' });
      const result = await estimateAgesInImage(file);
      if (result.status === 'error') {
        setAgeError(result.message || 'Local age estimation service request failed.');
      } else {
        setAgeResult(result);
        setAgeResultEvidenceId(activeItem.id);
      }
    } catch (error: unknown) {
      setAgeError(error instanceof Error ? error.message : 'Local age estimation request failed.');
    } finally {
      setIsEstimatingAge(false);
    }
  }, [activeItem, displayImageUrl]);

  const handleRecordAgeFinding = () => {
    if (!activeItem || !ageResult || ageResultEvidenceId !== activeItem.id) return;

    const observations = ageResult.faces.map((face) => ({
      face_number: face.face_number,
      bbox: face.bbox,
      detector_score: face.detection_confidence,
      quality: face.quality,
      apparent_age_group: face.age_range,
      self_reported_gender: selfReportedGender[face.face_number] === 'Self-described'
        ? selfReportedGenderCustom[face.face_number] || 'Self-described (no detail supplied)'
        : selfReportedGender[face.face_number] || null,
    }));
    onAddFinding({
      investigationId: activeItem.investigationId,
      evidenceId: activeItem.id,
      title: `Local apparent-age assessment: ${activeItem.fileName}`,
      severity: 'nominal',
      category: 'metadata',
      observedEvidence: JSON.stringify({
        model_name: ageResult.model_name,
        face_detector_name: ageResult.face_detector_name,
        model_version: ageResult.model_version,
        processed_at: ageResult.processed_at,
        image_size: ageResult.image_size,
        faces: observations,
        limitations: ageResult.limitations,
      }),
      plainEnglishSummary: 'A local model assigned broad apparent-age groups to detected faces. These are uncertain model predictions, not verified or actual ages.',
      detectionMethod: 'Local OpenCV DNN face detection and 8-class apparent-age group classification',
      detectorVersion: ageResult.model_version || 'Model version unavailable',
      evidenceLabel: 'model_prediction',
      sourceSha256: activeItem.sha256Hash,
      methodReliability: 'The model output is not calibrated; no age-confidence percentage is reported.',
      potentialFalsePositives: 'Face detection errors, blur, exposure, pose, occlusion, and model population limits can affect the result.',
      unresolvedQuestions: 'The model does not assess face angle or occlusion and has not been validated here across demographic subgroups.',
      recommendedNextSteps: 'Treat age groups as investigative observations only; do not use them to establish identity or actual age.',
      limitations: (ageResult.limitations || []).join(' '),
    });
    alert('Apparent-age observations recorded against this evidence item.');
  };

  if (!activeItem) {
    return (
      <div className="p-8 text-center space-y-3">
        <p className="text-slate-400 text-sm">No image evidence available in this investigation.</p>
      </div>
    );
  }

  const meta = activeItem.metadata;
  const reliabilityStyle = elaResult?.reliability === 'high'
    ? 'border-emerald-700 bg-emerald-950/40 text-emerald-300'
    : elaResult?.reliability === 'medium'
    ? 'border-amber-700 bg-amber-950/40 text-amber-300'
    : 'border-rose-700 bg-rose-950/40 text-rose-300';
  const verdictLabels = {
    no_local_edits_detected: 'No localized ELA anomalies detected',
    possible_local_edit: 'Localized ELA anomaly detected',
    global_recompression: 'Global recompression pattern',
    not_reliable: 'ELA not reliable for this file',
  } as const;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Top Evidence Selector Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-mono text-cyan-400">
            <span>IMAGE FORENSICS & RASTER AUDITING</span>
            <span className="text-slate-600">/</span>
            <span className="text-slate-300">{activeItem.fileName}</span>
          </div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100 mt-1">
            Error Level Analysis & EXIF Inspector
          </h1>
        </div>

        {/* Image evidence selector dropdown */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400">Evidence File:</label>
          <select
            value={activeItem.id}
            onChange={(e) => {
              const target = imagesOnly.find((img) => img.id === e.target.value);
              if (target) onSelectEvidence(target);
            }}
            className="bg-slate-900 border border-slate-800 rounded px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
          >
            {imagesOnly.map((img) => (
              <option key={img.id} value={img.id}>
                {img.fileName} ({img.isOriginal ? 'Baseline' : 'Suspect'})
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`rounded border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${elaResult ? reliabilityStyle : 'border-slate-700 bg-slate-800 text-slate-400'}`}>
            ELA reliability: {elaResult?.reliability || 'pending'}
          </span>
          <div className="text-lg font-semibold text-slate-100">
            {elaResult ? verdictLabels[elaResult.ela_verdict] : 'ELA analysis pending'}
          </div>
        </div>
        {elaResult?.reliability_reasons.length ? (
          <ul className="list-disc pl-5 text-xs text-amber-200/90 space-y-1">
            {elaResult.reliability_reasons.map((reason, index) => <li key={index}>{reason}</li>)}
          </ul>
        ) : null}
        <p className="text-xs text-slate-300 leading-relaxed">
          ELA detects local edits in JPEGs. It cannot prove an image is AI-generated or authentic, and it is unreliable on files re-shared through WhatsApp or social apps.
        </p>
        {elaResult && (
          <details className="border-t border-slate-800 pt-2 text-xs">
            <summary className="cursor-pointer font-semibold text-cyan-300">Why this verdict</summary>
            <div className="mt-2 space-y-1 text-slate-400">
              <p>File format: {elaResult.exif_summary.format}; EXIF present: {elaResult.exif_summary.hasExif ? 'yes' : 'no'}; estimated JPEG quality: {elaResult.exif_summary.estimatedJpegQuality ?? 'unavailable'}.</p>
              <p>Block size: {elaResult.metrics?.blockSize ?? 'n/a'} px; threshold: z &gt; {elaResult.metrics?.zThreshold ?? 'n/a'}; anomalous blocks: {elaResult.metrics?.anomalousBlocks ?? 0}/{elaResult.metrics?.totalBlocks ?? 0}; coverage: {elaResult.metrics?.coveragePct ?? 0}%.</p>
              <p>Median block difference: {elaResult.metrics?.medianBlockDiff ?? 'n/a'}; scaled MAD: {elaResult.metrics?.scaledMAD ?? 'n/a'}; 99th-percentile difference: {elaResult.metrics?.p99Diff ?? 'n/a'}.</p>
            </div>
          </details>
        )}
      </div>

      {/* Tabs: ELA vs Metadata */}
      <div className="flex items-center justify-between border-b border-slate-800">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('ela')}
            className={`px-4 py-2 text-xs font-semibold border-b-2 transition-colors ${
              activeTab === 'ela'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Error Level Analysis (ELA)
          </button>
          <button
            onClick={() => setActiveTab('metadata')}
            className={`px-4 py-2 text-xs font-semibold border-b-2 transition-colors ${
              activeTab === 'metadata'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Metadata & Inconsistencies ({meta?.inconsistenciesDetected?.length || 0})
          </button>
          <button
            onClick={() => setActiveTab('age_estimate')}
            className={`px-4 py-2 text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
              activeTab === 'age_estimate'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <UserSearch className="w-3.5 h-3.5" />
            Age Estimator
          </button>
        </div>

        <div className="text-xs text-slate-400 font-mono hidden sm:block">
          SHA-256: {formatShortHash(activeItem.sha256Hash, 8, 8)}
        </div>
      </div>

      {activeTab === 'ela' ? (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Controls Panel (1 col) */}
          <div className="p-4 rounded-lg bg-slate-900/60 border border-slate-800 space-y-5">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-200 uppercase tracking-wider">
              <Sliders className="w-4 h-4 text-cyan-400" />
              <span>ELA Parameters</span>
            </div>

            {/* Quality Slider */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">JPEG Resave Quality:</span>
                <span className="font-mono text-cyan-300 font-medium">
                  {Math.round(elaParams.quality * 100)}%
                </span>
              </div>
              <input
                type="range"
                min="0.9"
                max="0.95"
                step="0.01"
                value={elaParams.quality}
                onChange={(e) =>
                  setElaParams((prev) => ({ ...prev, quality: parseFloat(e.target.value) }))
                }
                className="w-full accent-cyan-400 cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-slate-400">
                <span>90%</span>
                <span>95% (default)</span>
              </div>
              {elaParams.quality < 0.9 && (
                <p className="text-[10px] text-amber-300">Quality below 90% can add recompression artifacts.</p>
              )}
            </div>

            {/* Gain Amplifier */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">Amplification (after auto-normalization):</span>
                <span className="font-mono text-cyan-300 font-medium">{elaParams.diffGain}x</span>
              </div>
              <input
                type="range"
                min="1"
                max="10"
                step="1"
                value={elaParams.diffGain}
                onChange={(e) =>
                  setElaParams((prev) => ({ ...prev, diffGain: parseInt(e.target.value, 10) }))
                }
                className="w-full accent-cyan-400 cursor-pointer"
              />
            </div>

            {/* Channel Isolation */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-400">Color Channel Isolation:</label>
              <div className="grid grid-cols-2 gap-1.5">
                {[
                  { id: 'rgb', label: 'All Channels' },
                  { id: 'r', label: 'Red Channel' },
                  { id: 'g', label: 'Green Channel' },
                  { id: 'b', label: 'Blue Channel' },
                ].map((ch) => (
                  <button
                    key={ch.id}
                    onClick={() =>
                      setElaParams((prev) => ({
                        ...prev,
                        colorChannel: ch.id as any,
                        luminanceOnly: false,
                      }))
                    }
                    className={`px-2 py-1 text-xs rounded border transition-colors ${
                      elaParams.colorChannel === ch.id && !elaParams.luminanceOnly
                        ? 'bg-slate-800 text-cyan-300 border-cyan-500/50'
                        : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
                    }`}
                  >
                    {ch.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Luminance & Invert Toggles */}
            <div className="space-y-2 pt-2 border-t border-slate-800/80">
              <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={elaParams.luminanceOnly}
                  onChange={(e) =>
                    setElaParams((prev) => ({ ...prev, luminanceOnly: e.target.checked }))
                  }
                  className="rounded bg-slate-950 border-slate-800 text-cyan-500 focus:ring-0"
                />
                <span>Luminance (Grayscale Error)</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={elaParams.invert}
                  onChange={(e) =>
                    setElaParams((prev) => ({ ...prev, invert: e.target.checked }))
                  }
                  className="rounded bg-slate-950 border-slate-800 text-cyan-500 focus:ring-0"
                />
                <span>Invert Error Colormap</span>
              </label>
            </div>

            {/* Computed Metrics */}
            {elaResult && (
              <div className="p-3 rounded bg-slate-950 border border-slate-800/80 space-y-1.5 text-xs font-mono">
                <div className="text-[11px] text-slate-400 font-sans font-medium uppercase tracking-wider">
                  Quantization Metrics
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Median block difference:</span>
                  <span className="text-slate-200 tabular-nums">{elaResult.metrics?.medianBlockDiff ?? 'n/a'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Scaled MAD:</span>
                  <span className="text-slate-200 tabular-nums">{elaResult.metrics?.scaledMAD ?? 'n/a'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">99th percentile difference:</span>
                  <span className="text-cyan-400 tabular-nums">{elaResult.metrics?.p99Diff ?? 'n/a'}</span>
                </div>
              </div>
            )}

            <button
              onClick={handleRecordELAFinding}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded transition-colors shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Record Finding in Case</span>
            </button>
          </div>

          {/* Viewport & Canvases (3 cols) */}
          <div className="lg:col-span-3 space-y-3">
            {/* View Mode Toolbar */}
            <div className="flex items-center justify-between p-2 rounded bg-slate-900/60 border border-slate-800 text-xs">
              <div className="flex items-center gap-1 flex-wrap">
                {[
                  { id: 'side_by_side', label: 'Side by Side' },
                  { id: 'ela_only', label: 'ELA Canvas' },
                  { id: 'original_only', label: 'Original Source' },
                ].map((mode) => (
                  <button
                    key={mode.id}
                    onClick={() => setViewMode(mode.id as any)}
                    className={`px-2.5 py-1 rounded transition-colors ${
                      viewMode === mode.id
                        ? 'bg-slate-800 text-cyan-300'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {mode.label}
                  </button>
                ))}

              </div>

              <div className="text-xs text-slate-400">
                {isProcessingELA ? (
                  <span className="text-cyan-400 animate-pulse flex items-center gap-1.5">
                    <RefreshCw className="w-3 h-3 animate-spin" />
                    <span>Rendering ELA Diff...</span>
                  </span>
                ) : elaError ? (
                  <span className="text-rose-400 flex items-center gap-1.5">
                    <AlertTriangle className="w-3 h-3" />
                    <span>ELA Failed</span>
                  </span>
                ) : elaResult ? (
                  <span>Ready ({elaResult.width}×{elaResult.height} px)</span>
                ) : (
                  <span>Standby</span>
                )}
              </div>
            </div>

            {/* Display Area */}
            <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 min-h-[460px] flex items-center justify-center">
              {viewMode === 'side_by_side' ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full">
                  <div className="space-y-1.5 text-center">
                    <div className="text-xs font-mono text-slate-400 flex items-center justify-center gap-1.5">
                      <span>Original Raster</span>
                      {imageDimensions && (
                        <span className="text-slate-500 text-[10px]">({imageDimensions.width}×{imageDimensions.height} px)</span>
                      )}
                    </div>
                    <div className="relative rounded overflow-hidden border border-slate-800 bg-slate-900/50 flex items-center justify-center min-h-[320px]">
                      {displayImageUrl && !imageLoadFailed ? (
                        <div className="relative inline-block max-h-[380px]">
                          <img
                            src={displayImageUrl}
                            alt="Original"
                            onLoad={handleImageLoaded}
                            onError={handleImageLoadError}
                            className="max-h-[380px] w-auto object-contain block"
                          />
                        </div>
                      ) : (
                        <div className="p-6 text-center space-y-3">
                          <AlertTriangle className="w-8 h-8 text-amber-400/80 mx-auto" />
                          <div className="text-xs text-slate-300 font-semibold">Image Source Unavailable</div>
                          <p className="text-[11px] text-slate-400 max-w-xs mx-auto">
                            The original preview URL expired or could not be loaded from storage.
                          </p>
                          <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold cursor-pointer transition-colors shadow-sm">
                            <Upload className="w-3.5 h-3.5" />
                            <span>Relink / Upload File</span>
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={handleRelinkImageFile}
                            />
                          </label>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="space-y-1.5 text-center">
                    <div className="text-xs font-mono text-cyan-400 flex items-center justify-center gap-1">
                      <Layers className="w-3 h-3" />
                      <span>ELA Differential Heatmap</span>
                    </div>
                    <div className="relative rounded overflow-hidden border border-slate-800 bg-black flex items-center justify-center min-h-[320px]">
                      {isProcessingELA ? (
                        <div className="p-8 text-xs text-slate-400 flex flex-col items-center justify-center gap-2">
                          <RefreshCw className="w-6 h-6 text-cyan-400 animate-spin" />
                          <span>Computing Error Level Analysis...</span>
                          <span className="text-[11px] text-slate-500">
                            Quantizing JPEG stream at {Math.round(elaParams.quality * 100)}% quality
                          </span>
                        </div>
                      ) : elaResult ? (
                        <div className="relative inline-block max-h-[380px]">
                          <img
                            src={elaResult.dataUrl}
                            alt="ELA Heatmap"
                            className="max-h-[380px] w-auto object-contain block"
                          />
                        </div>
                      ) : elaError ? (
                        <div className="p-6 text-xs text-center space-y-3">
                          <div className="text-rose-400 flex items-center justify-center gap-2 font-medium">
                            <AlertTriangle className="w-4 h-4" />
                            <span>ELA Calculation Issue</span>
                          </div>
                          <p className="text-slate-400 max-w-xs mx-auto">{elaError}</p>
                          <button
                            type="button"
                            onClick={triggerRetryELA}
                            className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-cyan-400 text-xs font-semibold"
                          >
                            Retry Analysis
                          </button>
                        </div>
                      ) : (
                        <div className="p-8 text-xs text-slate-400">Waiting for image raster...</div>
                      )}
                    </div>
                  </div>
                </div>
              ) : viewMode === 'ela_only' ? (
                <div className="w-full flex items-center justify-center min-h-[320px]">
                  {isProcessingELA ? (
                    <div className="p-8 text-xs text-slate-400 flex flex-col items-center justify-center gap-2">
                      <RefreshCw className="w-6 h-6 text-cyan-400 animate-spin" />
                      <span>Computing Error Level Analysis...</span>
                    </div>
                  ) : elaResult ? (
                    <div className="relative inline-block max-h-[500px]">
                      <img
                        src={elaResult.dataUrl}
                        alt="ELA Heatmap"
                        className="max-h-[500px] w-auto object-contain border border-slate-800 rounded block"
                      />
                    </div>
                  ) : elaError ? (
                    <div className="p-6 text-xs text-center space-y-3">
                      <div className="text-rose-400 flex items-center justify-center gap-2 font-medium">
                        <AlertTriangle className="w-4 h-4" />
                        <span>ELA Calculation Issue</span>
                      </div>
                      <p className="text-slate-400 max-w-xs mx-auto">{elaError}</p>
                      <button
                        type="button"
                        onClick={triggerRetryELA}
                        className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-cyan-400 text-xs font-semibold"
                      >
                        Retry Analysis
                      </button>
                    </div>
                  ) : (
                    <div className="text-xs text-slate-400">Waiting for image raster...</div>
                  )}
                </div>
              ) : (
                <div className="w-full flex items-center justify-center min-h-[320px]">
                  {displayImageUrl && !imageLoadFailed ? (
                    <div className="relative inline-block max-h-[500px]">
                      <img
                        src={displayImageUrl}
                        alt="Original"
                        onLoad={handleImageLoaded}
                        onError={handleImageLoadError}
                        className="max-h-[500px] w-auto object-contain border border-slate-800 rounded block"
                      />
                    </div>
                  ) : (
                    <div className="p-6 text-center space-y-3">
                      <AlertTriangle className="w-8 h-8 text-amber-400/80 mx-auto" />
                      <div className="text-xs text-slate-300 font-semibold">Image Source Unavailable</div>
                      <p className="text-[11px] text-slate-400 max-w-xs mx-auto">
                        The original preview URL expired or could not be loaded from storage.
                      </p>
                      <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold cursor-pointer transition-colors shadow-sm">
                        <Upload className="w-3.5 h-3.5" />
                        <span>Relink / Upload File</span>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={handleRelinkImageFile}
                        />
                      </label>
                    </div>
                  )}
                </div>
              )}
            </div>

            {elaResult && (
              <div className="flex items-center gap-3 px-1 text-[10px] text-slate-400">
                <span>Lower relative error</span>
                <div className="h-2 flex-1 rounded" style={{ background: 'linear-gradient(to right, #0f172a, #1e3a8a, #0e7490, #10b981, #eab308, #f97316, #ef4444)' }} />
                <span>Higher (99th-percentile scaled)</span>
                <span className="font-mono text-slate-500">p99: {elaResult.metrics?.p99Diff ?? 'n/a'}</span>
              </div>
            )}

            {/* Forensic Reading Interpretation Notes */}
            <div className="p-3.5 rounded bg-slate-900/40 border border-slate-800 text-xs text-slate-400 leading-relaxed space-y-1">
              <span className="text-slate-200 font-semibold">How to read Error Level Analysis:</span>
              <p>
                Brighter colors indicate larger JPEG resave differences relative to the image&apos;s 99th-percentile difference.
                ELA patterns are affected by image content and recompression; a highlighted block is a lead for review, not proof of editing.
              </p>
            </div>
          </div>
        </div>
      ) : activeTab === 'metadata' ? (
        /* Metadata Inspector Tab */
        <div className="space-y-6">
          {/* Inconsistencies Warnings */}
          {meta?.inconsistenciesDetected && meta.inconsistenciesDetected.length > 0 && (
            <div className="p-4 rounded-lg bg-rose-950/20 border border-rose-800/60 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-rose-300">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>Forensic Inconsistencies & Post-Processing Flags Detected</span>
              </div>
              <ul className="list-disc list-inside space-y-1 text-xs text-rose-200/90 pl-1">
                {meta.inconsistenciesDetected.map((issue, idx) => (
                  <li key={idx}>{issue}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Technical Metadata Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Camera & Hardware */}
            <div className="p-4 rounded-lg bg-slate-900/60 border border-slate-800 space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200 uppercase tracking-wider">
                <Camera className="w-4 h-4 text-cyan-400" />
                <span>Camera & Optical Hardware</span>
              </div>
              <div className="space-y-2 text-xs divide-y divide-slate-800/80">
                <div className="flex justify-between pt-1">
                  <span className="text-slate-400">Make / Brand:</span>
                  <span className="text-slate-200 font-medium">{meta?.cameraMake || 'Not Present in Header'}</span>
                </div>
                <div className="flex justify-between pt-1">
                  <span className="text-slate-400">Model:</span>
                  <span className="text-slate-200 font-medium">{meta?.cameraModel || 'Not Present'}</span>
                </div>
                <div className="flex justify-between pt-1">
                  <span className="text-slate-400">Lens:</span>
                  <span className="text-slate-200">{meta?.lensModel || 'N/A'}</span>
                </div>
                <div className="flex justify-between pt-1">
                  <span className="text-slate-400">ISO Speed:</span>
                  <span className="font-mono text-slate-200">{meta?.iso || 'N/A'}</span>
                </div>
                <div className="flex justify-between pt-1">
                  <span className="text-slate-400">Aperture / Exposure:</span>
                  <span className="font-mono text-slate-200">
                    {meta?.aperture || 'N/A'} · {meta?.exposureTime || 'N/A'}
                  </span>
                </div>
              </div>
            </div>

            {/* Software & Synthesis Tool */}
            <div className="p-4 rounded-lg bg-slate-900/60 border border-slate-800 space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200 uppercase tracking-wider">
                <Cpu className="w-4 h-4 text-cyan-400" />
                <span>Software & Encoding Footprint</span>
              </div>
              <div className="space-y-2 text-xs divide-y divide-slate-800/80">
                <div className="flex justify-between pt-1">
                  <span className="text-slate-400">Software Tag:</span>
                  <span className="text-cyan-400 font-medium truncate max-w-[160px]" title={meta?.software}>
                    {meta?.software || 'None Recorded'}
                  </span>
                </div>
                <div className="flex justify-between pt-1">
                  <span className="text-slate-400">Dimensions:</span>
                  <span className="font-mono text-slate-200">
                    {meta?.dimensions ? `${meta.dimensions.width} × ${meta.dimensions.height} px` : 'N/A'}
                  </span>
                </div>
                <div className="flex justify-between pt-1">
                  <span className="text-slate-400">Aspect Ratio:</span>
                  <span className="font-mono text-slate-200">{meta?.aspectRatio || 'N/A'}</span>
                </div>
                <div className="flex justify-between pt-1">
                  <span className="text-slate-400">Color Space:</span>
                  <span className="text-slate-200">{meta?.colorSpace || 'sRGB'}</span>
                </div>
              </div>
            </div>

            {/* Timestamps & Geolocation */}
            <div className="p-4 rounded-lg bg-slate-900/60 border border-slate-800 space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200 uppercase tracking-wider">
                <Clock className="w-4 h-4 text-cyan-400" />
                <span>Chronology & Geolocation</span>
              </div>
              <div className="space-y-2 text-xs divide-y divide-slate-800/80">
                <div className="flex justify-between pt-1">
                  <span className="text-slate-400">Date Original:</span>
                  <span className="font-mono text-slate-200 text-[11px]">{meta?.dateTimeOriginal || 'N/A'}</span>
                </div>
                <div className="flex justify-between pt-1">
                  <span className="text-slate-400">Date Digitized:</span>
                  <span className="font-mono text-slate-200 text-[11px]">{meta?.dateTimeDigitized || 'N/A'}</span>
                </div>
                <div className="flex justify-between pt-1">
                  <span className="text-slate-400">GPS Location:</span>
                  <span className="font-mono text-slate-200 text-[11px]">
                    {meta?.gps?.locationName || 'No GPS Coordinates'}
                  </span>
                </div>
                <div className="flex justify-between pt-1">
                  <span className="text-slate-400">File Ingested:</span>
                  <span className="font-mono text-slate-400 text-[11px]">
                    {new Date(activeItem.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

      ) : activeTab === 'age_estimate' ? (
        <div className="space-y-5">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 p-4 rounded-xl bg-slate-900/80 border border-slate-800">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200 uppercase tracking-wider">
                <UserSearch className="w-4 h-4 text-cyan-400" />
                <span>Local Apparent-Age Group Assessment</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed max-w-2xl">
                Local OpenCV models detect faces and assign broad age-group labels. No image is sent to a cloud inference provider; no gender is inferred.
              </p>
            </div>
            <button
              onClick={handleRunAgeEstimate}
              disabled={isEstimatingAge}
              className="shrink-0 flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-600 via-blue-600 to-indigo-600 hover:from-cyan-500 hover:to-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-bold shadow-lg shadow-cyan-950/60 transition-all"
            >
              {isEstimatingAge ? <RefreshCw className="w-4 h-4 animate-spin" /> : <UserSearch className="w-4 h-4" />}
              <span>{isEstimatingAge ? 'Running local models…' : 'Analyze faces locally'}</span>
            </button>
          </div>

          <div className="rounded-lg border border-amber-800/50 bg-amber-950/20 p-3 text-xs text-amber-100/90">
            Apparent age is not actual age. This eight-group model is not calibrated for confidence, and its predictions must not be used to establish identity, age, or eligibility.
          </div>

          {isEstimatingAge && (
            <div className="flex items-center gap-3 rounded-lg border border-cyan-900/50 bg-slate-900/60 p-4 text-xs text-slate-300">
              <RefreshCw className="h-4 w-4 animate-spin text-cyan-400" />
              Loading local models and analyzing each detected face…
            </div>
          )}

          {ageError && (
            <div className="p-4 rounded-xl bg-rose-950/30 border border-rose-800/60 space-y-3">
              <div className="flex items-start gap-3 text-xs text-rose-200">
                <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold text-rose-300 mb-0.5">Local analysis unavailable</div>
                  <div>{ageError}</div>
                </div>
              </div>
              <button
                type="button"
                onClick={handleRunAgeEstimate}
                disabled={isEstimatingAge}
                className="ml-7 px-3.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors"
              >
                Retry local analysis
              </button>
            </div>
          )}

          {ageResultEvidenceId === activeItem.id && ageResult?.status === 'ok' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3 p-3 rounded-lg bg-slate-900/60 border border-slate-800 text-xs">
                <div className="flex items-center gap-1.5 text-emerald-400 font-semibold">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Analysis complete</span>
                </div>
                <span className="text-slate-300">{ageResult.faces.length} face{ageResult.faces.length === 1 ? '' : 's'} detected</span>
                <span className="text-slate-400">Processed in {ageResult.processingTimeMs} ms</span>
                <span className="text-slate-400">Model: {ageResult.model_name}</span>
                <span className="text-slate-500">Version: {ageResult.model_version}</span>
                <span className="text-slate-500">Processed: {ageResult.processed_at}</span>
              </div>

              {ageResult.message && (
                <div className="p-3 rounded-lg bg-sky-950/30 border border-sky-800/40 text-xs text-sky-200/90 flex items-start gap-2">
                  <Info className="w-4 h-4 shrink-0 text-sky-400 mt-0.5" />
                  <span>{ageResult.message}</span>
                </div>
              )}

              <div className="relative inline-block max-w-full rounded-lg border border-slate-800 overflow-hidden bg-slate-950">
                <img
                  ref={ageImgRef}
                  src={displayImageUrl || activeItem.previewUrl || activeItem.thumbnailUrl}
                  alt="Original image with local face-detection boxes"
                  className="max-h-[480px] w-auto object-contain block"
                />
                <canvas ref={ageCanvasRef} className="absolute inset-0 pointer-events-none" />
              </div>

              {ageResult.faces.length === 0 ? (
                <div className="flex items-center gap-3 p-4 rounded-lg bg-slate-900/50 border border-slate-800 text-xs text-slate-400">
                  <Info className="w-4 h-4 shrink-0" />
                  <span>No face was detected above the configured detector threshold.</span>
                </div>
              ) : (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  {ageResult.faces.map((face) => (
                    <article key={face.face_number} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-slate-100">Face {face.face_number}</h3>
                        <span className={`rounded border px-2 py-1 text-[10px] font-bold uppercase ${
                          face.quality.state === 'good'
                            ? 'border-emerald-800 bg-emerald-950/50 text-emerald-300'
                            : face.quality.state === 'moderate'
                            ? 'border-amber-800 bg-amber-950/50 text-amber-300'
                            : 'border-rose-800 bg-rose-950/50 text-rose-300'
                        }`}>
                          {face.quality.state} image quality
                        </span>
                      </div>

                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-slate-500">Approximate apparent-age group</div>
                        <div className="mt-1 text-xl font-bold text-cyan-200">
                          {face.age_status === 'estimated' ? face.age_range : 'Unable to estimate'}
                        </div>
                        <p className="text-[11px] text-slate-400">
                          {face.age_status === 'estimated'
                            ? 'One of the model’s broad age-group classes; not a precise or verified age.'
                            : 'The crop did not meet the minimum measurable quality checks.'}
                        </p>
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-[11px]">
                        <div className="rounded bg-slate-950/70 p-2 text-slate-300">
                          <span className="block text-slate-500">Face box (x, y, w, h)</span>
                          [{face.bbox.join(', ')}] px
                        </div>
                        <div className="rounded bg-slate-950/70 p-2 text-slate-300">
                          <span className="block text-slate-500">Detector score (not age confidence)</span>
                          {face.detection_confidence.toFixed(3)}
                        </div>
                      </div>

                      <div className="space-y-1">
                        {face.quality.observations.map((observation, index) => (
                          <p key={index} className="text-[11px] text-slate-400">• {observation}</p>
                        ))}
                      </div>

                      <div className="border-t border-slate-800 pt-3 space-y-2">
                        <label className="block text-[11px] text-slate-300">
                          Optional self-reported gender information
                          <span className="ml-1 text-slate-500">(only if supplied by the subject)</span>
                        </label>
                        <select
                          value={selfReportedGender[face.face_number] || ''}
                          onChange={(event) => setSelfReportedGender((current) => ({
                            ...current,
                            [face.face_number]: event.target.value,
                          }))}
                          className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-200"
                        >
                          <option value="">Not provided</option>
                          <option value="Woman">Woman</option>
                          <option value="Man">Man</option>
                          <option value="Non-binary">Non-binary</option>
                          <option value="Prefer not to say">Prefer not to say</option>
                          <option value="Self-described">Self-described</option>
                        </select>
                        {selfReportedGender[face.face_number] === 'Self-described' && (
                          <input
                            type="text"
                            value={selfReportedGenderCustom[face.face_number] || ''}
                            onChange={(event) => setSelfReportedGenderCustom((current) => ({
                              ...current,
                              [face.face_number]: event.target.value,
                            }))}
                            aria-label={`Self-described gender for Face ${face.face_number}`}
                            placeholder="Enter the subject-provided description"
                            className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-200 placeholder:text-slate-600"
                          />
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}

              {ageResult.limitations?.length ? (
                <details className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 text-xs">
                  <summary className="cursor-pointer font-semibold text-cyan-300">Model limitations</summary>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-400">
                    {ageResult.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}
                  </ul>
                </details>
              ) : null}

              <button
                onClick={handleRecordAgeFinding}
                className="flex items-center gap-2 rounded bg-cyan-400 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-300"
              >
                <Plus className="h-3.5 w-3.5" />
                Record results with this evidence
              </button>
            </div>
          )}

          {(!ageResult || ageResultEvidenceId !== activeItem.id) && !ageError && !isEstimatingAge && (
            <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
              <div className="p-4 rounded-full bg-slate-900 border border-slate-800">
                <UserSearch className="w-10 h-10 text-slate-600" />
              </div>
              <p className="text-sm text-slate-400">Run local analysis to assess face crops and report broad apparent-age groups.</p>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
};
