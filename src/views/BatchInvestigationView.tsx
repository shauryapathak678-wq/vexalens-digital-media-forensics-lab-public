import React, { useMemo, useRef, useState } from 'react';
import {
  BatchImageItem,
  Investigation,
  EvidenceItem,
  AnalysisFinding,
  DetectorVerdict,
  ForensicReportEvidenceItem,
  UserProfile,
} from '@/types/forensics';
import { calculateSHA256, formatShortHash } from '@/lib/forensics/crypto';
import { extractMediaMetadata } from '@/lib/forensics/metadata';
import { performELA } from '@/lib/forensics/ela';
import {
  computePerceptualHashFromImage,
  hammingDistance,
  isNearDuplicate,
} from '@/lib/forensics/perceptualHash';
import { exportForensicReportPDF } from '@/lib/forensics/pdfExport';
import { VerdictBadge } from '@/components/common/SeverityBadge';
import {
  UploadCloud,
  Columns3,
  Sparkles,
  Download,
  Info,
  XCircle,
  Filter,
} from 'lucide-react';

/** Configurable resource limit for a single batch run. */
const MAX_BATCH_FILES = 8;
/** Bits of difference (out of 64) tolerated before two images are called near-duplicates. */
const NEAR_DUPLICATE_THRESHOLD = 10;

type ProcessingStatus = 'pending' | 'completed' | 'failed' | 'cancelled';

interface BatchInvestigationViewProps {
  currentCase?: Investigation;
  user: UserProfile;
  onCommitBatchToCase: (items: EvidenceItem[], findings: AnalysisFinding[]) => void;
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

function fileFormat(mimeType: string, fileName: string): string {
  const fromMime = mimeType.split('/')[1];
  if (fromMime) return fromMime.toUpperCase();
  const ext = fileName.split('.').pop();
  return ext ? ext.toUpperCase() : 'UNKNOWN';
}

function processingStatus(item: BatchImageItem): ProcessingStatus {
  if (item.error === 'cancelled_by_user') return 'cancelled';
  if (item.error) return 'failed';
  return item.analysisCompleted ? 'completed' : 'pending';
}

export const BatchInvestigationView: React.FC<BatchInvestigationViewProps> = ({
  currentCase,
  user,
  onCommitBatchToCase,
}) => {
  const [batchItems, setBatchItems] = useState<BatchImageItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [selectedItem, setSelectedItem] = useState<BatchImageItem | null>(null);
  const [comparisonTab, setComparisonTab] = useState<'table' | 'previews' | 'metadata' | 'summary'>('table');
  const [filterType, setFilterType] = useState<string>('all');
  const [filterOutcome, setFilterOutcome] = useState<'all' | DetectorVerdict>('all');
  const [filterStatus, setFilterStatus] = useState<'all' | ProcessingStatus>('all');
  const cancelledRef = useRef(false);

  const fileTypeOptions = useMemo(
    () => Array.from(new Set(batchItems.map((item) => fileFormat(item.file.type, item.fileName)))),
    [batchItems]
  );

  const visibleItems = useMemo(
    () =>
      batchItems.filter((item) => {
        if (filterType !== 'all' && fileFormat(item.file.type, item.fileName) !== filterType) return false;
        if (filterOutcome !== 'all' && item.resultState !== filterOutcome) return false;
        if (filterStatus !== 'all' && processingStatus(item) !== filterStatus) return false;
        return true;
      }),
    [batchItems, filterType, filterOutcome, filterStatus]
  );

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const fileList = Array.from(files).slice(0, MAX_BATCH_FILES);
    setIsProcessing(true);
    cancelledRef.current = false;

    const initialItems: BatchImageItem[] = [];

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      setProgressMsg(`Hashing & extracting headers for file ${i + 1} of ${fileList.length} (${file.name})...`);

      const sha256 = await calculateSHA256(file);
      const metadata = await extractMediaMetadata(file);
      const previewUrl = URL.createObjectURL(file);
      const image = await loadImage(previewUrl);
      const perceptualHash = image ? computePerceptualHashFromImage(image) : '';

      initialItems.push({
        id: `batch_${Date.now()}_${i}`,
        file,
        fileName: file.name,
        fileSize: file.size,
        previewUrl,
        sha256,
        perceptualHash,
        duplicateOf: initialItems.find((item) => item.sha256 === sha256)?.id,
        resultState: 'analysis_incomplete',
        mainEvidence: 'Awaiting multi-method forensic pass...',
        findingsCount: 0,
        cameraInfo: metadata.cameraModel ? `${metadata.cameraMake || ''} ${metadata.cameraModel}` : 'No camera hardware tag',
        softwareInfo: metadata.software || 'None recorded',
        analysisCompleted: false,
      });
    }

    // Near-duplicate triage: compare perceptual hashes across the batch. Only
    // files whose bytes differ are labelled, since byte-identical files are
    // already caught by the SHA-256 exact-duplicate check above.
    for (let i = 1; i < initialItems.length; i++) {
      const current = initialItems[i];
      const currentHash = current.perceptualHash;
      if (!currentHash || current.duplicateOf) continue;
      const match = initialItems.slice(0, i).find((candidate) => {
        if (!candidate.perceptualHash || candidate.sha256 === current.sha256) return false;
        return isNearDuplicate(candidate.perceptualHash, currentHash, NEAR_DUPLICATE_THRESHOLD);
      });
      if (match) current.nearDuplicateOf = match.id;
    }

    setBatchItems(initialItems);
    setIsProcessing(false);
    setProgressMsg('');

    // Trigger sequential forensic analysis on every ingested item
    runBatchForensicPass(initialItems);
  };

  const handleCancel = () => {
    cancelledRef.current = true;
    setProgressMsg('Cancelling after the current file completes...');
  };

  const runBatchForensicPass = async (items: BatchImageItem[]) => {
    setIsProcessing(true);
    const updated = [...items];

    for (let i = 0; i < updated.length; i++) {
      const item = updated[i];

      if (cancelledRef.current) {
        item.resultState = 'inconclusive';
        item.mainEvidence = 'Processing cancelled by the user before this file was analysed. No checks were performed on this file.';
        item.error = 'cancelled_by_user';
        item.analysisCompleted = true;
        setBatchItems([...updated]);
        continue;
      }

      setProgressMsg(`Auditing file ${i + 1} of ${updated.length}: "${item.fileName}" (ELA diagnostic pass)...`);

      try {
        const img = await loadImage(item.previewUrl);
        if (!img) throw new Error('Image could not be decoded in the browser for local analysis.');

        const ela = await performELA(img, {
          quality: 0.95,
          diffGain: 1,
          colorChannel: 'rgb',
          invert: false,
          luminanceOnly: false,
        }, item.fileName, undefined, item.file.type, item.file);

        item.resultState = 'detection_unavailable';
        const duplicateNote = item.duplicateOf
          ? `Exact byte duplicate of ${items.find((candidate) => candidate.id === item.duplicateOf)?.fileName || item.duplicateOf}; a matching hash shows byte identity only.`
          : '';
        const nearDuplicateNote = item.nearDuplicateOf
          ? `Perceptually similar to ${items.find((candidate) => candidate.id === item.nearDuplicateOf)?.fileName || item.nearDuplicateOf} (aHash distance ${hammingDistance(item.perceptualHash || '', items.find((candidate) => candidate.id === item.nearDuplicateOf)?.perceptualHash || '')}). Similarity does not prove shared origin.`
          : '';
        item.mainEvidence = [
          duplicateNote,
          nearDuplicateNote,
          `AI-origin was not assessed. ELA verdict: ${ela.ela_verdict}; reliability: ${ela.reliability}; block-based hotspots: ${ela.hotspots.length}. ELA does not determine AI origin or authenticity.`,
        ]
          .filter(Boolean)
          .join(' ');
        item.findingsCount = 0;
        item.findingDetails = [];
        item.analysisCompleted = true;
      } catch (err: any) {
        item.resultState = 'inconclusive';
        item.error = err?.message || 'Processing incomplete';
        item.mainEvidence = `Analysis error: ${item.error}`;
        item.analysisCompleted = true;
      }

      setBatchItems([...updated]);
    }

    setIsProcessing(false);
    setProgressMsg('');
    if (updated.length > 0) setSelectedItem(updated[0]);
  };

  const buildEvidenceListEntry = (item: BatchImageItem): ForensicReportEvidenceItem => ({
    id: item.id,
    fileName: item.fileName,
    mediaType: 'image',
    sha256: item.sha256,
    fileSizeBytes: item.fileSize,
    mimeType: item.file.type || 'image/jpeg',
    hashStatus: /^[a-f\d]{64}$/i.test(item.sha256) ? 'calculated' : 'not_available',
    metadata: {},
    isOriginal: false,
    findingsCount: item.findingsCount,
  });

  const handleDownloadSingleReport = (item: BatchImageItem) => {
    exportForensicReportPDF({
      id: `rep_${item.id}`,
      investigationId: currentCase?.id || 'inv_01',
      caseNumber: currentCase?.caseNumber || 'Not assigned',
      reportNumber: `BATCH-INDV-${formatShortHash(item.sha256, 4, 4)}`,
      title: `Batch Forensic Inspection: ${item.fileName}`,
      summary: `Local batch processing for image file "${item.fileName}". AI-origin assessment: ${item.resultState.replace(/_/g, ' ')}. ${item.mainEvidence}`,
      leadInvestigator: user.fullName,
      badgeNumber: user.badgeNumber,
      agency: user.agency,
      createdAt: new Date().toISOString(),
      evidenceList: [buildEvidenceListEntry(item)],
      findings: item.findingDetails || [],
      methodologiesUsed: [
        'SHA-256 file digest',
        '8x8 average-hash perceptual fingerprint (near-duplicate triage only)',
        'ExifReader available-tag inspection',
        'Canvas JPEG recompression ELA diagnostic',
      ],
      disclaimers: [
        'ELA measurements are diagnostic and do not establish manipulation or AI origin.',
        'A similar perceptual hash does not prove two files share an origin.',
        'No validated specialist AI-origin detector is configured.',
      ],
    });
  };

  const handleDownloadCombinedReport = () => {
    const findings = batchItems.flatMap((item) => item.findingDetails || []);
    exportForensicReportPDF({
      id: `rep_batch_${Date.now()}`,
      investigationId: currentCase?.id || 'inv_01',
      caseNumber: currentCase?.caseNumber || 'Not assigned',
      reportNumber: `BATCH-COMBINED-${new Date().toISOString().slice(0, 10)}`,
      title: `Combined Batch Report (${batchItems.length} files)`,
      summary: `Combined local batch processing for ${batchItems.length} image artifacts. Each file was assessed independently; a finding on one file does not prove or disprove manipulation in another.`,
      leadInvestigator: user.fullName,
      badgeNumber: user.badgeNumber,
      agency: user.agency,
      createdAt: new Date().toISOString(),
      evidenceList: batchItems.map(buildEvidenceListEntry),
      findings,
      methodologiesUsed: [
        'SHA-256 exact-duplicate detection across the batch',
        '8x8 average-hash perceptual near-duplicate triage',
        'ExifReader available-tag inspection per file',
        'Canvas JPEG recompression ELA diagnostic per file',
      ],
      disclaimers: [
        'Each file was assessed independently; batch totals are for triage only and are not an aggregate probability.',
        'ELA measurements are diagnostic and do not establish manipulation or AI origin.',
        'No validated specialist AI-origin detector is configured.',
      ],
    });
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <div className="text-xs font-mono text-cyan-400">
            MULTI-EVIDENCE PIPELINE · UP TO {MAX_BATCH_FILES} FILES PER BATCH
          </div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100 mt-1">
            Batch Media Investigation & Cross-Analysis Matrix
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Ingest up to {MAX_BATCH_FILES} images with independent per-file results, exact and perceptual
            duplicate detection, filtering, and combined or individual reports.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isProcessing && (
            <button
              onClick={handleCancel}
              className="flex items-center gap-2 px-3 py-2 rounded bg-rose-950/60 hover:bg-rose-900/60 border border-rose-800/70 text-rose-200 text-xs font-semibold transition-colors"
            >
              <XCircle className="w-4 h-4" />
              <span>Cancel</span>
            </button>
          )}
          <label className="flex items-center gap-2 px-4 py-2 rounded bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-bold transition-colors cursor-pointer shadow-sm">
            <UploadCloud className="w-4 h-4" />
            <span>Select 1 to {MAX_BATCH_FILES} Images</span>
            <input
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,image/tiff"
              onChange={handleFilesSelected}
              className="hidden"
            />
          </label>
        </div>
      </div>

      {isProcessing && (
        <div className="p-4 rounded-lg bg-cyan-950/30 border border-cyan-800/80 flex items-center justify-between text-xs text-cyan-300">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-cyan-400 animate-spin" />
            <span>{progressMsg}</span>
          </div>
          <span className="font-mono text-slate-400">Processing sequentially in-sandbox...</span>
        </div>
      )}

      {batchItems.length === 0 ? (
        <div className="p-16 border-2 border-dashed border-slate-800 rounded-lg bg-slate-900/30 text-center space-y-3">
          <div className="w-12 h-12 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center text-cyan-400 mx-auto">
            <Columns3 className="w-6 h-6" />
          </div>
          <h3 className="text-sm font-semibold text-slate-200">No Batch Loaded</h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            Click 'Select 1 to {MAX_BATCH_FILES} Images' above to evaluate multiple suspicious or related media
            files simultaneously. If one file cannot be read, the remaining files still finish processing.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3 p-3 rounded-lg bg-slate-900/40 border border-slate-800 text-xs">
            <span className="flex items-center gap-1.5 text-slate-400 font-medium">
              <Filter className="w-3.5 h-3.5" /> Filter
            </span>
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200"
            >
              <option value="all">All file types</option>
              {fileTypeOptions.map((format) => (
                <option key={format} value={format}>
                  {format}
                </option>
              ))}
            </select>
            <select
              value={filterOutcome}
              onChange={(e) => setFilterOutcome(e.target.value as 'all' | DetectorVerdict)}
              className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200"
            >
              <option value="all">All outcomes</option>
              <option value="detection_unavailable">Detection unavailable</option>
              <option value="inconclusive">Inconclusive</option>
              <option value="indicators_observed">Indicators observed</option>
              <option value="no_indicator_detected">No indicator detected</option>
              <option value="conflicting_results">Conflicting results</option>
              <option value="analysis_incomplete">Analysis incomplete</option>
            </select>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as 'all' | ProcessingStatus)}
              className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200"
            >
              <option value="all">All statuses</option>
              <option value="pending">Pending</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <span className="text-slate-500 font-mono">
              Showing {visibleItems.length} of {batchItems.length}
            </span>
            <div className="flex-1" />
            <button
              onClick={handleDownloadCombinedReport}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-100 font-semibold transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Combined Report (PDF)
            </button>
          </div>

          {/* Sub-navigation Tabs */}
          <div className="flex items-center gap-2 border-b border-slate-800 text-xs font-medium">
            <button
              onClick={() => setComparisonTab('table')}
              className={`px-3 py-2 border-b-2 transition-colors ${
                comparisonTab === 'table' ? 'border-cyan-400 text-cyan-300' : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              Independent Results Table
            </button>
            <button
              onClick={() => setComparisonTab('previews')}
              className={`px-3 py-2 border-b-2 transition-colors ${
                comparisonTab === 'previews' ? 'border-cyan-400 text-cyan-300' : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              Side-by-Side Previews ({visibleItems.length})
            </button>
            <button
              onClick={() => setComparisonTab('metadata')}
              className={`px-3 py-2 border-b-2 transition-colors ${
                comparisonTab === 'metadata' ? 'border-cyan-400 text-cyan-300' : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              Metadata Comparison
            </button>
            <button
              onClick={() => setComparisonTab('summary')}
              className={`px-3 py-2 border-b-2 transition-colors ${
                comparisonTab === 'summary' ? 'border-cyan-400 text-cyan-300' : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              Batch Summary
            </button>
          </div>

          {comparisonTab === 'table' && (
            <div className="rounded-lg border border-slate-800 bg-slate-900/40 overflow-hidden">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-950/70 text-slate-400 font-medium">
                    <th className="py-2.5 px-3.5">FILE</th>
                    <th className="py-2.5 px-3.5">RESULT</th>
                    <th className="py-2.5 px-3.5">MAIN EVIDENCE OBSERVATION</th>
                    <th className="py-2.5 px-3.5">SHA-256 HASH</th>
                    <th className="py-2.5 px-3.5 text-right">ACTION</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {visibleItems.map((item, idx) => (
                    <tr
                      key={item.id}
                      onClick={() => setSelectedItem(item)}
                      className={`hover:bg-slate-800/40 transition-colors cursor-pointer ${
                        selectedItem?.id === item.id ? 'bg-cyan-950/20' : ''
                      }`}
                    >
                      <td className="py-3 px-3.5 font-sans flex items-center gap-2.5">
                        <img
                          src={item.previewUrl}
                          alt={item.fileName}
                          className="w-9 h-9 rounded object-cover border border-slate-800 shrink-0"
                        />
                        <div className="truncate max-w-[170px]">
                          <div className="font-medium text-slate-200 truncate">{item.fileName}</div>
                          <div className="text-[11px] text-slate-400 font-mono">
                            {(item.fileSize / 1024).toFixed(1)} KB · {fileFormat(item.file.type, item.fileName)} · Row {idx + 1}
                            {item.duplicateOf && <span className="block text-amber-300">Byte-identical to another batch item</span>}
                            {!item.duplicateOf && item.nearDuplicateOf && (
                              <span className="block text-amber-200/80">Perceptually similar to another batch item</span>
                            )}
                          </div>
                        </div>
                      </td>

                      <td className="py-3 px-3.5 font-sans">
                        <VerdictBadge verdict={item.resultState} />
                        <div className="text-[10px] text-slate-500 mt-1 font-mono">
                          {processingStatus(item)}
                        </div>
                      </td>

                      <td className="py-3 px-3.5 font-sans text-slate-300 max-w-sm truncate text-[11px]">
                        {item.mainEvidence}
                      </td>

                      <td className="py-3 px-3.5 text-slate-400 text-[11px]">
                        {formatShortHash(item.sha256, 6, 6)}
                      </td>

                      <td className="py-3 px-3.5 text-right font-sans space-x-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDownloadSingleReport(item);
                          }}
                          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] transition-colors"
                          title="Download individual PDF report for this image"
                        >
                          Export PDF
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {visibleItems.length === 0 && (
                <div className="py-8 text-center text-xs text-slate-500">
                  No files match the current filters.
                </div>
              )}
            </div>
          )}

          {comparisonTab === 'previews' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {visibleItems.map((item, idx) => (
                <div
                  key={item.id}
                  className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 space-y-3"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-200 truncate max-w-[180px]">
                      {idx + 1}. {item.fileName}
                    </span>
                    <VerdictBadge verdict={item.resultState} />
                  </div>

                  <div className="relative rounded overflow-hidden bg-black border border-slate-800 h-44 flex items-center justify-center">
                    <img
                      src={item.previewUrl}
                      alt={item.fileName}
                      className="w-full h-full object-contain"
                    />
                  </div>

                  <p className="text-xs text-slate-300 line-clamp-2 leading-relaxed">
                    {item.mainEvidence}
                  </p>

                  <div className="flex items-center justify-between pt-2 border-t border-slate-800/80 text-[11px] font-mono text-slate-400">
                    <span>{formatShortHash(item.sha256, 4, 4)}</span>
                    <button
                      onClick={() => handleDownloadSingleReport(item)}
                      className="text-cyan-400 hover:text-cyan-300 font-sans"
                    >
                      Download Report →
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {comparisonTab === 'metadata' && (
            <div className="rounded-lg border border-slate-800 bg-slate-900/40 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs font-mono">
                  <thead>
                    <tr className="border-b border-slate-800 bg-slate-950/70 text-slate-400 font-sans font-medium">
                      <th className="py-2.5 px-3.5">FILE</th>
                      <th className="py-2.5 px-3.5">CAMERA MAKE/MODEL</th>
                      <th className="py-2.5 px-3.5">SOFTWARE / CREATOR TOOL</th>
                      <th className="py-2.5 px-3.5">SHA-256 HASH</th>
                      <th className="py-2.5 px-3.5">PERCEPTUAL HASH</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-slate-300">
                    {visibleItems.map((item) => (
                      <tr key={item.id} className="hover:bg-slate-800/20">
                        <td className="py-2.5 px-3.5 font-sans font-medium text-slate-200">
                          {item.fileName}
                        </td>
                        <td className="py-2.5 px-3.5">{item.cameraInfo}</td>
                        <td className="py-2.5 px-3.5 text-cyan-300">{item.softwareInfo}</td>
                        <td className="py-2.5 px-3.5 text-slate-400">{item.sha256}</td>
                        <td className="py-2.5 px-3.5 text-slate-500">{item.perceptualHash || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {comparisonTab === 'summary' && (
            <div className="p-6 rounded-lg bg-slate-900/50 border border-slate-800 space-y-4">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-slate-200">
                  Batch Multi-Evidence Forensic Summary
                </h3>
                <p className="text-xs text-slate-400">
                  Processed {batchItems.length} media artifacts using the checks available in this local workbench.
                </p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
                <div className="p-3 rounded bg-slate-950 border border-slate-800">
                  <div className="text-slate-400 font-sans text-[11px]">Total Artifacts</div>
                  <div className="text-lg font-bold text-slate-100">{batchItems.length}</div>
                </div>
                <div className="p-3 rounded bg-slate-950 border border-slate-800">
                  <div className="text-slate-400 font-sans text-[11px]">Exact Duplicates</div>
                  <div className="text-lg font-bold text-amber-300">
                    {batchItems.filter((i) => i.duplicateOf).length}
                  </div>
                </div>
                <div className="p-3 rounded bg-slate-950 border border-slate-800">
                  <div className="text-slate-400 font-sans text-[11px]">Near Duplicates</div>
                  <div className="text-lg font-bold text-amber-200">
                    {batchItems.filter((i) => i.nearDuplicateOf).length}
                  </div>
                </div>
                <div className="p-3 rounded bg-slate-950 border border-slate-800">
                  <div className="text-slate-400 font-sans text-[11px]">Failed / Cancelled</div>
                  <div className="text-lg font-bold text-rose-400">
                    {batchItems.filter((i) => ['failed', 'cancelled'].includes(processingStatus(i))).length}
                  </div>
                </div>
              </div>

              <div className="p-3.5 rounded bg-slate-950 border border-slate-800/80 text-xs text-slate-400 leading-relaxed space-y-1">
                <span className="text-slate-200 font-medium">Investigative Objectivity Disclaimer:</span>
                <p>
                  Each file in this batch was assessed independently. Findings on one file do not prove or disprove
                  manipulation in the other files. A matching SHA-256 proves byte identity only; a different hash does
                  not prove manipulation; and a similar perceptual hash does not prove two files share an origin.
                  Batch summary totals are provided strictly for investigative triage.
                </p>
              </div>
            </div>
          )}

          <div className="flex items-start gap-2 p-3 rounded bg-slate-950/60 border border-slate-800 text-[11px] text-slate-400">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-cyan-400" />
            <span>
              Cancelled, timed-out, and detector-unavailable states are reported honestly per file. A detector being
              unavailable is not evidence that a file is authentic.
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
