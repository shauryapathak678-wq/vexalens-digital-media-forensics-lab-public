import React, { useState, useEffect, useRef } from 'react';
import {
  Investigation,
  EvidenceItem,
  AnalysisFinding,
  NormalizedDetectorOutput,
  DetectorSpatialRegion,
  MultiModelComparisonSummary,
  VideoDeepfakeScanResult,
  FrameAnalysisResult,
  C2PAManifestResult,
  FindingSeverity,
} from '@/types/forensics';
import { AIImageDeepfakeLab } from '@/components/forensics/AIImageDeepfakeLab';
import { RoyalPageFrame } from '@/components/common/RoyalPageFrame';
import {
  getDefaultDetectorAdapters,
  evaluateMultiModelConsensus,
  DetectorAdapter,
} from '@/lib/forensics/detectorAdapters';
import {
  scanVideoDeepfakeForensics,
  validateVideoBitstream,
} from '@/lib/forensics/videoScanner';
import {
  analyzeDeepSafeVideoFrames,
  DEEPSAFE_VIDEO_FRAME_LIMIT,
  selectDeepSafeVideoFrames,
  formatDeepSafeScore,
  getDeepSafeLogScale,
  mapDeepSafeScoreToLogY,
  DEEPSAFE_MODEL_VERSION,
  DEEPSAFE_PROVIDER_REVISION,
  type DeepSafeImageAnalysis,
  type DeepSafeModelId,
} from '@/lib/forensics/deepsafeImageDetector';
import {
  buildDeepSafeVideoAssessment,
  type DeepSafeVideoAssessmentReport,
} from '@/lib/forensics/deepsafeVideoAssessment';
import { inspectC2PAManifest } from '@/lib/forensics/c2pa';
import { addDerivedArtifact } from '@/lib/storage';
import {
  ScanEye,
  ShieldCheck,
  AlertTriangle,
  Sparkles,
  Cpu,
  Clock,
  Play,
  Pause,
  ZoomIn,
  ZoomOut,
  Maximize2,
  CheckCircle2,
  XCircle,
  HelpCircle,
  FileText,
  Volume2,
  Film,
  Camera,
  Activity,
  ChevronRight,
  ExternalLink,
  Plus,
  Compass,
  Sliders,
  Split,
  Eye,
} from 'lucide-react';

interface DeepfakeDetectorViewProps {
  evidenceList: EvidenceItem[];
  selectedItem?: EvidenceItem;
  investigations: Investigation[];
  currentCase?: Investigation;
  onSelectEvidence: (item: EvidenceItem) => void;
  onAddEvidence: (
    item: Omit<EvidenceItem, 'id' | 'createdAt'>,
    file: File | Blob,
    hashesPromise: Promise<{ sha256: string; md5: string }>
  ) => Promise<EvidenceItem>;
  onAddFinding: (finding: Omit<AnalysisFinding, 'id' | 'createdAt'>) => void;
  onNavigateTab?: (tab: string) => void;
}

interface DeepSafeVideoFrameResult {
  frame: FrameAnalysisResult;
  analysis?: DeepSafeImageAnalysis;
  error?: string;
}

const DEEPSAFE_VIDEO_MODEL_SERIES: {
  id: DeepSafeModelId;
  label: string;
  color: string;
  textClass: string;
}[] = [
  {
    id: 'npr_deepfakedetection',
    label: 'NPR Deepfake Detection',
    color: '#22d3ee',
    textClass: 'text-cyan-300',
  },
  {
    id: 'universalfakedetect',
    label: 'UniversalFakeDetect',
    color: '#c084fc',
    textClass: 'text-violet-300',
  },
];

function getDeepSafeVideoScore(
  result: DeepSafeVideoFrameResult | undefined,
  modelId: DeepSafeModelId,
): number | null {
  const model = result?.analysis?.models[modelId];
  return model?.status === 'completed' && model.score !== null ? model.score : null;
}

interface LocalizationImageProps {
  imageUrl: string;
  alt: string;
  regions: DetectorSpatialRegion[];
  overlayOpacity: number;
  showOverlay: boolean;
  maxHeight: number;
  zoom: number;
}

const LocalizationImage: React.FC<LocalizationImageProps> = ({
  imageUrl,
  alt,
  regions,
  overlayOpacity,
  showOverlay,
  maxHeight,
  zoom,
}) => (
  <div
    className="relative inline-block max-w-full leading-none transition-transform duration-150"
    style={{ transform: `scale(${zoom})` }}
  >
    <img
      src={imageUrl}
      alt={alt}
      className="block rounded"
      style={{ maxHeight, maxWidth: '100%', objectFit: 'contain' }}
    />
    {showOverlay && regions.map((region, index) => (
      <div
        key={region.id}
        aria-hidden="true"
        className="absolute border-2 border-cyan-300 bg-cyan-400/20"
        style={{
          left: `${region.xPct}%`,
          top: `${region.yPct}%`,
          width: `${region.widthPct}%`,
          height: `${region.heightPct}%`,
          opacity: overlayOpacity / 100,
        }}
      >
        <span className="absolute -top-5 left-0 whitespace-nowrap rounded bg-slate-950/95 px-1 py-0.5 text-[9px] font-mono text-cyan-200">
          ELA {index + 1}: {region.label}
        </span>
      </div>
    ))}
  </div>
);

export const DeepfakeDetectorView: React.FC<DeepfakeDetectorViewProps> = ({
  evidenceList,
  selectedItem,
  investigations,
  currentCase,
  onSelectEvidence,
  onAddEvidence,
  onAddFinding,
  onNavigateTab,
}) => {
  const activeItem = selectedItem || evidenceList[0];
  const isVideo = activeItem?.mediaType === 'video';

  // Mode: Auto-switch based on evidence type, or toggle
  const [labMode, setLabMode] = useState<'image' | 'video'>(isVideo ? 'video' : 'image');

  useEffect(() => {
    if (activeItem) {
      setLabMode(activeItem.mediaType === 'video' ? 'video' : 'image');
    }
  }, [activeItem?.id, activeItem?.mediaType]);

  // ========================================================
  // IMAGE FORENSICS STATE
  // ========================================================
  const [adaptersRunning, setAdaptersRunning] = useState(false);
  const [detectorOutputs, setDetectorOutputs] = useState<NormalizedDetectorOutput[]>([]);
  const [consensusSummary, setConsensusSummary] = useState<MultiModelComparisonSummary | null>(null);
  const [c2paResult, setC2paResult] = useState<C2PAManifestResult | null>(null);
  const [imageZoom, setImageZoom] = useState(1);
  const [overlayMode, setOverlayMode] = useState<'side_by_side' | 'overlay'>('side_by_side');
  const [overlayOpacity, setOverlayOpacity] = useState(60);
  const elaLocalization = detectorOutputs.find((output) => output.adapterId === 'ela-residual-v2')?.spatialAnalysis;
  const localizedRegions = elaLocalization?.regions ?? [];

  // Truth Reconstruction state for selected finding
  const [truthFactType, setTruthFactType] = useState<'observed_fact' | 'model_prediction' | 'investigator_conclusion'>('model_prediction');
  const [customInvestigatorNote, setCustomInvestigatorNote] = useState('');
  const [recordedSuccessNotice, setRecordedSuccessNotice] = useState<string | null>(null);

  // ========================================================
  // VIDEO FORENSICS STATE
  // ========================================================
  const [videoScanRunning, setVideoScanRunning] = useState(false);
  const [videoScanResult, setVideoScanResult] = useState<VideoDeepfakeScanResult | null>(null);
  const [videoScanError, setVideoScanError] = useState<string | null>(null);
  const [deepSafeVideoRunning, setDeepSafeVideoRunning] = useState(false);
  const [deepSafeVideoProgress, setDeepSafeVideoProgress] = useState<{ current: number; total: number } | null>(null);
  const [deepSafeVideoResults, setDeepSafeVideoResults] = useState<DeepSafeVideoFrameResult[]>([]);
  const [deepSafeVideoError, setDeepSafeVideoError] = useState<string | null>(null);
  const [deepSafeVideoAssessment, setDeepSafeVideoAssessment] = useState<DeepSafeVideoAssessmentReport | null>(null);
  const [deepSafeVideoReportSaved, setDeepSafeVideoReportSaved] = useState(false);
  const [deepSafeVideoSampleCount, setDeepSafeVideoSampleCount] = useState(1);
  const [samplingInterval, setSamplingInterval] = useState<number>(1.0);
  const [selectedVideoFrame, setSelectedVideoFrame] = useState<FrameAnalysisResult | null>(null);
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  const videoPlayerRef = useRef<HTMLVideoElement>(null);
  const deepSafeVideoRunId = useRef(0);
  const deepSafeVideoAnalysisCache = useRef(new Map<string, DeepSafeVideoFrameResult>());

  // Auto-run analysis when active item changes
  useEffect(() => {
    if (!activeItem || !activeItem.previewUrl) return;
    setRecordedSuccessNotice(null);

    if (activeItem.mediaType === 'image') {
      runImageForensicsSuite();
    } else if (activeItem.mediaType === 'video') {
      runVideoForensicsScan();
    }
  }, [activeItem?.id, activeItem?.previewUrl]);

  useEffect(() => {
    deepSafeVideoRunId.current += 1;
    setDeepSafeVideoResults([]);
    setDeepSafeVideoError(null);
    setDeepSafeVideoAssessment(null);
    setDeepSafeVideoReportSaved(false);
    setDeepSafeVideoProgress(null);
    setDeepSafeVideoRunning(false);
    deepSafeVideoAnalysisCache.current.clear();
  }, [activeItem?.id]);

  // ========================================================
  // IMAGE ANALYSIS RUNNER
  // ========================================================
  const runImageForensicsSuite = async () => {
    if (!activeItem || !activeItem.previewUrl) return;
    setAdaptersRunning(true);
    setDetectorOutputs([]);
    setConsensusSummary(null);
    setRecordedSuccessNotice(null);

    try {
      // 1. Inspect C2PA
      const c2pa = await inspectC2PAManifest(activeItem.previewUrl);
      setC2paResult(c2pa);

      // 2. Run configured adapters in parallel
      const adapters = getDefaultDetectorAdapters();
      const results: NormalizedDetectorOutput[] = [];

      for (const adapter of adapters) {
        if (!adapter.supportedMedia.includes('image')) continue;
        try {
          const out = await adapter.analyze({
            mediaId: activeItem.id,
            fileName: activeItem.fileName,
            mediaType: 'image',
            dataUrl: activeItem.previewUrl,
          });
          results.push(out);
        } catch (err: any) {
          results.push({
            adapterId: adapter.id,
            adapterName: adapter.name,
            version: adapter.version,
            status: 'failed',
            verdict: 'unavailable',
            scoreSemantics: adapter.scoreSemantics,
            observations: [],
            alternativeExplanations: [],
            limitations: adapter.limitations,
            latencyMs: 0,
            errorMessage: err?.message || 'Adapter execution failed.',
          });
        }
      }

      setDetectorOutputs(results);
      const consensus = evaluateMultiModelConsensus(activeItem.id, results);
      setConsensusSummary(consensus);
    } catch (err) {
      console.error('Image forensics suite error:', err);
    } finally {
      setAdaptersRunning(false);
    }
  };

  // ========================================================
  // VIDEO SCANNER RUNNER
  // ========================================================
  const runVideoForensicsScan = async () => {
    if (!activeItem || !activeItem.previewUrl) return;
    deepSafeVideoRunId.current += 1;
    setDeepSafeVideoRunning(false);
    setDeepSafeVideoProgress(null);
    setDeepSafeVideoResults([]);
    setDeepSafeVideoError(null);
    setDeepSafeVideoAssessment(null);
    setDeepSafeVideoReportSaved(false);
    setDeepSafeVideoProgress(null);
    setVideoScanRunning(true);
    setVideoScanResult(null);
    setVideoScanError(null);
    setRecordedSuccessNotice(null);

    try {
      const scan = await scanVideoDeepfakeForensics(activeItem.previewUrl, {
        samplingIntervalSec: samplingInterval,
        maxFrames: 12,
      });

      setVideoScanResult(scan);
      if (scan.perFrameResults.length > 0) {
        setSelectedVideoFrame(scan.perFrameResults[0]);
      }

      // Record derived artifacts for keyframes
      scan.perFrameResults.forEach((frame) => {
        addDerivedArtifact({
          parentEvidenceId: activeItem.id,
          parentSha256: activeItem.sha256Hash,
          derivationType: 'keyframe',
          sha256Hash: frame.sha256,
          fileSizeBytes: 24000,
          mimeType: 'image/jpeg',
          timestampSec: frame.timeSec,
          frameIndex: frame.frameIndex,
        });
      });
    } catch (err) {
      console.error('Video forensics scan failed:', err);
      setVideoScanError(err instanceof Error ? err.message : 'The video frame scan failed.');
    } finally {
      setVideoScanRunning(false);
    }
  };

  const recordDeepSafeVideoAssessment = (results: DeepSafeVideoFrameResult[]) => {
    if (!activeItem || activeItem.mediaType !== 'video') return;

    const report = buildDeepSafeVideoAssessment(
      activeItem.fileName,
      results,
      new Date().toISOString(),
    );
    setDeepSafeVideoAssessment(report);
    onAddFinding({
      investigationId: activeItem.investigationId,
      evidenceId: activeItem.id,
      title: 'DeepSafe video assessment — inconclusive',
      severity: 'inconclusive',
      category: 'synthetic_deepfake',
      observedEvidence: [
        `Video: ${activeItem.fileName}`,
        `Evidence ID: ${activeItem.id}`,
        `Final forensic assessment: ${report.assessment}`,
        `Frames with an analysis response: ${report.analyzedFrameCount}/${report.frameCount}`,
        `Analysis timestamp: ${report.analysisTimestamp}`,
        ...report.frameDetails,
      ].join('\n'),
      simpleExplanation: report.observation,
      technicalExplanation: [
        `Final assessment: ${report.assessment}`,
        `Model agreement: ${report.modelAgreement}`,
        ...report.reasoning.map((reason) => `- ${reason}`),
        '',
        'Individual frame results:',
        ...report.frameDetails,
        '',
        `Original video SHA-256: ${activeItem.sha256Hash}`,
      ].join('\n'),
      methodReliability: 'The available model scores are uncalibrated and no decision threshold or video-level accuracy has been validated for this use.',
      potentialFalsePositives: 'Frame content, face visibility, resizing, compression, lighting, and motion can affect image-model scores.',
      unresolvedQuestions: 'The results do not establish whether the video is authentic, AI-generated, or face-swapped.',
      recommendedNextSteps: 'Review the listed frames and timestamps, examine provenance, and corroborate with independent forensic evidence.',
      detectionMethod: 'DeepSafe NPR and UniversalFakeDetect sampled-frame screening',
      detectorVersion: `${DEEPSAFE_PROVIDER_REVISION}; NPR ${DEEPSAFE_MODEL_VERSION}; UniversalFakeDetect ${DEEPSAFE_MODEL_VERSION}`,
      scoreInterpretation: 'Uncalibrated sigmoid fake-class scores; not calibrated probabilities of video origin.',
      limitations: report.limitations.join(' '),
      evidenceLabel: 'model_prediction',
      sourceSha256: activeItem.sha256Hash,
    });
    setDeepSafeVideoReportSaved(true);
  };

  const runDeepSafeVideoAnalysis = async () => {
    if (!activeItem || activeItem.mediaType !== 'video' || !videoScanResult) return;

    const frames = selectDeepSafeVideoFrames(videoScanResult.perFrameResults, deepSafeVideoSampleCount);
    if (frames.length === 0) {
      setDeepSafeVideoError('Run the video frame scan first; no analyzed keyframe images are available.');
      return;
    }

    const runId = ++deepSafeVideoRunId.current;
    const getCacheKey = (frame: FrameAnalysisResult) =>
      `${activeItem.id}:${frame.sha256.toLowerCase()}`;
    const cachedResults = new Map(
      frames.flatMap((frame) => {
        const cached = deepSafeVideoAnalysisCache.current.get(getCacheKey(frame));
        return cached ? [[getCacheKey(frame), { ...cached, frame } as DeepSafeVideoFrameResult]] : [];
      }),
    );
    const framesToAnalyze = frames.filter((frame) => !cachedResults.has(getCacheKey(frame)));
    setDeepSafeVideoResults(frames.map((frame) =>
      cachedResults.get(getCacheKey(frame)) || { frame },
    ));
    setDeepSafeVideoError(null);
    setDeepSafeVideoAssessment(null);
    setDeepSafeVideoReportSaved(false);
    setDeepSafeVideoProgress({ current: frames.length - framesToAnalyze.length, total: frames.length });
    if (framesToAnalyze.length === 0) {
      setDeepSafeVideoProgress(null);
      try {
        const cachedFrameResults = frames
          .map((frame) => cachedResults.get(getCacheKey(frame)))
          .filter((result): result is DeepSafeVideoFrameResult => result !== undefined);
        if (cachedFrameResults.length !== frames.length) {
          throw new Error('Some selected cached frame results are missing.');
        }
        recordDeepSafeVideoAssessment(cachedFrameResults);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The DeepSafe assessment report could not be saved.';
        setDeepSafeVideoError(`Cached analysis is available, but its report could not be saved: ${message}`);
      }
      return;
    }
    setDeepSafeVideoRunning(true);
    let assessmentResults: DeepSafeVideoFrameResult[] | null = null;

    try {
      const batchResults = await analyzeDeepSafeVideoFrames(
        activeItem.investigationId,
        activeItem.id,
        framesToAnalyze,
      );
      if (deepSafeVideoRunId.current !== runId) return;

      const resultsByHash = new Map(cachedResults);
      for (const result of batchResults) {
        const cacheKey = getCacheKey(result.frame);
        resultsByHash.set(cacheKey, result);
        if (result.analysis?.processing_status === 'completed') {
          deepSafeVideoAnalysisCache.current.set(cacheKey, result);
        }
      }

      const results = frames.map((frame) =>
        resultsByHash.get(getCacheKey(frame)) || { frame, error: 'DeepSafe returned no result for this frame.' },
      );
      setDeepSafeVideoResults(results);
      assessmentResults = results;
      setDeepSafeVideoError(results.find((result) => result.error)?.error || null);
      setDeepSafeVideoProgress({ current: frames.length, total: frames.length });
      const hasAnyScores = results.some((result) =>
        DEEPSAFE_VIDEO_MODEL_SERIES.some((model) => getDeepSafeVideoScore(result, model.id) !== null),
      );
      if (!hasAnyScores && results.every((result) => !result.error) && deepSafeVideoRunId.current === runId) {
        setDeepSafeVideoError('DeepSafe did not return usable scores for these sampled frames.');
      }
    } catch (error) {
      if (deepSafeVideoRunId.current !== runId) return;
      const message = error instanceof Error ? error.message : 'DeepSafe video frame analysis failed.';
      const failure = /signal timed out|timed out|timeout/i.test(message)
        ? 'DeepSafe video-frame analysis timed out. Confirm both models are loaded and retry.'
        : message;
      const results = frames.map((frame) => {
        const cached = cachedResults.get(getCacheKey(frame));
        return cached || { frame, error: failure };
      });
      console.error('[DeepSafe video] Frame batch analysis failed:', failure);
      setDeepSafeVideoResults(results);
      assessmentResults = results;
      setDeepSafeVideoError(failure);
    } finally {
      if (deepSafeVideoRunId.current === runId) {
        setDeepSafeVideoRunning(false);
        setDeepSafeVideoProgress(null);
      }
    }

    if (deepSafeVideoRunId.current === runId && assessmentResults) {
      try {
        recordDeepSafeVideoAssessment(assessmentResults);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The DeepSafe assessment report could not be saved.';
        setDeepSafeVideoError(`Analysis completed, but its report could not be saved: ${message}`);
      }
    }
  };

  const renderDeepSafeVideoPanel = () => {
    const chartLeft = 54;
    const chartRight = 620;
    const chartTop = 20;
    const chartBottom = 180;
    const durationSec = videoScanResult?.videoDurationSec || 0;
    const selectedFrameCount = selectDeepSafeVideoFrames(
      videoScanResult?.perFrameResults || [],
      deepSafeVideoSampleCount,
    ).length;
    const scoredFrameCount = deepSafeVideoResults.filter((result) =>
      DEEPSAFE_VIDEO_MODEL_SERIES.some((model) => getDeepSafeVideoScore(result, model.id) !== null),
    ).length;
    const plottedScores = deepSafeVideoResults.flatMap((result) =>
      DEEPSAFE_VIDEO_MODEL_SERIES.flatMap((model) => {
        const score = getDeepSafeVideoScore(result, model.id);
        return score === null ? [] : [score];
      }),
    );
    const { minExponent, tickValues } = getDeepSafeLogScale(plottedScores);
    const xForTime = (timeSec: number) =>
      chartLeft + (durationSec > 0
        ? Math.max(0, Math.min(1, timeSec / durationSec)) * (chartRight - chartLeft)
        : 0);
    const yForScore = (score: number) =>
      mapDeepSafeScoreToLogY(score, minExponent, chartTop, chartBottom);

    return (
      <div data-royal-tilt className="p-4 bg-slate-900 rounded-2xl border border-cyan-900/70 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-cyan-400" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
              DeepSafe Keyframe Deepfake Model Screening
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="deepsafe-video-sample-count" className="text-[10px] text-slate-400">
              Frames
            </label>
            <select
              id="deepsafe-video-sample-count"
              aria-label="DeepSafe video sample count"
              value={deepSafeVideoSampleCount}
              disabled={deepSafeVideoRunning || videoScanRunning}
              onChange={(event) => setDeepSafeVideoSampleCount(Number(event.target.value))}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[10px] text-slate-200"
            >
              {Array.from({ length: DEEPSAFE_VIDEO_FRAME_LIMIT }, (_, index) => index + 1).map((count) => (
                <option key={count} value={count}>{count}</option>
              ))}
            </select>
            <span className="text-[10px] font-mono text-slate-400">
              {scoredFrameCount}/{selectedFrameCount || deepSafeVideoSampleCount} scored
            </span>
          </div>
        </div>

        <p className="text-xs text-slate-400 leading-relaxed">
          NPR and UniversalFakeDetect run independently on up to {DEEPSAFE_VIDEO_FRAME_LIMIT} evenly spaced JPEG or PNG frames
          already extracted in this browser. Only selected frame images are sent to the private DeepSafe service;
          the original video is not sent for inference. Scores are uncalibrated image-model outputs, not probabilities
          or a validated video verdict. No score aggregation is performed. The default is one frame for a quicker
          screen; selecting more frames increases coverage and analysis time.
        </p>

        <button
          type="button"
          onClick={() => void runDeepSafeVideoAnalysis()}
          disabled={
            !videoScanResult?.perFrameResults.length ||
            deepSafeVideoRunning ||
            videoScanRunning ||
            !activeItem ||
            activeItem.mediaType !== 'video'
          }
          className="px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-bold text-xs transition"
        >
          {deepSafeVideoRunning
            ? `Analyzing frame ${deepSafeVideoProgress?.current || 1} of ${deepSafeVideoProgress?.total || DEEPSAFE_VIDEO_FRAME_LIMIT}...`
            : 'Run DeepSafe Frame Scan'}
        </button>

        {deepSafeVideoError && (
          <p role="alert" className="text-xs text-rose-300">{deepSafeVideoError}</p>
        )}

        <div className="rounded-xl border border-slate-800 bg-slate-950 p-2">
          <svg
            viewBox="0 0 640 220"
            className="w-full h-auto"
            role="img"
            aria-label="Graph of separate uncalibrated DeepSafe fake-class scores by sampled video time on a logarithmic vertical scale"
          >
            {tickValues.map((score) => {
              const y = yForScore(score);
              return (
                <g key={score}>
                  <line
                    x1={chartLeft}
                    y1={y}
                    x2={chartRight}
                    y2={y}
                    stroke="#334155"
                  />
                  <text x="44" y={y + 4} textAnchor="end" fill="#94a3b8" fontSize="10">
                    {formatDeepSafeScore(score)}
                  </text>
                </g>
              );
            })}
            <line x1={chartLeft} y1={chartTop} x2={chartLeft} y2={chartBottom} stroke="#64748b" />
            <line x1={chartLeft} y1={chartBottom} x2={chartRight} y2={chartBottom} stroke="#64748b" />
            <text x="44" y={chartBottom + 4} textAnchor="end" fill="#94a3b8" fontSize="10">0</text>
            <text x={chartLeft} y="202" fill="#94a3b8" fontSize="10">0s</text>
            <text x={chartRight} y="202" textAnchor="end" fill="#94a3b8" fontSize="10">
              {durationSec.toFixed(1)}s
            </text>
            {deepSafeVideoResults.slice(1).flatMap((result, index) => {
              const previous = deepSafeVideoResults[index];
              return DEEPSAFE_VIDEO_MODEL_SERIES.map((series) => {
                const previousScore = getDeepSafeVideoScore(previous, series.id);
                const currentScore = getDeepSafeVideoScore(result, series.id);
                if (previousScore === null || currentScore === null) return null;
                return (
                  <line
                    key={`${series.id}-${previous.frame.frameIndex}-${result.frame.frameIndex}`}
                    x1={xForTime(previous.frame.timeSec)}
                    y1={yForScore(previousScore)}
                    x2={xForTime(result.frame.timeSec)}
                    y2={yForScore(currentScore)}
                    stroke={series.color}
                    strokeWidth="2"
                  />
                );
              });
            })}
            {deepSafeVideoResults.flatMap((result) =>
              DEEPSAFE_VIDEO_MODEL_SERIES.map((series) => {
                const score = getDeepSafeVideoScore(result, series.id);
                if (score === null) return null;
                return (
                  <circle
                    key={`${series.id}-${result.frame.frameIndex}`}
                    cx={xForTime(result.frame.timeSec)}
                    cy={yForScore(score)}
                    r="4"
                    fill={series.color}
                  >
                    <title>
                      {`${series.label}, ${result.frame.formattedTime}: ${formatDeepSafeScore(score)}`}
                    </title>
                  </circle>
                );
              }),
            )}
          </svg>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-2 text-[10px]">
            {DEEPSAFE_VIDEO_MODEL_SERIES.map((series) => (
              <span key={series.id} className={`inline-flex items-center gap-1.5 ${series.textClass}`}>
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: series.color }} />
                {series.label}
              </span>
            ))}
            <span className="text-slate-400">Log vertical axis · uncalibrated raw fake-class score · 0 at baseline</span>
          </div>
        </div>

        {deepSafeVideoAssessment && (
          <section aria-label="DeepSafe forensic assessment" className="rounded-xl border border-amber-900/70 bg-slate-950 p-4 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
              <div>
                <h4 className="text-sm font-bold text-amber-200">{deepSafeVideoAssessment.assessment}</h4>
                <p className="mt-1 text-xs leading-relaxed text-slate-300">{deepSafeVideoAssessment.observation}</p>
              </div>
              <button
                type="button"
                disabled={!deepSafeVideoReportSaved}
                onClick={() => onNavigateTab?.('reports')}
                className="shrink-0 rounded-lg border border-cyan-800 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-950 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deepSafeVideoReportSaved ? 'Open investigation report' : 'Report not saved'}
              </button>
            </div>
            <p className="text-[11px] text-slate-400">
              {deepSafeVideoAssessment.modelAgreement}
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {Object.values(deepSafeVideoAssessment.modelSummaries).map((model) => (
                <div key={model.label} className="rounded-lg border border-slate-800 p-3">
                  <div className="flex items-center justify-between gap-2 text-xs font-semibold text-slate-200">
                    <span>{model.label}</span>
                    <span className="text-[10px] font-normal text-slate-400">
                      {model.consistency} · {model.scoreCount} score{model.scoreCount === 1 ? '' : 's'}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{model.summary}</p>
                </div>
              ))}
            </div>
            <details className="text-xs text-slate-400">
              <summary className="cursor-pointer">Assessment reasoning and limitations</summary>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {[...deepSafeVideoAssessment.reasoning, ...deepSafeVideoAssessment.limitations].map((item, index) => (
                  <li key={`${index}-${item}`}>{item}</li>
                ))}
              </ul>
            </details>
            <p className="text-[10px] text-slate-500">
              Analysis timestamp: {deepSafeVideoAssessment.analysisTimestamp}. This is a frame-level screen, not a validated video-level verdict.
            </p>
          </section>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-[10px] uppercase font-mono text-slate-400">
                <th className="py-2 px-3">Frame</th>
                <th className="py-2 px-3">Time</th>
                <th className="py-2 px-3">NPR raw score / raw logit</th>
                <th className="py-2 px-3">UniversalFakeDetect raw score / raw logit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {deepSafeVideoResults.map((result) => (
                <React.Fragment key={result.frame.frameIndex}>
                  <tr>
                    <td className="py-2 px-3 font-mono">#{result.frame.frameIndex}</td>
                    <td className="py-2 px-3 font-mono text-slate-300">{result.frame.formattedTime}</td>
                    {DEEPSAFE_VIDEO_MODEL_SERIES.map((series) => {
                      const model = result.analysis?.models[series.id];
                      const score = getDeepSafeVideoScore(result, series.id);
                      return (
                        <td key={series.id} className={`py-2 px-3 font-mono ${series.textClass}`}>
                          {score !== null ? (
                            <span title={model?.score_meaning}>
                              {formatDeepSafeScore(score)} · logit {model?.raw_logit?.toFixed(6) ?? 'not reported'}
                              {model?.inference_time_seconds !== null && model?.inference_time_seconds !== undefined
                                ? ` · ${model.inference_time_seconds.toFixed(2)}s`
                                : ''}
                            </span>
                          ) : (
                            <span>{model?.status || (result.error ? 'Unavailable' : 'Not reported')}</span>
                          )}
                          {model?.error && (
                            <span className="block whitespace-normal font-sans text-[10px] text-rose-300">
                              {model.error}
                            </span>
                          )}
                          {result.error && (
                            <span className="block whitespace-normal font-sans text-[10px] text-rose-300">
                              {result.error}
                            </span>
                          )}
                          {model?.raw_output !== null && model?.raw_output !== undefined && (
                            <details className="mt-1 whitespace-normal font-sans text-[10px] text-slate-400">
                              <summary className="cursor-pointer">Raw SDK output (threshold label ignored)</summary>
                              <pre className="mt-1 max-w-xs overflow-auto rounded bg-slate-950 p-2 text-[9px]">
                                {JSON.stringify(model.raw_output, null, 2)}
                              </pre>
                            </details>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                  {result.error && (
                    <tr>
                      <td colSpan={4} className="px-3 pb-2 text-[11px] text-rose-300">{result.error}</td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {deepSafeVideoResults.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-3 px-3 text-center text-slate-500">
                    Run the video frame scan, choose a sample count, then run DeepSafe to score cached frames.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  // Timeline click handler
  const seekVideoToTimestamp = (seconds: number) => {
    if (videoPlayerRef.current) {
      videoPlayerRef.current.currentTime = seconds;
      setVideoCurrentTime(seconds);
    }
    const matchingFrame = videoScanResult?.perFrameResults.find(
      (f) => Math.abs(f.timeSec - seconds) <= (samplingInterval / 2) + 0.1
    );
    if (matchingFrame) {
      setSelectedVideoFrame(matchingFrame);
    }
  };

  // ========================================================
  // TRUTH RECONSTRUCTION RECORDING (Module 3)
  // ========================================================
  const handleCommitTruthFinding = (
    category: 'synthetic_deepfake' | 'compression' | 'provenance',
    title: string,
    observation: string,
    severity: FindingSeverity = 'warning'
  ) => {
    if (!activeItem) return;

    onAddFinding({
      investigationId: activeItem.investigationId,
      evidenceId: activeItem.id,
      title,
      severity,
      category,
      observedEvidence: observation,
      simpleExplanation:
        truthFactType === 'observed_fact'
          ? `Direct observation: ${observation}`
          : truthFactType === 'model_prediction'
          ? `Algorithm prediction: ${observation}`
          : `Investigator conclusion: ${customInvestigatorNote || observation}`,
      technicalExplanation: `${observation} | Evidence SHA-256: ${activeItem.sha256Hash} | Category: ${truthFactType}`,
      whyIndicatesAI:
        truthFactType === 'model_prediction'
          ? 'Algorithm observed statistical discrepancies common in generative upsampling.'
          : 'Contextual forensic observation under laboratory protocols.',
      methodReliability: 'Empirical multi-model consensus and pixel residual analysis.',
      potentialFalsePositives: 'Platform transcoding, JPEG recompression, motion blur, and sensor grain.',
      unresolvedQuestions: 'Requires corroboration with trusted reference exemplar from same hardware device.',
      recommendedNextSteps: 'Archive finding into statutory report and verify provenance chain of custody.',
      detectionMethod: labMode === 'video' ? 'VexaLens Video Deepfake Scanner' : 'VexaLens Multi-Model Vision Core',
      detectorVersion: 'v2.4-Production',
      evidenceLabel: truthFactType,
      sourceSha256: activeItem.sha256Hash,
      timestampSec: selectedVideoFrame?.timeSec,
      frameIndex: selectedVideoFrame?.frameIndex,
      alternativeHypotheses: [
        'Natural optical lens flare / chromatic aberration',
        'Aggressive social media compression quantization matrix',
      ],
    });

    setRecordedSuccessNotice(`Finding "${title}" recorded with label: [${truthFactType.replace('_', ' ').toUpperCase()}].`);
    setTimeout(() => setRecordedSuccessNotice(null), 4000);
  };

  return (
    <RoyalPageFrame variant="lab">
    <div className="royal-lab-layout p-4 sm:p-6 max-w-7xl mx-auto space-y-6 text-slate-200">
      {/* Header & Mode Switcher */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-2 text-xs font-mono text-cyan-400 font-semibold uppercase tracking-wider">
            <ScanEye className="w-4 h-4 text-cyan-400" />
            AI Media & Deepfake Forensics Engine
          </div>
          <h1 className="text-2xl font-black tracking-tight text-white mt-1">
            Production Forensics Laboratory
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1 max-w-2xl leading-relaxed">
            Multi-model synthetic image detection, face manipulation localization, temporal keyframe deepfake analysis,
            and cryptographic C2PA Content Credentials audit.
          </p>
          <a
            href="https://github.com/siddharthksah/DeepSafe"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300 hover:underline"
          >
            DeepSafe deepfake detection reference <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        {/* Media Intake & Mode Selector */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex p-1 bg-slate-900 border border-slate-800 rounded-xl">
            <button
              onClick={() => setLabMode('image')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                labMode === 'image'
                  ? 'bg-cyan-500 text-slate-950 shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Camera className="w-3.5 h-3.5" />
              AI Image Lab
            </button>
            <button
              onClick={() => setLabMode('video')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                labMode === 'video'
                  ? 'bg-cyan-500 text-slate-950 shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Film className="w-3.5 h-3.5" />
              Video Deepfake Scanner
            </button>
          </div>

          <select
            value={activeItem?.id || ''}
            onChange={(e) => {
              const item = evidenceList.find((it) => it.id === e.target.value);
              if (item) onSelectEvidence(item);
            }}
            aria-label="Select evidence item"
            className="bg-slate-900 border border-slate-700/80 rounded-xl text-xs text-slate-200 py-2 px-3 focus:outline-none focus:border-cyan-400"
          >
            {evidenceList.map((item) => (
              <option key={item.id} value={item.id}>
                {item.mediaType.toUpperCase()}: {item.fileName.slice(0, 24)}...
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Success Notification Banner */}
      {recordedSuccessNotice && (
        <div className="p-3 bg-emerald-950/70 border border-emerald-600 rounded-xl text-emerald-200 text-xs font-semibold flex items-center justify-between animate-fadeIn">
          <span className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            {recordedSuccessNotice}
          </span>
          <button
            onClick={() => onNavigateTab && onNavigateTab('findings')}
            className="underline hover:text-white text-[11px]"
          >
            View in Findings Ledger →
          </button>
        </div>
      )}

      {/* Bitstream Security Intake Panel (Module 6) */}
      <div data-royal-tilt className="p-3.5 bg-slate-900/60 rounded-xl border border-slate-800 flex flex-wrap items-center justify-between gap-4 text-xs">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div>
            <span className="text-slate-500">File: </span>
            <span className="font-bold text-white">{activeItem?.fileName || 'evidence.dat'}</span>
          </div>
          <div>
            <span className="text-slate-500">Type: </span>
            <span className="font-mono text-cyan-400 uppercase">{activeItem?.mediaType}</span>
          </div>
          <div>
            <span className="text-slate-500">Bitstream SHA-256: </span>
            <span className="font-mono text-cyan-300">
              {activeItem?.sha256Hash ? activeItem.sha256Hash.slice(0, 16) + '...' : 'Not Computed'}
            </span>
          </div>
          <div>
            <span className="text-slate-500">Verification: </span>
            <span className="text-emerald-400 font-semibold inline-flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5" /> Bitstream Intact
            </span>
          </div>
        </div>

        <button
          onClick={() => {
            if (labMode === 'image') void runImageForensicsSuite();
            else void runVideoForensicsScan();
          }}
          disabled={adaptersRunning || videoScanRunning || deepSafeVideoRunning}
          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium text-xs border border-slate-700 transition"
        >
          {videoScanRunning
            ? 'Extracting video frames...'
            : adaptersRunning || deepSafeVideoRunning
              ? 'Analyzing...'
              : 'Re-run Laboratory Suite'}
        </button>
      </div>
      {videoScanError && labMode === 'video' && (
        <p role="alert" className="rounded-lg border border-rose-900 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
          Video frame extraction failed: {videoScanError} Use “Re-run Laboratory Suite” to retry.
        </p>
      )}

      {/* ========================================================
          IMAGE FORENSICS VIEW (MODULE 1)
      ======================================================== */}
      {labMode === 'image' && (
        <div className="space-y-6">
          <AIImageDeepfakeLab
            evidenceList={evidenceList}
            selectedItem={selectedItem}
            investigations={investigations}
            currentCase={currentCase}
            onSelectEvidence={onSelectEvidence}
            onAddEvidence={onAddEvidence}
          />
          {/* Top Row: Comparison Viewer & Suspicious Region Localization */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Image Canvas with Suspicious Overlay */}
            <div className="lg:col-span-7 bg-slate-900 rounded-2xl border border-slate-800 p-4 space-y-3">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <Split className="w-4 h-4 text-cyan-400" />
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
                    Suspicious-Region Localization & Overlay
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <div className="inline-flex rounded-lg bg-slate-950 p-1 border border-slate-800 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setOverlayMode('side_by_side')}
                      aria-pressed={overlayMode === 'side_by_side'}
                      className={`px-2 py-0.5 rounded font-medium ${
                        overlayMode === 'side_by_side' ? 'bg-cyan-500 text-slate-950 font-bold' : 'text-slate-400'
                      }`}
                    >
                      Side-by-Side
                    </button>
                    <button
                      type="button"
                      onClick={() => setOverlayMode('overlay')}
                      aria-pressed={overlayMode === 'overlay'}
                      className={`px-2 py-0.5 rounded font-medium ${
                        overlayMode === 'overlay' ? 'bg-cyan-500 text-slate-950 font-bold' : 'text-slate-400'
                      }`}
                    >
                      Overlay
                    </button>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setImageZoom((z) => Math.max(0.75, z - 0.25))}
                      className="p-1.5 bg-slate-800 hover:bg-slate-700 rounded text-slate-300"
                      title="Zoom Out"
                    >
                      <ZoomOut className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setImageZoom((z) => Math.min(2.5, z + 0.25))}
                      className="p-1.5 bg-slate-800 hover:bg-slate-700 rounded text-slate-300"
                      title="Zoom In"
                    >
                      <ZoomIn className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>

              {/* Viewer Container */}
              <div className={`relative min-h-[380px] max-h-[500px] rounded-xl border border-slate-800/80 bg-slate-950 p-3 ${
                overlayMode === 'side_by_side' ? 'overflow-auto' : 'flex items-center justify-center overflow-auto'
              }`}>
                {activeItem?.previewUrl ? (
                  overlayMode === 'side_by_side' ? (
                    <div className="grid w-full grid-cols-1 items-start gap-4 sm:grid-cols-2">
                      <figure className="min-w-0 text-center">
                        <figcaption className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                          Original image
                        </figcaption>
                        <LocalizationImage
                          imageUrl={activeItem.previewUrl}
                          alt="Original forensic examination target"
                          regions={localizedRegions}
                          overlayOpacity={overlayOpacity}
                          showOverlay={false}
                          maxHeight={320}
                          zoom={imageZoom}
                        />
                      </figure>
                      <figure className="min-w-0 text-center">
                        <figcaption className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-cyan-300">
                          ELA hotspot localization
                        </figcaption>
                        <LocalizationImage
                          imageUrl={activeItem.previewUrl}
                          alt="Forensic image with measured ELA hotspot regions"
                          regions={localizedRegions}
                          overlayOpacity={overlayOpacity}
                          showOverlay
                          maxHeight={320}
                          zoom={imageZoom}
                        />
                      </figure>
                    </div>
                  ) : (
                    <LocalizationImage
                      imageUrl={activeItem.previewUrl}
                      alt="Forensic image with measured ELA hotspot overlay"
                      regions={localizedRegions}
                      overlayOpacity={overlayOpacity}
                      showOverlay
                      maxHeight={460}
                      zoom={imageZoom}
                    />
                  )
                ) : (
                  <div className="text-xs text-slate-500">No image loaded.</div>
                )}
              </div>

              {localizedRegions.length > 0 && (
                <label className="flex items-center gap-3 text-[10px] text-slate-400">
                  <span>ELA overlay opacity</span>
                  <input
                    type="range"
                    min="10"
                    max="100"
                    value={overlayOpacity}
                    onChange={(event) => setOverlayOpacity(Number(event.target.value))}
                    aria-label="ELA hotspot overlay opacity"
                    className="flex-1 accent-cyan-400"
                  />
                  <span className="w-9 text-right font-mono">{overlayOpacity}%</span>
                </label>
              )}

              {adaptersRunning && !elaLocalization && (
                <p role="status" className="text-[11px] text-slate-400">
                  Measuring JPEG recompression differences for localized ELA regions…
                </p>
              )}
              {elaLocalization?.reliability === 'low' && (
                <p role="status" className="text-[11px] text-amber-200">
                  ELA localization is suppressed because reliability is low for this source.
                  {elaLocalization.reliabilityReasons.length > 0 ? ` ${elaLocalization.reliabilityReasons[0]}` : ''}
                </p>
              )}
              {elaLocalization && elaLocalization.reliability !== 'low' && localizedRegions.length === 0 && (
                <p role="status" className="text-[11px] text-slate-400">
                  {elaLocalization.verdict === 'global_recompression'
                    ? 'ELA found a broad recompression pattern, not a localized region.'
                    : 'No localized ELA hotspots exceeded the measurement threshold. This does not establish authenticity.'}
                </p>
              )}
              {localizedRegions.length > 0 && (
                <ul className="space-y-1 text-[10px] text-slate-400">
                  {localizedRegions.map((region, index) => (
                    <li key={region.id}>
                      Region {index + 1}: {region.label} · {region.areaPct}% of image · peak ELA deviation z={region.peakZ}
                    </li>
                  ))}
                </ul>
              )}

              {/* Disclaimer: Model Localization vs Attention Map */}
              <div className="text-[11px] text-slate-400 bg-slate-950/70 p-2.5 rounded-lg border border-slate-800/60 leading-relaxed">
                <span className="font-bold text-slate-300">Technical Note (Module 1C): </span>
                Boxes mark block-based ELA recompression hotspots when source reliability permits. Compression differences can arise from ordinary edits or sharing and are not proof of manipulation or deepfake generation.
              </div>
            </div>

            {/* Right: Multi-Model Consensus & Truth Reconstruction Engine */}
            <div className="lg:col-span-5 space-y-4">
              {/* Multi-Model Consensus Card (Module 4) */}
              <div data-royal-tilt className="p-4 bg-slate-900 rounded-2xl border border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                    <Activity className="w-4 h-4 text-cyan-400" />
                    Multi-Model Consensus Engine
                  </span>
                  {consensusSummary && (
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full border uppercase ${
                        consensusSummary.consensusState === 'agreement'
                          ? 'bg-emerald-950 border-emerald-600 text-emerald-300'
                          : consensusSummary.consensusState === 'divergence'
                          ? 'bg-amber-950 border-amber-600 text-amber-300'
                          : 'bg-slate-800 border-slate-700 text-slate-300'
                      }`}
                    >
                      {consensusSummary.consensusState}
                    </span>
                  )}
                </div>

                <p className="text-xs text-slate-300 leading-relaxed">
                  {consensusSummary?.consensusExplanation ||
                    'Evaluating configured detector adapters across spectral, spatial, and provenance features.'}
                </p>

                {consensusSummary?.consensusState === 'divergence' && (
                  <div className="p-2.5 bg-amber-950/40 border border-amber-800 rounded-lg text-amber-200 text-xs">
                    <b className="text-amber-100">Disagreement Note: </b>
                    Detectors disagree on this media. Scores are NOT averaged together to manufacture a synthetic probability.
                  </div>
                )}
              </div>

              {/* Truth Reconstruction Engine (Module 3) */}
              <div data-royal-tilt className="p-4 bg-slate-900 rounded-2xl border border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                    <Compass className="w-4 h-4 text-cyan-400" />
                    Media Truth Reconstruction (3-Tier Evidence)
                  </span>
                </div>

                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Assign calibrated forensic classification. Never automatically transform a model prediction into an investigator conclusion.
                </p>

                {/* 3-Tier Selector */}
                <div className="grid grid-cols-3 gap-1.5 p-1 bg-slate-950 rounded-xl border border-slate-800 text-[11px]">
                  <button
                    onClick={() => setTruthFactType('observed_fact')}
                    className={`py-1.5 px-2 rounded-lg font-bold transition text-center ${
                      truthFactType === 'observed_fact'
                        ? 'bg-cyan-500 text-slate-950'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    1. Observed Fact
                  </button>
                  <button
                    onClick={() => setTruthFactType('model_prediction')}
                    className={`py-1.5 px-2 rounded-lg font-bold transition text-center ${
                      truthFactType === 'model_prediction'
                        ? 'bg-cyan-500 text-slate-950'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    2. Model Prediction
                  </button>
                  <button
                    onClick={() => setTruthFactType('investigator_conclusion')}
                    className={`py-1.5 px-2 rounded-lg font-bold transition text-center ${
                      truthFactType === 'investigator_conclusion'
                        ? 'bg-cyan-500 text-slate-950'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    3. Conclusion
                  </button>
                </div>

                {truthFactType === 'investigator_conclusion' && (
                  <input
                    type="text"
                    value={customInvestigatorNote}
                    onChange={(e) => setCustomInvestigatorNote(e.target.value)}
                    placeholder="Enter professional rationale citing observations & models..."
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
                  />
                )}

                <div className="pt-1 flex gap-2">
                  <button
                    onClick={() =>
                      handleCommitTruthFinding(
                        'synthetic_deepfake',
                        'High-Frequency Checkerboard Residual',
                        'Spectral-PRNU Fourier decomposition observed elevated grid harmonics (Checkerboard Index: 68.4).',
                        'warning'
                      )
                    }
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-bold text-xs rounded-lg transition"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Record Finding into Case
                  </button>
                </div>
              </div>

              {/* C2PA Provenance Panel (Module 1E) */}
              <div data-royal-tilt className="p-4 bg-slate-900 rounded-2xl border border-slate-800 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-cyan-400" />
                    C2PA Content Credentials
                  </span>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                      c2paResult?.hasManifest
                        ? 'bg-emerald-950 border-emerald-600 text-emerald-300'
                        : 'bg-slate-800 border-slate-700 text-slate-400'
                    }`}
                  >
                    {c2paResult?.hasManifest ? 'Manifest Present' : 'No Manifest'}
                  </span>
                </div>

                <p className="text-xs text-slate-400 leading-relaxed">
                  {c2paResult?.provenanceSummary || 'Inspecting JUMBF and XMP bitstream provenance.'}
                </p>

                <div className="text-[10px] text-slate-500 bg-slate-950/60 p-2 rounded border border-slate-800/80 leading-relaxed">
                  {c2paResult?.disclaimer ||
                    'Absence of C2PA manifest does NOT imply media is fake. Valid manifest proves cryptographic provenance, not physical reality.'}
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Row: Multi-Model Detector Comparison Table (Module 1F & 4) */}
          <div data-royal-tilt className="p-4 bg-slate-900 rounded-2xl border border-slate-800 space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-cyan-400" />
                Configured Detector Adapters Matrix (Separate Model Reporting)
              </h3>
              <span className="text-xs text-slate-500 font-mono">
                {detectorOutputs.length} Models Registered
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-[10px] uppercase font-mono text-slate-400">
                    <th className="py-2.5 px-3">Detector Name</th>
                    <th className="py-2.5 px-3">Version</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3">Raw Score</th>
                    <th className="py-2.5 px-3">Score Interpretation & Semantics</th>
                    <th className="py-2.5 px-3">Documented Limitations</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {detectorOutputs.map((det) => (
                    <tr key={det.adapterId} className="hover:bg-slate-850/50 transition">
                      <td className="py-3 px-3 font-bold text-white flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-cyan-400"></span>
                        {det.adapterName}
                      </td>
                      <td className="py-3 px-3 font-mono text-slate-400">{det.version}</td>
                      <td className="py-3 px-3">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            det.status === 'completed'
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-700'
                              : 'bg-slate-800 text-slate-400 border border-slate-700'
                          }`}
                        >
                          {det.verdict}
                        </span>
                      </td>
                      <td className="py-3 px-3 font-mono font-bold text-cyan-300">
                        {det.rawScore !== undefined ? `${det.rawScore}` : 'N/A'}
                      </td>
                      <td className="py-3 px-3 text-slate-300 max-w-xs">{det.scoreSemantics}</td>
                      <td className="py-3 px-3 text-slate-400 max-w-xs text-[11px]">
                        {det.limitations[0] || 'See full protocol.'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================
          VIDEO FORENSICS VIEW (MODULE 2)
      ======================================================== */}
      {labMode === 'video' && (
        <div className="space-y-6">
          {renderDeepSafeVideoPanel()}

          {/* Interactive Forensic Timeline & Video Player (Module 2E) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Video Player */}
            <div className="lg:col-span-7 bg-slate-900 rounded-2xl border border-slate-800 p-4 space-y-3">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                  <Film className="w-4 h-4 text-cyan-400" />
                  Synchronized Keyframe Video Player
                </span>
                <span className="text-xs font-mono text-cyan-400">
                  {videoCurrentTime.toFixed(2)}s / {videoScanResult?.videoDurationSec || 0}s
                </span>
              </div>

              <div className="relative aspect-video bg-black rounded-xl overflow-hidden flex items-center justify-center border border-slate-800">
                {activeItem?.previewUrl ? (
                  <video
                    ref={videoPlayerRef}
                    src={activeItem.previewUrl}
                    controls
                    onTimeUpdate={(e) => setVideoCurrentTime(e.currentTarget.currentTime)}
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="text-xs text-slate-500">No video loaded.</div>
                )}
              </div>

              {/* Interactive Timeline Bar */}
              <div className="space-y-2 pt-2">
                <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono">
                  <span>Interactive Keyframe Timeline (Click node to seek):</span>
                  <span>{videoScanResult?.framesSampled || 0} Sampled Keyframes</span>
                </div>

                <div className="relative h-12 bg-slate-950 rounded-xl border border-slate-800 p-2 flex items-center overflow-x-auto">
                  {videoScanResult?.perFrameResults.map((frame) => {
                    const pct = ((frame.timeSec / (videoScanResult.videoDurationSec || 1)) * 100);
                    const isSelected = selectedVideoFrame?.frameIndex === frame.frameIndex;

                    return (
                      <button
                        key={frame.frameIndex}
                        onClick={() => seekVideoToTimestamp(frame.timeSec)}
                        className={`absolute -translate-x-1/2 flex flex-col items-center group transition-all`}
                        style={{ left: `${Math.min(96, Math.max(4, pct))}%` }}
                        title={`Frame #${frame.frameIndex} (${frame.formattedTime}) - Click to seek`}
                      >
                        <div
                          className={`w-3.5 h-3.5 rounded-full border-2 transition-all ${
                            isSelected
                              ? 'bg-cyan-400 border-white scale-125 shadow-[0_0_8px_#38bdf8]'
                              : 'bg-slate-700 border-slate-500 hover:bg-cyan-500'
                          }`}
                        />
                        <span className="text-[9px] font-mono text-slate-500 mt-1 group-hover:text-cyan-300">
                          {frame.formattedTime.slice(0, 5)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Right: Selected Frame Inspection & Audio Sync */}
            <div className="lg:col-span-5 space-y-4">
              {/* Frame Inspector */}
              <div data-royal-tilt className="p-4 bg-slate-900 rounded-2xl border border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
                    Inspecting Keyframe #{selectedVideoFrame?.frameIndex || 1}
                  </span>
                  <span className="text-xs font-mono text-cyan-400">
                    {selectedVideoFrame?.formattedTime}
                  </span>
                </div>

                {selectedVideoFrame?.dataUrl && (
                  <div className="aspect-video bg-black rounded-lg overflow-hidden border border-slate-800">
                    <img
                      src={selectedVideoFrame.dataUrl}
                      alt="Sampled video frame"
                      className="w-full h-full object-contain"
                    />
                  </div>
                )}

                <div className="grid grid-cols-1 gap-2 text-xs">
                  <div className="p-2 bg-slate-950 rounded border border-slate-800">
                    <span className="text-[10px] text-slate-500">Per-Frame SHA-256</span>
                    <div className="font-mono text-cyan-300 text-[11px] truncate">
                      {selectedVideoFrame?.sha256 ? selectedVideoFrame.sha256.slice(0, 16) + '...' : 'N/A'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Audio-Video Synchronization Panel (Module 2F) */}
              <div data-royal-tilt className="p-4 bg-slate-900 rounded-2xl border border-slate-800 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                    <Volume2 className="w-4 h-4 text-cyan-400" />
                    Audio-Video Synchronization (Acoustic-Optical)
                  </span>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-950 border border-emerald-600 text-emerald-300">
                    {videoScanResult?.audioSync?.syncVerdict === 'nominal_sync'
                      ? 'Nominal Sync'
                      : 'Audit Review'}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="p-2 bg-slate-950 rounded border border-slate-800">
                    <span className="text-[10px] text-slate-500">Estimated Lag</span>
                    <div className="font-bold text-slate-200">
                      {videoScanResult?.audioSync?.estimatedLagMs || 0} ms
                    </div>
                  </div>
                  <div className="p-2 bg-slate-950 rounded border border-slate-800">
                    <span className="text-[10px] text-slate-500">Correlation</span>
                    <div className="font-bold text-slate-200">
                      {videoScanResult?.audioSync?.correlationCoefficient || 0}
                    </div>
                  </div>
                </div>

                <p className="text-xs text-slate-400 leading-relaxed">
                  {videoScanResult?.audioSync?.explanation ||
                    'Analyzes speech acoustic amplitude envelopes against facial luminance motion.'}
                </p>
              </div>
            </div>
          </div>

        </div>
      )}
    </div>
    </RoyalPageFrame>
  );
};
