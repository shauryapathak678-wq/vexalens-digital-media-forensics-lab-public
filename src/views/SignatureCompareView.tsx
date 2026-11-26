import React, { useState, useRef, useEffect } from 'react';
import { EvidenceItem, AnalysisFinding } from '@/types/forensics';
import {
  PenTool,
  UploadCloud,
  RotateCw,
  Sliders,
  Layers,
  ZoomIn,
  ZoomOut,
  Download,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  FileText,
  Plus,
  RefreshCw,
  Languages,
  Eye,
  Columns2,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Stamp,
  ScanText,
  ShieldAlert,
} from 'lucide-react';
import {
  processSignatureImage,
  compareSignatures,
  SignatureInputData,
} from '@/lib/forensics/signatureAnalyzer';
import { SignatureComparisonResult } from '@/types/forensics';
import { RegionSelector, RegionRect, FULL_REGION } from '@/components/common/RegionSelector';
import { calculateEvidenceHashes, calculateSHA256, verifyHashesMatch } from '@/lib/forensics/crypto';

interface SignatureCompareViewProps {
  evidenceList: EvidenceItem[];
  currentCase?: { id: string; userId: string };
  onAddEvidence: (
    item: Omit<EvidenceItem, 'id' | 'createdAt'>,
    file: File | Blob,
    hashesPromise: Promise<{ sha256: string; md5: string }>
  ) => Promise<EvidenceItem>;
  onAddFinding: (finding: Omit<AnalysisFinding, 'id' | 'createdAt'>) => void;
}

async function loadVerifiedImageDataUrl(sourceUrl: string, expectedSha256: string): Promise<string> {
  if (!expectedSha256) throw new Error('A recorded SHA-256 is required before comparing signature evidence.');
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(sourceUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`Could not load signature evidence (HTTP ${response.status}).`);
    const blob = await response.blob();
    if (blob.size === 0 || blob.size > 20 * 1024 * 1024) throw new Error('Signature evidence is empty or exceeds the 20 MiB analysis limit.');
    const actualSha256 = await calculateSHA256(blob);
    if (!verifyHashesMatch(actualSha256, expectedSha256)) {
      throw new Error('Signature image bytes do not match the recorded intake SHA-256. Comparison was stopped.');
    }
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not prepare verified signature evidence for comparison.'));
      reader.onload = () => typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Could not prepare verified signature evidence for comparison.'));
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('Loading signature evidence timed out after 15 seconds.');
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export const SignatureCompareView: React.FC<SignatureCompareViewProps> = ({
  evidenceList,
  currentCase,
  onAddEvidence,
  onAddFinding,
}) => {
  const imageEvidence = evidenceList.filter((e) => e.mediaType === 'image');

  // Comparisons must start from case evidence, not built-in illustrative samples.
  const [refImageSrc, setRefImageSrc] = useState<string>(() => {
    return imageEvidence[0]?.previewUrl || '';
  });
  const [queImageSrc, setQueImageSrc] = useState<string>(() => {
    return imageEvidence[1]?.previewUrl || '';
  });

  const [refName, setRefName] = useState(imageEvidence[0]?.fileName || 'No reference evidence selected');
  const [queName, setQueName] = useState(imageEvidence[1]?.fileName || 'No questioned evidence selected');
  const [refSha256, setRefSha256] = useState(imageEvidence[0]?.sha256Hash || '');
  const [queSha256, setQueSha256] = useState(imageEvidence[1]?.sha256Hash || '');
  const [refEvidenceId, setRefEvidenceId] = useState(imageEvidence[0]?.id || '');
  const [queEvidenceId, setQueEvidenceId] = useState(imageEvidence[1]?.id || '');
  const [refResolution, setRefResolution] = useState('');
  const [queResolution, setQueResolution] = useState('');
  const [uploadError, setUploadError] = useState('');

  // Mark type (signature vs stamp/seal) and region of interest
  const [markType, setMarkType] = useState<'signature' | 'stamp'>('signature');
  const [regionRef, setRegionRef] = useState<RegionRect>(FULL_REGION);
  const [regionQue, setRegionQue] = useState<RegionRect>(FULL_REGION);
  const [showRegionPanel, setShowRegionPanel] = useState(false);

  const markLabel = markType === 'signature' ? 'Signature' : 'Stamp / Seal';

  // Controls
  const [rotationRef, setRotationRef] = useState(0);
  const [rotationQue, setRotationQue] = useState(0);
  const [thresholdVal, setThresholdVal] = useState(130);
  const [overlayOpacity, setOverlayOpacity] = useState(50);
  const [viewMode, setViewMode] = useState<'side_by_side' | 'overlay' | 'diff_heatmap' | 'binarized'>('side_by_side');
  const [language, setLanguage] = useState<'en' | 'hi'>('en');

  // Processing state
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState<SignatureComparisonResult | null>(null);
  const [savedFinding, setSavedFinding] = useState(false);
  const [investigatorNotes, setInvestigatorNotes] = useState('');

  useEffect(() => {
    runComparison();
  }, [refImageSrc, queImageSrc, rotationRef, rotationQue, thresholdVal, regionRef, regionQue]);

  useEffect(() => {
    if (!refImageSrc && imageEvidence[0]) {
      setRefImageSrc(imageEvidence[0].previewUrl);
      setRefName(imageEvidence[0].fileName);
      setRefSha256(imageEvidence[0].sha256Hash);
      setRefEvidenceId(imageEvidence[0].id);
    }
    if (!queImageSrc && imageEvidence[1]) {
      setQueImageSrc(imageEvidence[1].previewUrl);
      setQueName(imageEvidence[1].fileName);
      setQueSha256(imageEvidence[1].sha256Hash);
      setQueEvidenceId(imageEvidence[1].id);
    }
  }, [imageEvidence, refImageSrc, queImageSrc]);

  const runComparison = async () => {
    if (!refImageSrc || !queImageSrc) {
      setResult(null);
      return;
    }
    setUploadError('');
    setProcessing(true);
    setSavedFinding(false);

    try {
      const [verifiedRefSrc, verifiedQueSrc] = await Promise.all([
        loadVerifiedImageDataUrl(refImageSrc, refSha256),
        loadVerifiedImageDataUrl(queImageSrc, queSha256),
      ]);
      const [refData, queData] = await Promise.all([
        processSignatureImage(verifiedRefSrc, refName, { rotationDeg: rotationRef, threshold: thresholdVal, crop: regionRef }),
        processSignatureImage(verifiedQueSrc, queName, { rotationDeg: rotationQue, threshold: thresholdVal, crop: regionQue }),
      ]);

      const compResult = compareSignatures(refData, queData);
      setRefResolution(`${refData.width} × ${refData.height}px analyzed region`);
      setQueResolution(`${queData.width} × ${queData.height}px analyzed region`);
      setResult(compResult);
    } catch (err) {
      console.error('Signature comparison pipeline error:', err);
      setUploadError(err instanceof Error ? err.message : 'Signature image analysis failed.');
    } finally {
      setProcessing(false);
    }
  };

  const persistSignatureUpload = async (file: File): Promise<EvidenceItem> => {
    if (!currentCase) throw new Error('Select an investigation before uploading signature evidence.');
    if (file.size === 0 || file.size > 20 * 1024 * 1024) {
      throw new Error('Signature evidence must be a non-empty image no larger than 20 MiB.');
    }
    const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    const isPng = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => header[index] === byte);
    const isWebp = String.fromCharCode(...header.slice(0, 4)) === 'RIFF' && String.fromCharCode(...header.slice(8, 12)) === 'WEBP';
    const isBmp = header[0] === 0x42 && header[1] === 0x4d;
    const isTiff = (header[0] === 0x49 && header[1] === 0x49 && header[2] === 0x2a && header[3] === 0) ||
      (header[0] === 0x4d && header[1] === 0x4d && header[2] === 0 && header[3] === 0x2a);
    if (!(isJpeg || isPng || isWebp || isBmp || isTiff)) {
      throw new Error('Unsupported or malformed signature image. Use a valid JPEG, PNG, WebP, BMP, or TIFF image.');
    }
    const decoded = await createImageBitmap(file);
    const dimensions = { width: decoded.width, height: decoded.height };
    const validDimensions = dimensions.width > 0 && dimensions.height > 0 && dimensions.width * dimensions.height <= 100_000_000;
    decoded.close();
    if (!validDimensions) throw new Error('Signature image dimensions are invalid or exceed 100 megapixels.');

    const temporaryUrl = URL.createObjectURL(file);
    try {
      const saved = await onAddEvidence({
        investigationId: currentCase.id,
        userId: currentCase.userId,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        mediaType: 'image',
        sha256Hash: '',
        storageUrl: temporaryUrl,
        previewUrl: temporaryUrl,
        isOriginal: false,
        verified: false,
        metadata: { fileFormat: file.type || 'image', fileSizeBytes: file.size, dimensions },
      }, file, calculateEvidenceHashes(file));
      return saved;
    } finally {
      URL.revokeObjectURL(temporaryUrl);
    }
  };

  const handleRefUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadError('');
    try {
      const saved = await persistSignatureUpload(file);
      setRefName(saved.fileName);
      setRefSha256(saved.sha256Hash);
      setRefEvidenceId(saved.id);
      setRefImageSrc(saved.previewUrl);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Could not validate and preserve the reference image.');
    }
  };

  const handleQueUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadError('');
    try {
      const saved = await persistSignatureUpload(file);
      setQueName(saved.fileName);
      setQueSha256(saved.sha256Hash);
      setQueEvidenceId(saved.id);
      setQueImageSrc(saved.previewUrl);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Could not validate and preserve the questioned image.');
    }
  };

  const handleSaveToRegister = () => {
    if (!result || !currentCase || !refEvidenceId || !queEvidenceId) {
      setUploadError('Select both reference and questioned evidence saved in the current investigation before adding this comparison to its findings.');
      return;
    }

    onAddFinding({
      investigationId: currentCase.id,
      evidenceId: queEvidenceId,
      title: `${markLabel} Comparison: ${result.conclusion.replace(/_/g, ' ')}`,
      severity: 'inconclusive',
      category: 'visual_anomaly',
      evidenceLabel: 'observed_fact',
      observedEvidence: `Reference ${refName} (evidence ${refEvidenceId}, SHA-256 ${refSha256}); questioned ${queName} (evidence ${queEvidenceId}, SHA-256 ${queSha256}). Normalized mask IoU: ${result.metrics.contourSimilarity}%, slant discrepancy: ${result.metrics.slantAngleDiffDeg}°, aspect ratio ratio: ${result.metrics.aspectRatioRatio}.${investigatorNotes.trim() ? ` Investigator notes: ${investigatorNotes.trim()}` : ''}`,
      simpleExplanation: result.explanation,
      hindiExplanation: result.hindiExplanation,
      technicalExplanation: `Normalized binary-mask intersection over union (IoU): ${result.metrics.contourSimilarity}%. Heuristic structural discrepancy score: ${result.metrics.structuralDiscrepancyScore}/100. Endpoint count difference: ${result.metrics.endpointMismatchCount}. Processing parameters: reference rotation ${rotationRef}°, questioned rotation ${rotationQue}°, threshold ${thresholdVal}, reference region ${JSON.stringify(regionRef)}, questioned region ${JSON.stringify(regionQue)}.`,
      methodReliability: 'Exploratory browser-based thresholding and normalized contour measurements; this implementation is not a validated forensic identification method.',
      potentialFalsePositives: `${result.limitations.join(' ')} Visual similarity does not establish signer identity, signing authority, or legal authenticity.`,
      unresolvedQuestions: 'Dynamic pen pressure, velocity, and stroke execution order cannot be established from static imagery. The signer identity cannot be determined from an image comparison.',
      recommendedNextSteps: 'If signer identity is material, seek examination of original documents by a qualified forensic document examiner.',
      detectionMethod: 'VexaLens static signature image comparison',
      detectorVersion: '2.1-CPU',
      rawDetectorScore: result.metrics.contourSimilarity,
      scoreInterpretation: 'Intersection-over-union percentage of normalized binary foreground masks. It does not estimate the probability of common authorship.',
      sourceSha256: queSha256 || undefined,
    });

    setSavedFinding(true);
    setTimeout(() => setSavedFinding(false), 3500);
  };

  const conclusionBadgeColors: Record<string, string> = {
    visually_similar: 'text-cyan-300 bg-cyan-950/40 border-cyan-800/80',
    notable_differences: 'text-amber-300 bg-amber-950/40 border-amber-800/80',
    insufficient_quality: 'text-amber-300 bg-amber-950/40 border-amber-800/80',
    inconclusive: 'text-slate-300 bg-slate-900 border-slate-800',
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="p-2 rounded-lg bg-cyan-950/60 border border-cyan-800/60 text-cyan-400">
              <PenTool className="w-5 h-5" />
            </span>
            <div>
              <h1 className="text-xl font-bold text-slate-100 tracking-tight">Signature Deception Lab</h1>
              <p className="text-xs text-slate-400 mt-0.5">
                Static-image visual comparison; differences are investigative leads, not proof of signer identity
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Mark type selector */}
          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5">
            <button
              onClick={() => setMarkType('signature')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1 ${
                markType === 'signature' ? 'bg-cyan-950 text-cyan-300 border border-cyan-800' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <PenTool className="w-3 h-3" /> Signature
            </button>
            <button
              onClick={() => setMarkType('stamp')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1 ${
                markType === 'stamp' ? 'bg-cyan-950 text-cyan-300 border border-cyan-800' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Stamp className="w-3 h-3" /> Stamp / Seal
            </button>
          </div>

          {/* Language Toggle */}
          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5">
            <button
              onClick={() => setLanguage('en')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                language === 'en' ? 'bg-cyan-950 text-cyan-300 border border-cyan-800' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              English
            </button>
            <button
              onClick={() => setLanguage('hi')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1 ${
                language === 'hi' ? 'bg-cyan-950 text-cyan-300 border border-cyan-800' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Languages className="w-3 h-3" /> हिन्दी
            </button>
          </div>

          <button
            onClick={runComparison}
            disabled={processing}
            className="flex items-center gap-2 px-3.5 py-1.5 bg-cyan-950/80 hover:bg-cyan-900/90 text-cyan-200 border border-cyan-800/80 rounded-lg text-xs font-medium transition-colors shadow-sm disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${processing ? 'animate-spin text-cyan-400' : ''}`} />
            {processing ? 'Comparing...' : 'Recalibrate'}
          </button>
        </div>
      </div>

      {/* Upload and Control Bar */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Reference Upload Box */}
        <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-cyan-400 uppercase tracking-wider flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-cyan-400" /> Reference {markLabel}
            </span>
            <label className="cursor-pointer text-[11px] text-cyan-400 hover:text-cyan-300 underline font-medium">
              Upload New
              <input type="file" accept="image/jpeg,image/png,image/webp,image/bmp,image/tiff" onChange={(event) => void handleRefUpload(event)} className="hidden" />
            </label>
          </div>
          <div className="text-xs text-slate-300 truncate font-mono">{refName}</div>
          {imageEvidence.length > 0 && <select aria-label="Select reference evidence" className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200" value={refEvidenceId} onChange={(event) => { const item = imageEvidence.find((candidate) => candidate.id === event.target.value); if (item) { setRefImageSrc(item.previewUrl); setRefName(item.fileName); setRefSha256(item.sha256Hash); setRefEvidenceId(item.id); } }}><option value="">Choose existing case evidence</option>{imageEvidence.map((item) => <option key={item.id} value={item.id}>{item.fileName}</option>)}</select>}
          <p className="break-all text-[10px] text-slate-500">SHA-256: {refSha256 || 'Not available'}</p>
          <p className="text-[10px] text-slate-500">{refResolution || 'Image dimensions not yet read'}</p>
          <div className="flex items-center gap-3 pt-1">
            <span className="text-[11px] text-slate-400 flex items-center gap-1">
              <RotateCw className="w-3 h-3" /> Rotate ({rotationRef}°):
            </span>
            <input
              type="range"
              min="-45"
              max="45"
              value={rotationRef}
              onChange={(e) => setRotationRef(parseInt(e.target.value, 10))}
              className="flex-1 accent-cyan-500 h-1 bg-slate-800 rounded-lg"
            />
          </div>
        </div>

        {/* Questioned Upload Box */}
        <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-rose-400 uppercase tracking-wider flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-rose-400" /> Questioned {markLabel}
            </span>
            <label className="cursor-pointer text-[11px] text-rose-400 hover:text-rose-300 underline font-medium">
              Upload New
              <input type="file" accept="image/jpeg,image/png,image/webp,image/bmp,image/tiff" onChange={(event) => void handleQueUpload(event)} className="hidden" />
            </label>
          </div>
          <div className="text-xs text-slate-300 truncate font-mono">{queName}</div>
          {imageEvidence.length > 0 && <select aria-label="Select questioned evidence" className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200" value={queEvidenceId} onChange={(event) => { const item = imageEvidence.find((candidate) => candidate.id === event.target.value); if (item) { setQueImageSrc(item.previewUrl); setQueName(item.fileName); setQueSha256(item.sha256Hash); setQueEvidenceId(item.id); } }}><option value="">Choose existing case evidence</option>{imageEvidence.map((item) => <option key={item.id} value={item.id}>{item.fileName}</option>)}</select>}
          <p className="break-all text-[10px] text-slate-500">SHA-256: {queSha256 || 'Not available'}</p>
          <p className="text-[10px] text-slate-500">{queResolution || 'Image dimensions not yet read'}</p>
          <div className="flex items-center gap-3 pt-1">
            <span className="text-[11px] text-slate-400 flex items-center gap-1">
              <RotateCw className="w-3 h-3" /> Rotate ({rotationQue}°):
            </span>
            <input
              type="range"
              min="-45"
              max="45"
              value={rotationQue}
              onChange={(e) => setRotationQue(parseInt(e.target.value, 10))}
              className="flex-1 accent-rose-500 h-1 bg-slate-800 rounded-lg"
            />
          </div>
          {uploadError && <p role="alert" className="rounded-lg border border-amber-800 bg-amber-950/30 px-4 py-3 text-xs text-amber-200">{uploadError}</p>}
        </div>
      </div>

      {/* Region selection (advanced, collapsed by default) */}
      <div className="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden">
        <button
          onClick={() => setShowRegionPanel((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-900/60 transition-colors"
        >
          <span className="flex items-center gap-2 text-xs font-semibold text-slate-200 uppercase tracking-wider">
            <Sliders className="w-4 h-4 text-cyan-400" /> Select {markLabel} Region
            <span className="text-[10px] font-normal normal-case text-slate-500">
              drag a box over each image to restrict the comparison
            </span>
          </span>
          {showRegionPanel ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
        </button>
        {showRegionPanel && (
          <div className="px-4 pb-4 grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-slate-800 pt-4">
            <RegionSelector
              imageSrc={refImageSrc}
              alt={`Reference ${markLabel} region`}
              region={regionRef}
              onChange={setRegionRef}
              accent="cyan"
              label={`Reference ${markLabel}`}
            />
            <RegionSelector
              imageSrc={queImageSrc}
              alt={`Questioned ${markLabel} region`}
              region={regionQue}
              onChange={setRegionQue}
              accent="rose"
              label={`Questioned ${markLabel}`}
            />
          </div>
        )}
      </div>

      {/* View Mode Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-950 border border-slate-800 rounded-xl p-2.5">
        <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-lg p-1">
          <button
            onClick={() => setViewMode('side_by_side')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              viewMode === 'side_by_side' ? 'bg-cyan-950 text-cyan-200 border border-cyan-800' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Side-by-Side
          </button>
          <button
            onClick={() => setViewMode('overlay')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              viewMode === 'overlay' ? 'bg-cyan-950 text-cyan-200 border border-cyan-800' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Opacity Overlay
          </button>
          <button
            onClick={() => setViewMode('diff_heatmap')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              viewMode === 'diff_heatmap' ? 'bg-cyan-950 text-cyan-200 border border-cyan-800' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Difference Heatmap
          </button>
        </div>

        {viewMode === 'overlay' && (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span>Overlay Opacity ({overlayOpacity}%):</span>
            <input
              type="range"
              min="0"
              max="100"
              value={overlayOpacity}
              onChange={(e) => setOverlayOpacity(parseInt(e.target.value, 10))}
              className="w-28 accent-cyan-500 h-1 bg-slate-800 rounded-lg"
            />
          </div>
        )}

        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span>Otsu Binarization ({thresholdVal}):</span>
          <input
            type="range"
            min="50"
            max="200"
            value={thresholdVal}
            onChange={(e) => setThresholdVal(parseInt(e.target.value, 10))}
            className="w-24 accent-cyan-500 h-1 bg-slate-800 rounded-lg"
          />
        </div>
      </div>

      {/* Main Inspection Canvas Area */}
      <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
        {viewMode === 'side_by_side' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold text-cyan-400 uppercase tracking-wider block">
                Reference Exemplar
              </span>
              <div className="aspect-[2/1] bg-slate-900 rounded-lg border border-slate-800 flex items-center justify-center p-2 overflow-hidden">
                <img
                  src={refImageSrc}
                  alt="Reference Signature"
                  style={{ transform: `rotate(${rotationRef}deg)` }}
                  className="max-h-full max-w-full object-contain filter invert"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold text-rose-400 uppercase tracking-wider block">
                Questioned Signature
              </span>
              <div className="aspect-[2/1] bg-slate-900 rounded-lg border border-slate-800 flex items-center justify-center p-2 overflow-hidden">
                <img
                  src={queImageSrc}
                  alt="Questioned Signature"
                  style={{ transform: `rotate(${rotationQue}deg)` }}
                  className="max-h-full max-w-full object-contain filter invert"
                />
              </div>
            </div>
          </div>
        )}

        {viewMode === 'overlay' && (
          <div className="aspect-[2/1] max-w-2xl mx-auto bg-slate-900 rounded-lg border border-slate-800 relative flex items-center justify-center overflow-hidden">
            <img
              src={refImageSrc}
              alt="Reference"
              style={{ transform: `rotate(${rotationRef}deg)` }}
              className="absolute max-h-full max-w-full object-contain filter invert opacity-80"
            />
            <img
              src={queImageSrc}
              alt="Questioned"
              style={{
                transform: `rotate(${rotationQue}deg)`,
                opacity: overlayOpacity / 100,
                mixBlendMode: 'difference',
              }}
              className="absolute max-h-full max-w-full object-contain filter invert"
            />
            <div className="absolute bottom-2 left-2 px-2 py-1 bg-black/60 backdrop-blur rounded text-[10px] text-slate-300 font-mono">
              Difference blend mode active
            </div>
          </div>
        )}

        {viewMode === 'diff_heatmap' && (
          <div className="space-y-3">
            <div className="aspect-[2/1] max-w-2xl mx-auto bg-slate-900 rounded-lg border border-slate-800 flex items-center justify-center p-2 overflow-hidden">
              {result?.differenceMapDataUrl ? (
                <img
                  src={result.differenceMapDataUrl}
                  alt="Difference Heatmap"
                  className="max-h-full max-w-full object-contain image-rendering-pixelated"
                />
              ) : (
                <span className="text-xs text-slate-500 font-mono">Rendering difference map...</span>
              )}
            </div>
            <div className="flex items-center justify-center gap-6 text-[11px] font-mono">
              <span className="flex items-center gap-1.5 text-emerald-400">
                <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" /> Overlapping Stroke (Match)
              </span>
              <span className="flex items-center gap-1.5 text-cyan-400">
                <span className="w-2.5 h-2.5 rounded-sm bg-cyan-500" /> Reference Stroke Only
              </span>
              <span className="flex items-center gap-1.5 text-rose-400">
                <span className="w-2.5 h-2.5 rounded-sm bg-rose-500" /> Questioned Stroke Only (Discrepancy)
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Authenticity scope disclaimer (always visible) */}
      <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-rose-300 uppercase tracking-wider">
          <ShieldAlert className="w-4 h-4" /> What this comparison does NOT establish
        </div>
        <ul className="space-y-1 text-xs text-slate-300">
          <li className="flex items-start gap-2">
            <span className="text-rose-400 font-mono mt-0.5">•</span>
            <span><strong className="text-slate-100">Signer identity</strong> — this tool compares pixels, not people. A similar-looking mark does not prove who signed or stamped it.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-rose-400 font-mono mt-0.5">•</span>
            <span><strong className="text-slate-100">Authorization</strong> — it cannot determine whether the signer had authority to sign the document.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-rose-400 font-mono mt-0.5">•</span>
            <span><strong className="text-slate-100">Legal authenticity</strong> — visual similarity alone is not proof of genuineness. Court-admissible conclusions require a certified Forensic Document Examiner (FDE) examining the original document.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-rose-400 font-mono mt-0.5">•</span>
            <span>A pixel-level difference does not by itself prove forgery — natural handwriting varies every time a person signs.</span>
          </li>
        </ul>
      </div>

      {/* OCR availability (honest) */}
      <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl flex items-start gap-2.5">
        <ScanText className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" />
        <p className="text-[11px] text-slate-400 leading-relaxed">
          <span className="text-slate-300 font-medium">OCR / text extraction: unavailable in this build.</span>{' '}
          No on-device or server-side OCR engine is configured, so the printable text printed on a document or stamp is not read or
          compared. To enable text extraction, install a supported OCR engine (for example Tesseract.js) and wire it into the document
          pipeline.
        </p>
      </div>

      {/* Forensic Verdict & Measurements */}
      {result && (
        <div className="space-y-4">
          {/* Outcome Banner */}
          <div
            className={`p-4 rounded-xl border flex items-start justify-between gap-4 transition-all ${
              conclusionBadgeColors[result.conclusion] || 'text-slate-300 bg-slate-900 border-slate-800'
            }`}
          >
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono font-bold tracking-wider uppercase px-2 py-0.5 rounded bg-black/30 border border-current">
                  {result.conclusion.replace(/_/g, ' ')}
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  Method: Exploratory static-image comparison v2.1
                </span>
              </div>
              <h2 className="text-base font-bold text-slate-100">
                {language === 'en' ? result.explanation : result.hindiExplanation}
              </h2>
            </div>

            <button
              onClick={handleSaveToRegister}
              disabled={savedFinding}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-medium border shrink-0 transition-all flex items-center gap-1.5 ${
                savedFinding
                  ? 'bg-emerald-950 text-emerald-300 border-emerald-700'
                  : 'bg-cyan-950/70 hover:bg-cyan-900 text-cyan-200 border-cyan-800'
              }`}
            >
              {savedFinding ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Saved
                </>
              ) : (
                <>
                  <Plus className="w-3.5 h-3.5" /> Save to Findings
                </>
              )}
            </button>
          </div>

          {/* Metric Cards Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
              <span className="text-[10px] text-slate-500 uppercase font-semibold block">Contour Overlap</span>
              <div className="text-lg font-bold font-mono text-cyan-300 mt-1">
                {result.metrics.contourSimilarity}%
              </div>
              <span className="text-[10px] text-slate-400 block mt-0.5">Normalized mask IoU</span>
            </div>

            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
              <span className="text-[10px] text-slate-500 uppercase font-semibold block">Shape Proxy</span>
              <div className="text-lg font-bold font-mono text-violet-300 mt-1">
                {result.metrics.strokeCurvature}%
              </div>
              <span className="text-[10px] text-slate-400 block mt-0.5">Density / slant heuristic</span>
            </div>

            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
              <span className="text-[10px] text-slate-500 uppercase font-semibold block">Aspect Ratio</span>
              <div className="text-lg font-bold font-mono text-emerald-300 mt-1">
                {result.metrics.aspectRatioRatio}
              </div>
              <span className="text-[10px] text-slate-400 block mt-0.5">Bounding box match</span>
            </div>

            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
              <span className="text-[10px] text-slate-500 uppercase font-semibold block">Slant Difference</span>
              <div className="text-lg font-bold font-mono text-amber-300 mt-1">
                {result.metrics.slantAngleDiffDeg}°
              </div>
              <span className="text-[10px] text-slate-400 block mt-0.5">Directional shear estimate</span>
            </div>

            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
              <span className="text-[10px] text-slate-500 uppercase font-semibold block">Density Delta</span>
              <div className="text-lg font-bold font-mono text-cyan-300 mt-1">
                {result.metrics.strokeDensityDiff}%
              </div>
              <span className="text-[10px] text-slate-400 block mt-0.5">Stroke-to-void ratio</span>
            </div>

            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
              <span className="text-[10px] text-slate-500 uppercase font-semibold block">Discrepancy Score</span>
              <div className="text-lg font-bold font-mono text-rose-300 mt-1">
                {result.metrics.structuralDiscrepancyScore}
                <span className="text-xs text-slate-500 font-normal">/100</span>
              </div>
              <span className="text-[10px] text-slate-400 block mt-0.5">Uncalibrated heuristic</span>
            </div>
          </div>

          <label className="block space-y-1 rounded-xl border border-slate-800 bg-slate-950 p-4">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Investigator notes</span>
            <textarea value={investigatorNotes} onChange={(event) => setInvestigatorNotes(event.target.value)} rows={3} className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-600" placeholder="Record context, image-quality concerns, or observations for the findings record." />
          </label>

          {/* Legal Limitations Alert */}
          <div className="p-4 bg-amber-950/20 border border-amber-900/40 rounded-xl space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-400 uppercase tracking-wider">
              <AlertTriangle className="w-4 h-4" /> Legal & Forensic Examination Scope
            </div>
            <ul className="space-y-1 text-xs text-slate-300">
              {result.limitations.map((lim, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <span className="text-amber-500 font-mono mt-0.5">•</span>
                  <span>{lim}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
};
