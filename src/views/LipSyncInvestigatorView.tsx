import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, AudioLines, Check, Clock3, Info, ScanFace, Video } from 'lucide-react';
import { EvidenceItem, AnalysisFinding } from '@/types/forensics';
import {
  analyzeLipSyncActivity,
  LipSyncActivityReport,
  NormalizedRegion,
  summarizeMouthMotion,
} from '@/lib/forensics/lipSync';
import { calculateEvidenceHashes, isValidSHA256, verifyHashesMatch } from '@/lib/forensics/crypto';
import { AudioVideoSyncDemo } from '@/components/forensics/AudioVideoSyncDemo';
import {
  analyzeSyncNetOffset,
  fetchSyncNetVideoCopy,
  getSyncNetStatus,
  SYNCNET_MAX_VIDEO_BYTES,
  SyncNetAnalysisResult,
  SyncNetStatus,
} from '@/lib/forensics/syncNetClient';
import {
  analyzeGenConViTVideo,
  GenConViTAnalysisResult,
  GenConViTStatus,
  getGenConViTStatus,
  GENCONVIT_MAX_VIDEO_BYTES,
} from '@/lib/forensics/genConViTClient';

interface LipSyncInvestigatorViewProps {
  evidenceList: EvidenceItem[];
  selectedItem?: EvidenceItem;
  onSelectEvidence: (item: EvidenceItem) => void;
  onAddFinding: (finding: Omit<AnalysisFinding, 'id' | 'createdAt'>) => void;
}

const REGION_WIDTH = 0.2;
const REGION_HEIGHT = 0.14;
const SYNCNET_SUPPORTED_EXTENSIONS = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm']);

function getVideoExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : '';
}

function getVideoContentBounds(video: HTMLVideoElement, container: HTMLElement) {
  const bounds = container.getBoundingClientRect();
  const aspect = video.videoWidth / video.videoHeight;
  const containerAspect = bounds.width / bounds.height;
  const width = aspect > containerAspect ? bounds.width : bounds.height * aspect;
  const height = aspect > containerAspect ? bounds.width / aspect : bounds.height;
  return {
    left: bounds.left + (bounds.width - width) / 2,
    top: bounds.top + (bounds.height - height) / 2,
    width,
    height,
  };
}

export const LipSyncInvestigatorView: React.FC<LipSyncInvestigatorViewProps> = ({
  evidenceList,
  selectedItem,
  onSelectEvidence,
  onAddFinding,
}) => {
  const videoEvidence = evidenceList.filter((item) => item.mediaType === 'video');
  const activeItem = selectedItem?.mediaType === 'video' ? selectedItem : videoEvidence[0];
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [selectingRegion, setSelectingRegion] = useState(false);
  const [region, setRegion] = useState<NormalizedRegion | null>(null);
  const [report, setReport] = useState<LipSyncActivityReport | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [syncNetStatus, setSyncNetStatus] = useState<SyncNetStatus | null>(null);
  const [syncNetStatusError, setSyncNetStatusError] = useState('');
  const [syncNetStatusLoading, setSyncNetStatusLoading] = useState(true);
  const [syncNetStatusRetry, setSyncNetStatusRetry] = useState(0);
  const [syncNetReport, setSyncNetReport] = useState<SyncNetAnalysisResult | null>(null);
  const [syncNetFile, setSyncNetFile] = useState<File | null>(null);
  const [syncNetBusy, setSyncNetBusy] = useState(false);
  const [syncNetProgress, setSyncNetProgress] = useState(0);
  const [syncNetElapsedSeconds, setSyncNetElapsedSeconds] = useState(0);
  const [syncNetError, setSyncNetError] = useState('');
  const [syncNetSaved, setSyncNetSaved] = useState(false);
  const [genConViTStatus, setGenConViTStatus] = useState<GenConViTStatus | null>(null);
  const [genConViTStatusLoading, setGenConViTStatusLoading] = useState(true);
  const [genConViTStatusError, setGenConViTStatusError] = useState('');
  const [genConViTReport, setGenConViTReport] = useState<GenConViTAnalysisResult | null>(null);
  const [genConViTFile, setGenConViTFile] = useState<File | null>(null);
  const [genConViTBusy, setGenConViTBusy] = useState(false);
  const [genConViTError, setGenConViTError] = useState('');

  useEffect(() => {
    setRegion(null);
    setReport(null);
    setError('');
    setSaved(false);
    setCurrentTime(0);
    setSyncNetReport(null);
    setSyncNetFile(null);
    setSyncNetError('');
    setSyncNetSaved(false);
    setGenConViTReport(null);
    setGenConViTFile(null);
    setGenConViTError('');
  }, [activeItem?.id]);

  useEffect(() => {
    let active = true;
    let pollTimer: number | undefined;
    setGenConViTStatusLoading(true);
    const checkStatus = () => {
      void getGenConViTStatus()
        .then((status) => {
          if (!active) return;
          setGenConViTStatus(status);
          setGenConViTStatusError('');
          const warming = status.fast_model_loading ||
            (status.configured && !status.fast_model_ready && !status.fast_model_error);
          setGenConViTStatusLoading(warming);
          if (warming) pollTimer = window.setTimeout(checkStatus, 1500);
        })
        .catch((statusError: unknown) => {
          if (!active) return;
          setGenConViTStatus(null);
          setGenConViTStatusError(
            statusError instanceof Error ? statusError.message : 'GenConViT status is unavailable.',
          );
          setGenConViTStatusLoading(false);
        });
    };
    checkStatus();
    return () => {
      active = false;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let retryTimer: number | undefined;
    setSyncNetStatusLoading(true);
    setSyncNetStatus(null);
    setSyncNetStatusError('');

    const checkStatus = (attempt: number) => {
      void getSyncNetStatus()
        .then((status) => {
          if (active) {
            setSyncNetStatus(status);
            setSyncNetStatusError('');
            setSyncNetStatusLoading(false);
          }
        })
        .catch((statusError: unknown) => {
          const message = statusError instanceof Error ? statusError.message : 'SyncNet status is unavailable.';
          const canRetry = /timed out|timeout|unavailable|failed to fetch/i.test(message);
          if (active && attempt === 0 && canRetry) {
            setSyncNetStatusError(`${message} Retrying once…`);
            retryTimer = window.setTimeout(() => checkStatus(1), 1000);
            return;
          }
          if (active) {
            setSyncNetStatus(null);
            setSyncNetStatusError(message);
            setSyncNetStatusLoading(false);
          }
        });
    };

    checkStatus(0);
    return () => {
      active = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [syncNetStatusRetry]);

  useEffect(() => {
    if (!syncNetBusy) return;
    const startedAt = Date.now();
    setSyncNetElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setSyncNetElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [syncNetBusy]);

  const selectedTime = currentTime;
  const normalizedSignals = useMemo(() => {
    if (!report) return null;
    const mouthApertures = report.samples
      .map((sample) => sample.mouthApertureRatio)
      .filter((value): value is number => value !== null);
    const maxMouthAperture = Math.max(...mouthApertures, 0.000001);
    return {
      speech: report.samples.map((sample) => sample.speechScore),
      mouth: report.samples.map((sample) => (
        sample.mouthApertureRatio === null ? null : sample.mouthApertureRatio / maxMouthAperture
      )),
    };
  }, [report]);
  const mouthMotion = useMemo(
    () => report ? summarizeMouthMotion(report.samples) : null,
    [report],
  );
  const observation = report
    ? !report.audioSignalDetected
      ? { label: 'No measurable audio; the track may be silent, absent, or unsupported', className: 'border-amber-400/25 bg-amber-950/20 text-amber-100' }
      : report.faceFramesDetected === 0
      ? { label: 'Mouth not tracked in selected region', className: 'border-rose-400/25 bg-rose-950/25 text-rose-200' }
      : report.speechSegments.length === 0
        ? { label: 'No speech-like activity detected', className: 'border-amber-400/25 bg-amber-950/20 text-amber-100' }
        : report.comparison.correlation === null
          ? { label: 'Speech and mouth detected; timing not calculable', className: 'border-amber-400/25 bg-amber-950/20 text-amber-100' }
          : { label: 'Speech and mouth activity detected; review estimate', className: 'border-emerald-400/25 bg-emerald-950/20 text-emerald-100' }
    : null;
  const regionStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!region || !videoRef.current || !previewRef.current) return undefined;
    const video = videoRef.current;
    if (!video.videoWidth || !video.videoHeight) return undefined;
    const content = getVideoContentBounds(video, previewRef.current);
    const container = previewRef.current.getBoundingClientRect();
    return {
      left: `${((content.left - container.left + region.x * content.width) / container.width) * 100}%`,
      top: `${((content.top - container.top + region.y * content.height) / container.height) * 100}%`,
      width: `${(region.width * content.width / container.width) * 100}%`,
      height: `${(region.height * content.height / container.height) * 100}%`,
    };
  }, [region]);

  const handleRegionClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    const container = previewRef.current;
    if (!selectingRegion || !video || !container || !video.videoWidth || !video.videoHeight) return;
    const bounds = getVideoContentBounds(video, container);
    const centerX = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const centerY = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
    const x = Math.max(0, Math.min(1 - REGION_WIDTH, centerX - REGION_WIDTH / 2));
    const y = Math.max(0, Math.min(1 - REGION_HEIGHT, centerY - REGION_HEIGHT / 2));
    setRegion({ x, y, width: REGION_WIDTH, height: REGION_HEIGHT });
    setReport(null);
    setError('');
    setSelectingRegion(false);
  };

  const handleAnalyze = async () => {
    if (!activeItem || !region) return;
    setIsAnalyzing(true);
    setError('');
    setSaved(false);
    try {
      const result = await analyzeLipSyncActivity(activeItem.previewUrl, region);
      setReport(result);
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : 'Audio-video timing analysis failed.');
      setReport(null);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleSyncNetAnalyze = async () => {
    if (!activeItem || !isValidSHA256(activeItem.sha256Hash)) {
      setSyncNetError('This evidence does not have a valid SHA-256 digest to verify the local analysis copy.');
      return;
    }

    setSyncNetBusy(true);
    setSyncNetProgress(0);
    setSyncNetError('');
    setSyncNetReport(null);
    setSyncNetSaved(false);
    try {
      let videoBlob: Blob;
      const sourceName = syncNetFile?.name || activeItem.fileName;
      const extension = getVideoExtension(sourceName);
      if (!SYNCNET_SUPPORTED_EXTENSIONS.has(extension)) {
        throw new Error('Choose a supported video file: AVI, M4V, MKV, MOV, MP4, or WebM.');
      }

      if (syncNetFile) {
        videoBlob = syncNetFile;
      } else if (/^(blob:|data:)/i.test(activeItem.previewUrl)) {
        const cachedResponse = await fetch(activeItem.previewUrl);
        if (!cachedResponse.ok) throw new Error('The cached browser video could not be read.');
        videoBlob = await cachedResponse.blob();
      } else if (/^https?:\/\//i.test(activeItem.previewUrl)) {
        videoBlob = await fetchSyncNetVideoCopy(activeItem.previewUrl);
      } else {
        throw new Error('This evidence has no downloadable preview. Select its local video file to run SyncNet.');
      }

      if (videoBlob.size === 0) throw new Error('The selected video file is empty.');
      if (videoBlob.size > SYNCNET_MAX_VIDEO_BYTES) throw new Error('SyncNet accepts videos up to 128 MB.');

      const hashes = await calculateEvidenceHashes(videoBlob, ({ processedBytes, totalBytes }) => {
        setSyncNetProgress(totalBytes ? Math.round((processedBytes / totalBytes) * 100) : 100);
      });
      if (!verifyHashesMatch(hashes.sha256, activeItem.sha256Hash)) {
        throw new Error('The local file does not match the selected evidence SHA-256. No analysis was sent.');
      }

      setSyncNetProgress(0);
      const result = await analyzeSyncNetOffset(videoBlob, extension, hashes.sha256);
      if (!verifyHashesMatch(result.source_sha256, activeItem.sha256Hash)) {
        throw new Error('The analysis service reported a source hash that does not match the evidence.');
      }
      setSyncNetReport(result);
    } catch (analysisError) {
      setSyncNetError(
        analysisError instanceof Error && analysisError.name === 'TimeoutError'
          ? 'SyncNet analysis took longer than 18 minutes. Check the local backend and try again.'
          : analysisError instanceof Error
            ? analysisError.message
            : 'SyncNet offset analysis failed.',
      );
    } finally {
      setSyncNetBusy(false);
      setSyncNetProgress(0);
    }
  };

  const handleGenConViTAnalyze = async () => {
    if (!activeItem || !isValidSHA256(activeItem.sha256Hash)) {
      setGenConViTError('This evidence does not have a valid SHA-256 digest for local analysis.');
      return;
    }

    setGenConViTBusy(true);
    setGenConViTError('');
    setGenConViTReport(null);
    try {
      let videoBlob: Blob;
      const sourceName = genConViTFile?.name || activeItem.fileName;
      const extension = getVideoExtension(sourceName);
      if (!SYNCNET_SUPPORTED_EXTENSIONS.has(extension)) {
        throw new Error('Choose a supported video file: AVI, M4V, MKV, MOV, MP4, or WebM.');
      }

      if (genConViTFile) {
        videoBlob = genConViTFile;
      } else if (/^(blob:|data:)/i.test(activeItem.previewUrl)) {
        const cachedResponse = await fetch(activeItem.previewUrl);
        if (!cachedResponse.ok) throw new Error('The cached browser video could not be read.');
        videoBlob = await cachedResponse.blob();
      } else if (/^https?:\/\//i.test(activeItem.previewUrl)) {
        videoBlob = await fetchSyncNetVideoCopy(activeItem.previewUrl);
      } else {
        throw new Error('This evidence has no downloadable preview. Select its local video file.');
      }

      if (videoBlob.size === 0) throw new Error('The selected video file is empty.');
      if (videoBlob.size > GENCONVIT_MAX_VIDEO_BYTES) throw new Error('GenConViT accepts videos up to 128 MB.');

      const hashes = await calculateEvidenceHashes(videoBlob);
      if (!verifyHashesMatch(hashes.sha256, activeItem.sha256Hash)) {
        throw new Error('The local file does not match the selected evidence SHA-256. No analysis was sent.');
      }

      const result = await analyzeGenConViTVideo(videoBlob, extension, hashes.sha256);
      if (!verifyHashesMatch(result.source_sha256, activeItem.sha256Hash)) {
        throw new Error('The local analysis service reported a source hash that does not match the evidence.');
      }
      setGenConViTReport(result);
    } catch (analysisError) {
      setGenConViTError(
        analysisError instanceof Error ? analysisError.message : 'GenConViT video screening failed.',
      );
    } finally {
      setGenConViTBusy(false);
    }
  };

  const handleRecordSyncNetFinding = () => {
    if (!activeItem || !syncNetReport) return;
    const trackSummary = syncNetReport.tracks.length
      ? syncNetReport.tracks.map((track) =>
        `Track ${track.track_index + 1}: offset ${track.offset_frames} frames (${track.offset_seconds.toFixed(4)} seconds), SyncNet confidence measure ${track.confidence_score.toFixed(4)}.`,
      ).join(' ')
      : syncNetReport.message || 'No face track produced an offset estimate.';
    onAddFinding({
      investigationId: activeItem.investigationId,
      evidenceId: activeItem.id,
      title: 'SyncNet audio-video offset estimate',
      severity: 'informational',
      category: 'audio_signal',
      observedEvidence: `${trackSummary} Input SHA-256: ${syncNetReport.source_sha256}.`,
      simpleExplanation: 'SyncNet compared audio with detected face movement and estimated timing offsets. The numbers are estimates, not proof of editing or inauthenticity. The original video was not changed.',
      technicalExplanation: [
        `Model: SyncNet ${syncNetReport.model_version} (upstream revision ${syncNetReport.upstream_revision}).`,
        `Source duration: ${syncNetReport.video_duration_seconds.toFixed(3)}s; analyzed segment: ${syncNetReport.analysis_segment_start_seconds.toFixed(3)}s–${syncNetReport.analysis_segment_end_seconds.toFixed(3)}s (${syncNetReport.analysis_segment_duration_seconds.toFixed(3)}s); frame rate used by the upstream pipeline: ${syncNetReport.frame_rate} fps.`,
        ...(syncNetReport.min_face_size_pixels !== undefined
          ? [`Face-track filter: tracks must average more than ${syncNetReport.min_face_size_pixels}px; detector scale ${syncNetReport.face_detection_scale ?? 'not reported'}.`]
          : []),
        syncNetReport.offset_semantics || 'Offsets use SyncNet upstream signed frame convention.',
        syncNetReport.confidence_semantics || 'Confidence is a model measure, not a calibrated probability.',
        trackSummary,
        `Source SHA-256: ${syncNetReport.source_sha256}`,
      ].join('\n'),
      detectionMethod: 'SyncNet audio-video synchronization offset estimation with face-track preprocessing',
      detectorVersion: `SyncNet ${syncNetReport.model_version} · ${syncNetReport.upstream_revision}`,
      scoreInterpretation: 'Offset is reported in SyncNet frame units at 25 fps; confidence is a model measure, not a probability.',
      limitations: `SyncNet requires detectable face tracks and reports the upstream model offset convention. Confidence is not calibrated as a probability. Compression, editing, multiple speakers, face-detection errors, and short clips can affect the estimate. For longer videos, only the centered ${syncNetReport.analysis_segment_duration_seconds.toFixed(1)}-second segment was analyzed; results do not describe the entire video. This feature reports offsets only and does not trim or alter the original evidence.`,
      potentialFalsePositives: 'Natural recording offsets, video edits, dubbing, face-tracking mistakes, or multiple visible speakers may produce confusing offsets.',
      unresolvedQuestions: 'The result alone cannot show whether a mismatch was intentional, whether the speaker is authentic, or whether the offset is due to the recording process.',
      recommendedNextSteps: 'Review the reported track and offset against the original evidence and, if synchronization is adjusted, create and hash a separate derivative.',
      evidenceLabel: 'model_prediction',
      sourceSha256: syncNetReport.source_sha256,
    });
    setSyncNetSaved(true);
  };

  const handleRecordFinding = () => {
    if (!activeItem || !report) return;
    const { comparison } = report;
    const motionSummary = summarizeMouthMotion(report.samples);
    const lagDescription = comparison.visualLagSec === null
      ? 'No stable correlation could be calculated from speech probabilities and mouth aperture.'
      : `The strongest tested correlation was ${comparison.correlation?.toFixed(3)} at a mouth-lag estimate of ${comparison.visualLagSec.toFixed(2)} seconds (positive values indicate mouth aperture follows detected speech activity).`;
    const faceCoverage = `${report.faceFramesDetected}/${report.samples.length} sampled frames contained a mouth landmark in the selected region`;
    const apertureDescription = motionSummary.apertureRange === null
      ? 'No mouth-aperture range could be measured.'
      : `The measured mouth-aperture range was ${motionSummary.apertureRange.toFixed(3)} normalized units across ${motionSummary.trackedSamples} tracked samples.`;
    const speechSummary = report.speechSegments.length
      ? `Silero VAD detected speech-like activity in ${report.speechSegments.length} interval(s).`
      : 'Silero VAD did not detect speech-like activity in the analyzed audio.';
    onAddFinding({
      investigationId: activeItem.investigationId,
      evidenceId: activeItem.id,
      title: 'Local speech and mouth activity review',
      severity: 'informational',
      category: 'audio_signal',
      observedEvidence: `${speechSummary} ${faceCoverage}. ${apertureDescription} ${lagDescription} ${comparison.sampleCount} paired samples at approximately ${report.sampleIntervalSec}s intervals over ${report.analyzedDurationSec.toFixed(1)}s. Natural versus AI-generated mouth motion was not determined. Selected region: x=${region?.x.toFixed(3)}, y=${region?.y.toFixed(3)}, width=${region?.width.toFixed(3)}, height=${region?.height.toFixed(3)}.`,
      plainEnglishSummary: 'Local models estimated speech activity and measured mouth landmarks and aperture changes. This approximate timing review does not determine whether mouth movement was natural or AI-generated.',
      detectionMethod: `${report.speechDetector}; ${report.mouthLandmarkModel}; speech-probability and mouth-aperture correlation`,
      detectorVersion: `${report.speechDetector}; ${report.mouthLandmarkModel}`,
      limitations: 'Voice activity detection can mistake noise for speech or miss quiet speech. Mouth landmarks can be inaccurate under occlusion, low resolution, profile views, or rapid movement. Sampling is approximately 10 frames per second and only covers the first 60 seconds. Correlation is a model-assisted estimate, not a calibrated SyncNet offset, proof of manipulation, or 100% accurate determination. This workflow has no validated or authorized classifier for distinguishing natural from AI-generated mouth motion. SyncNet findings, when available, are reported separately.',
      potentialFalsePositives: 'Background voices or noise may be classified as speech; other visible people, facial motion, occlusion, and inaccurate landmark placement can affect the mouth signal.',
      unresolvedQuestions: 'Does the detected speech belong to the tracked person? Are the audio and video tracks original and continuously recorded? Was mouth motion natural or AI-generated? The current analysis cannot determine this.',
      recommendedNextSteps: 'Review the reported intervals against the original evidence and use the separate SyncNet analysis when a forensic offset estimate is required.',
    });
    setSaved(true);
  };

  if (!activeItem) {
    return (
      <main className="mx-auto max-w-6xl space-y-6 p-4 text-[var(--vl-text-primary)] sm:p-7">
        <div className="vl-surface p-8 text-center">
          <Video className="mx-auto h-9 w-9 text-cyan-300" />
          <h1 className="mt-4 text-xl font-bold">Audio-video timing investigator</h1>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-[var(--vl-text-secondary)]">
            Ingest a video with a decodable audio track to run local speech-activity and mouth-landmark analysis.
          </p>
        </div>
        <AudioVideoSyncDemo
          syncNetStatus={syncNetStatus}
          syncNetStatusError={syncNetStatusError}
          syncNetStatusLoading={syncNetStatusLoading}
          onRetrySyncNet={() => setSyncNetStatusRetry((current) => current + 1)}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 text-[var(--vl-text-primary)] sm:p-7">
      <header className="space-y-2">
        <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.2em] text-[var(--vl-ice-cyan)]">
          <AudioLines className="h-4 w-4" /> Audio-video timing review
        </p>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Compare track activity over time</h1>
        <p className="max-w-3xl text-sm leading-6 text-[var(--vl-text-secondary)]">
          Local Silero VAD estimates speech activity while MediaPipe tracks mouth landmarks in a selected region. This is an approximate timing aid, not a guarantee of accuracy or an authenticity determination.
        </p>
      </header>

      <AudioVideoSyncDemo
        syncNetStatus={syncNetStatus}
        syncNetStatusError={syncNetStatusError}
        syncNetStatusLoading={syncNetStatusLoading}
        onRetrySyncNet={() => setSyncNetStatusRetry((current) => current + 1)}
      />

      <section className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,.8fr)]">
        <div className="vl-surface space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-[var(--vl-text-dim)]">Selected evidence</p>
              <p className="truncate text-sm font-semibold">{activeItem.fileName}</p>
            </div>
            {videoEvidence.length > 1 && (
              <select
                className="max-w-full rounded-lg border border-[var(--vl-border)] bg-[var(--vl-surface-elevated)] px-3 py-2 text-xs"
                value={activeItem.id}
                onChange={(event) => {
                  const item = videoEvidence.find((candidate) => candidate.id === event.target.value);
                  if (item) {
                    setRegion(null);
                    setReport(null);
                    setError('');
                    onSelectEvidence(item);
                  }
                }}
                aria-label="Select video"
              >
                {videoEvidence.map((item) => <option key={item.id} value={item.id}>{item.fileName}</option>)}
              </select>
            )}
          </div>

          <div
            ref={previewRef}
            className={`relative aspect-video overflow-hidden rounded-xl border bg-black ${selectingRegion ? 'cursor-crosshair border-cyan-400' : 'border-[var(--vl-border)]'}`}
            onClick={handleRegionClick}
            aria-label={selectingRegion ? 'Click the mouth or visual region to inspect' : undefined}
          >
            <video
              key={activeItem.id}
              ref={videoRef}
              className="h-full w-full object-contain"
              src={activeItem.previewUrl}
              controls
              preload="metadata"
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
            />
            {region && (
              <div
                className="pointer-events-none absolute border-2 border-cyan-300 bg-cyan-300/10 shadow-[0_0_0_1px_rgba(0,0,0,.7)]"
                style={regionStyle}
              />
            )}
            {selectingRegion && (
              <div className="pointer-events-none absolute left-2 top-2 rounded-md bg-slate-950/85 px-2 py-1 text-[10px] text-cyan-100">
                Click the center of the visible mouth or region to inspect
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setSelectingRegion(true)}
              className="vl-btn-secondary text-xs"
            >
              <ScanFace className="h-4 w-4" /> {region ? 'Choose region again' : 'Select visual region'}
            </button>
            <button
              type="button"
              onClick={handleAnalyze}
              disabled={!region || isAnalyzing}
              className="vl-btn-primary text-xs disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isAnalyzing ? 'Analyzing locally…' : 'Run local speech + mouth analysis'}
            </button>
          </div>
        </div>

        <aside className="space-y-4">
          <div className="vl-surface space-y-3 p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><Info className="h-4 w-4 text-cyan-300" /> Method status</h2>
            <p className="text-xs leading-5 text-[var(--vl-text-secondary)]">
              Local Silero VAD v5 analyzes decoded audio while MediaPipe Face Landmarker samples video at about 10 frames per second. Analysis is limited to the first 60 seconds and selected mouth region.
            </p>
            <ul className="space-y-2 text-xs text-[var(--vl-text-secondary)]">
              <li className="flex items-start gap-2"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" />No cloud inference API or API key is required; audio and video frames are processed in this browser.</li>
              <li className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />MediaPipe may send product usage or diagnostic metrics; media frames are not sent for inference.</li>
              <li className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />Model estimates can be wrong and cannot guarantee 100% accuracy or prove manipulation.</li>
            </ul>
          </div>

          {error && (
            <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-950/25 p-4 text-xs leading-5 text-rose-200">
              {error}
            </div>
          )}

          {report && (
            <div className="vl-surface space-y-3 p-4">
              <h2 className="text-sm font-semibold">Measured comparison</h2>
              {observation && (
                <div className={`rounded-lg border p-3 ${observation.className}`}>
                  <p className="text-[10px] font-mono uppercase tracking-[.15em] opacity-80">Observation</p>
                  <p className="mt-1 text-xs font-semibold">{observation.label}</p>
                </div>
              )}
              <div className="rounded-lg border border-amber-400/25 bg-amber-950/20 p-3 text-amber-100">
                <p className="text-[10px] font-mono uppercase tracking-[.15em] text-amber-200">Mouth-motion origin classification</p>
                <p className="mt-1 text-xs font-semibold">Unavailable — no validated mouth-origin classifier is configured</p>
                <p className="mt-1 text-[11px] leading-5 text-amber-100/85">
                  Mouth landmarks were tracked in {mouthMotion?.trackedSamples ?? 0}/{mouthMotion?.totalSamples ?? 0} samples
                  {' '}({mouthMotion?.trackingPercent ?? 0}% coverage); measured aperture range:{' '}
                  {mouthMotion?.apertureRange === null || mouthMotion?.apertureRange === undefined
                    ? 'unavailable'
                    : mouthMotion.apertureRange.toFixed(3)}.
                  {' '}These are movement measurements only; they cannot establish whether the motion is natural, AI-generated, dubbed, or animated. No origin verdict can be made from this analysis.
                </p>
              </div>
              <dl className="grid grid-cols-2 gap-3 text-xs">
                <div><dt className="text-[var(--vl-text-dim)]">Video</dt><dd className="mt-1 font-mono">{report.width} × {report.height}</dd></div>
                <div><dt className="text-[var(--vl-text-dim)]">Duration sampled</dt><dd className="mt-1 font-mono">{report.analyzedDurationSec.toFixed(1)}s / {report.durationSec.toFixed(1)}s</dd></div>
                <div><dt className="text-[var(--vl-text-dim)]">Speech intervals</dt><dd className="mt-1 font-mono">{report.speechSegments.length ? report.speechSegments.length : 'None detected'}</dd></div>
                <div><dt className="text-[var(--vl-text-dim)]">Measurable audio</dt><dd className="mt-1 font-mono">{report.audioSignalDetected ? 'Yes' : 'Not detected'}</dd></div>
                <div><dt className="text-[var(--vl-text-dim)]">Mouth tracked</dt><dd className="mt-1 font-mono">{report.faceFramesDetected}/{report.samples.length} frames</dd></div>
                <div><dt className="text-[var(--vl-text-dim)]">Mouth lag estimate</dt><dd className="mt-1 font-mono">{report.comparison.visualLagSec === null ? 'Insufficient paired signal' : `${report.comparison.visualLagSec.toFixed(2)}s`}</dd></div>
                <div><dt className="text-[var(--vl-text-dim)]">Speech/mouth correlation</dt><dd className="mt-1 font-mono">{report.comparison.correlation === null ? 'Not calculable' : report.comparison.correlation.toFixed(3)}</dd></div>
                <div className="col-span-2"><dt className="text-[var(--vl-text-dim)]">Models</dt><dd className="mt-1">{report.speechDetector}; {report.mouthLandmarkModel}</dd></div>
                {report.speechSegments.length > 0 && (
                  <div className="col-span-2">
                    <dt className="text-[var(--vl-text-dim)]">Detected speech intervals</dt>
                    <dd className="mt-1 font-mono">{report.speechSegments.slice(0, 8).map((segment) => `${segment.startSeconds.toFixed(1)}–${segment.endSeconds.toFixed(1)}s`).join(', ')}{report.speechSegments.length > 8 ? ', …' : ''}</dd>
                  </div>
                )}
              </dl>
              <p className="rounded-lg border border-amber-400/20 bg-amber-950/20 p-3 text-[11px] leading-5 text-amber-100/90">
                These are local model estimates. VAD detects speech-like activity, not words or speaker identity; mouth tracking can fail. The correlation is not a validated lip-sync score and is not guaranteed to be accurate.
              </p>
              <button type="button" onClick={handleRecordFinding} className="vl-btn-secondary w-full text-xs">
                <Clock3 className="h-3.5 w-3.5" /> {saved ? 'Observation recorded' : 'Record observation'}
              </button>
            </div>
          )}
        </aside>
      </section>

      <section className="vl-surface space-y-4 p-4 sm:p-5">
        <div>
          <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.2em] text-[var(--vl-ice-cyan)]">
            <Video className="h-4 w-4" /> GenConViT local video screening
          </p>
          <h2 className="mt-1 text-lg font-bold">Screen the video for deepfake artifacts</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-[var(--vl-text-secondary)]">
            The time-bounded screen checks up to {genConViTStatus?.rapid_face_search_frames ?? 5} evenly spaced frames for a face,
            then runs the official GenConViT-ED model on one face frame. It targets a result within 50 seconds on the tested CPU.
            The 15-frame ED+VAE ensemble exceeds that limit and is not offered here. This screen does not determine mouth-motion origin.
          </p>
        </div>

        {genConViTStatusLoading && (
          <p role="status" className="text-xs text-[var(--vl-text-dim)]">
            {genConViTStatus?.configured
              ? 'Warming the rapid local model. Analysis will be available as soon as it finishes.'
              : 'Checking local GenConViT readiness…'}
          </p>
        )}
        {genConViTStatusError && (
          <p role="alert" className="rounded-lg border border-rose-900 bg-rose-950/30 p-3 text-xs text-rose-200">{genConViTStatusError}</p>
        )}
        {genConViTStatus && !genConViTStatus.configured && (
          <p role="status" className="rounded-lg border border-amber-800/70 bg-amber-950/25 p-3 text-xs leading-5 text-amber-100">
            The local model is not ready. Missing: {[...genConViTStatus.missing_files, ...genConViTStatus.missing_dependencies].join(', ') || 'unknown requirements'}.
            Install the model from Admin → Model Management. No video was sent for analysis.
          </p>
        )}
        {genConViTStatus?.configured && (
          <p role="status" className="text-[11px] text-emerald-300">
            {genConViTStatus.fast_model_ready
              ? 'Rapid model ready'
              : genConViTStatus.fast_model_error
                ? 'Rapid model unavailable'
                : 'Rapid model warming'} · revision {genConViTStatus.model_version.slice(0, 10)} · {genConViTStatus.device} · 1 face frame / up to {genConViTStatus.rapid_face_search_frames} search frames · max {genConViTStatus.max_video_duration_seconds}s / {Math.round(genConViTStatus.max_video_bytes / (1024 * 1024))} MB.
          </p>
        )}
        {genConViTStatus?.fast_model_error && (
          <p role="alert" className="rounded-lg border border-amber-800/70 bg-amber-950/25 p-3 text-xs text-amber-100">
            Rapid model warm-up failed: {genConViTStatus.fast_model_error}. No GenConViT screen is available until the model is working.
          </p>
        )}

        <label className="block rounded-xl border border-dashed border-[var(--vl-border)] bg-[var(--vl-surface-elevated)] p-3 text-xs">
          <span className="font-semibold">Local video copy (optional; selected preview is downloaded when needed)</span>
          <input
            type="file"
            accept="video/*,.avi,.m4v,.mkv,.mov,.mp4,.webm"
            disabled={genConViTBusy}
            onChange={(event) => {
              setGenConViTFile(event.target.files?.[0] || null);
              setGenConViTReport(null);
              setGenConViTError('');
            }}
            className="mt-2 block w-full text-xs"
          />
          {genConViTFile && <span className="mt-1 block break-all text-[var(--vl-text-dim)]">Selected: {genConViTFile.name}</span>}
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleGenConViTAnalyze()}
            disabled={
              genConViTBusy ||
              !genConViTStatus?.configured ||
              !activeItem ||
              genConViTStatus.fast_model_loading ||
              (!genConViTStatus.fast_model_ready && !genConViTStatus.fast_model_error)
            }
            className="vl-btn-primary text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            {genConViTBusy
              ? 'Running time-bounded local screen…'
              : 'Run rapid GenConViT screening'}
          </button>
          <span className="text-[10px] text-[var(--vl-text-dim)]">
            Local-only inference · evidence SHA-256 checked before and after transfer
          </span>
        </div>
        {genConViTBusy && (
          <p role="status" className="text-[11px] text-[var(--vl-text-dim)]">
            Searching up to {genConViTStatus?.rapid_face_search_frames ?? 5} points for a face, then screening one frame locally.
            The request returns no partial or fabricated result if the 50-second limit is exceeded.
          </p>
        )}
        {genConViTError && (
          <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/25 p-3 text-xs leading-5 text-rose-200">{genConViTError}</p>
        )}
        {genConViTReport && (
          <div className="space-y-3 rounded-xl border border-[var(--vl-border)] bg-[var(--vl-surface-elevated)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[10px] font-mono uppercase tracking-[.15em] text-amber-300">
                  Rapid single-face-frame screen · not a forensic conclusion
                </p>
                <h3 className={`text-sm font-bold ${genConViTReport.predicted_class === 'FAKE' ? 'text-rose-300' : 'text-emerald-300'}`}>
                  GenConViT predicted class: {genConViTReport.predicted_class}
                </h3>
              </div>
              <span className="font-mono text-[10px] text-[var(--vl-text-dim)]">
                {genConViTReport.inference_seconds.toFixed(1)}s · {genConViTReport.device}
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-3 text-xs">
              <div><dt className="text-[var(--vl-text-dim)]">Fake score</dt><dd className="mt-1 font-mono">{genConViTReport.fake_score.toFixed(4)} <span className="text-[var(--vl-text-dim)]">(uncalibrated)</span></dd></div>
              <div><dt className="text-[var(--vl-text-dim)]">Real score</dt><dd className="mt-1 font-mono">{genConViTReport.real_score.toFixed(4)} <span className="text-[var(--vl-text-dim)]">(uncalibrated)</span></dd></div>
              <div><dt className="text-[var(--vl-text-dim)]">Face search</dt><dd className="mt-1 font-mono">{genConViTReport.faces_detected} face used; found in {genConViTReport.frames_with_faces}/{genConViTReport.face_search_frames} checked frames</dd></div>
              <div><dt className="text-[var(--vl-text-dim)]">Video</dt><dd className="mt-1 font-mono">{genConViTReport.video_fps.toFixed(2)} FPS · {genConViTReport.video_duration_seconds.toFixed(2)}s</dd></div>
              <div className="col-span-2"><dt className="text-[var(--vl-text-dim)]">Model revision / analysis time</dt><dd className="mt-1 font-mono">{genConViTReport.model_version} · {new Date(genConViTReport.analysis_timestamp).toLocaleString()}</dd></div>
            </dl>
            <p className="break-all text-[10px] text-[var(--vl-text-dim)]">Source SHA-256: {genConViTReport.source_sha256}</p>
            <p className="rounded-lg border border-amber-400/20 bg-amber-950/20 p-3 text-[11px] leading-5 text-amber-100/90">
              {genConViTReport.score_semantics} The model was evaluated on specific benchmark datasets; those published metrics do not establish accuracy for this video. A REAL prediction does not prove authenticity, and a FAKE prediction does not prove synthetic mouth motion.
            </p>
          </div>
        )}
      </section>

      <section className="vl-surface space-y-4 p-4 sm:p-5">
        <div>
          <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.2em] text-[var(--vl-ice-cyan)]">
            <AudioLines className="h-4 w-4" /> SyncNet offset estimate
          </p>
          <h2 className="mt-1 text-lg font-bold">Estimate audio/video timing offset</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-[var(--vl-text-secondary)]">
            Uses the open-source SyncNet v2 pipeline to detect and track faces, then compare face-track and audio features.
            It reports offset estimates only; it does not trim, re-encode, or modify the original.
          </p>
        </div>

        {syncNetStatusError && (
          <p role="alert" className="rounded-lg border border-rose-900 bg-rose-950/30 p-3 text-xs text-rose-200">{syncNetStatusError}</p>
        )}
        {syncNetStatus && !syncNetStatus.configured && (
          <p role="status" className="rounded-lg border border-amber-800/70 bg-amber-950/25 p-3 text-xs leading-5 text-amber-100">
            SyncNet is not configured in the local backend. Missing: {[...syncNetStatus.missing_files, ...syncNetStatus.missing_dependencies, ...syncNetStatus.missing_tools].join(', ') || 'unknown requirements'}.
            See <code>backend/SYNCNET_SETUP.md</code> for local setup.
          </p>
        )}
        {syncNetStatus?.configured && (
          <p role="status" className="text-[11px] text-emerald-300">
            Local model ready · revision {syncNetStatus.upstream_revision.slice(0, 10)} · up to {syncNetStatus.max_video_duration_seconds}s / {Math.round(syncNetStatus.max_video_bytes / (1024 * 1024))} MB. Each run analyzes a centered {syncNetStatus.analysis_window_seconds}s segment; shorter videos are analyzed in full. A face must be trackable for about 4 seconds to return an estimate.
          </p>
        )}

        <label className="block rounded-xl border border-dashed border-[var(--vl-border)] bg-[var(--vl-surface-elevated)] p-3 text-xs">
          <span className="font-semibold">Local video copy (optional; selected preview is downloaded when needed)</span>
          <input
            type="file"
            accept="video/*,.avi,.m4v,.mkv,.mov,.mp4,.webm"
            disabled={syncNetBusy || !syncNetStatus?.configured}
            onChange={(event) => {
              setSyncNetFile(event.target.files?.[0] || null);
              setSyncNetReport(null);
              setSyncNetError('');
              setSyncNetSaved(false);
            }}
            className="mt-2 block w-full text-xs"
          />
          {syncNetFile && <span className="mt-1 block break-all text-[var(--vl-text-dim)]">Selected: {syncNetFile.name}</span>}
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleSyncNetAnalyze()}
            disabled={syncNetBusy || !syncNetStatus?.configured}
            className="vl-btn-primary text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            {syncNetBusy ? `Verifying and analyzing… ${syncNetProgress ? `${syncNetProgress}%` : ''}` : 'Estimate SyncNet offset'}
          </button>
          <span className="text-[10px] text-[var(--vl-text-dim)]">
            Selected preview or local file · SHA-256 checked before and after transfer
          </span>
        </div>
        {syncNetBusy && (
          <p role="status" className="text-[11px] text-[var(--vl-text-dim)]">
            Local SyncNet is processing a centered {syncNetStatus?.analysis_window_seconds ?? 5}s segment. Runtime depends on your system. Keep this page open; elapsed time: {Math.floor(syncNetElapsedSeconds / 60)}m {syncNetElapsedSeconds % 60}s.
          </p>
        )}
        {syncNetError && (
          <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/25 p-3 text-xs leading-5 text-rose-200">{syncNetError}</p>
        )}

        {syncNetReport && (
          <div className="space-y-3 rounded-xl border border-[var(--vl-border)] bg-[var(--vl-surface-elevated)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[10px] font-mono uppercase tracking-[.15em] text-amber-300">Observation</p>
                <h3 className="text-sm font-bold">SyncNet results</h3>
              </div>
              <span className="font-mono text-[10px] text-[var(--vl-text-dim)]">
                Source {syncNetReport.video_duration_seconds.toFixed(2)}s · analyzed {syncNetReport.analysis_segment_start_seconds.toFixed(2)}–{syncNetReport.analysis_segment_end_seconds.toFixed(2)}s · {syncNetReport.analysis_duration_seconds?.toFixed(2) ?? '—'}s processing
              </span>
            </div>
            {syncNetReport.min_face_size_pixels !== undefined && (
              <p className="text-[10px] text-[var(--vl-text-dim)]">
                Face-track filter: average face size must exceed {syncNetReport.min_face_size_pixels}px · detector scale {syncNetReport.face_detection_scale ?? 'not reported'}.
              </p>
            )}
            {syncNetReport.tracks.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-[10px] uppercase text-[var(--vl-text-dim)]">
                    <tr>
                      <th className="py-2 pr-3">Face track</th>
                      <th className="py-2 pr-3">Track duration</th>
                      <th className="py-2 pr-3">Offset (frames)</th>
                      <th className="py-2 pr-3">Offset (seconds)</th>
                      <th className="py-2">Confidence measure</th>
                    </tr>
                  </thead>
                  <tbody>
                    {syncNetReport.tracks.map((track) => (
                      <tr key={track.track_index} className="border-t border-[var(--vl-border)]">
                        <td className="py-2 pr-3">{track.track_index + 1}</td>
                        <td className="py-2 pr-3 font-mono">{track.face_track_duration_seconds.toFixed(2)}s</td>
                        <td className="py-2 pr-3 font-mono">{track.offset_frames > 0 ? '+' : ''}{track.offset_frames}</td>
                        <td className="py-2 pr-3 font-mono">{track.offset_seconds > 0 ? '+' : ''}{track.offset_seconds.toFixed(4)}s</td>
                        <td className="py-2 font-mono">{track.confidence_score.toFixed(4)} <span className="text-[var(--vl-text-dim)]">(not probability)</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-amber-200">{syncNetReport.message || 'No usable face tracks were detected.'}</p>
            )}
            <p className="text-[10px] leading-5 text-[var(--vl-text-dim)]">
              {syncNetReport.offset_semantics || 'Offsets follow SyncNet’s signed frame convention at 25 fps.'}
              {' '}This report does not trim or change the source video. Source SHA-256: <span className="break-all font-mono">{syncNetReport.source_sha256}</span>
            </p>
            <button type="button" onClick={handleRecordSyncNetFinding} className="vl-btn-secondary text-xs">
              <Clock3 className="h-3.5 w-3.5" /> {syncNetSaved ? 'Offset finding recorded' : 'Record offset finding'}
            </button>
          </div>
        )}
      </section>

      {report && normalizedSignals && (
        <section className="vl-surface space-y-4 p-4 sm:p-5">
          <div>
            <h2 className="text-sm font-semibold">Speech and mouth movement timeline</h2>
            <p className="mt-1 text-xs text-[var(--vl-text-dim)]">Select a sample to seek the video. Bars show Silero speech probability and normalized mouth aperture.</p>
          </div>
          <div className="overflow-x-auto pb-1">
            <div className="flex h-16 min-w-full items-end gap-px" style={{ minWidth: `${report.samples.length * 4}px` }}>
              {report.samples.map((sample, index) => (
                <button
                  key={`${sample.timeSec}-${index}`}
                  type="button"
                  className="flex h-full flex-1 flex-col items-center justify-end gap-1 rounded-sm px-px hover:bg-[var(--vl-surface-elevated)] focus-visible:z-10"
                  onClick={() => {
                    if (videoRef.current) {
                      videoRef.current.currentTime = sample.timeSec;
                      setCurrentTime(sample.timeSec);
                    }
                  }}
                  aria-label={`Seek to ${sample.timeSec.toFixed(1)} seconds`}
                  title={`${sample.timeSec.toFixed(1)}s`}
                >
                  <span className="w-full rounded-t-sm bg-sky-300/85" style={{ height: `${Math.max(2, normalizedSignals.speech[index] * 25)}px` }} />
                  <span className={`w-full rounded-t-sm ${normalizedSignals.mouth[index] === null ? 'bg-slate-600/50' : 'bg-cyan-300/85'}`} style={{ height: `${normalizedSignals.mouth[index] === null ? 2 : Math.max(2, normalizedSignals.mouth[index] * 25)}px` }} />
                </button>
              ))}
            </div>
          </div>
          <div className="flex justify-between font-mono text-[10px] text-[var(--vl-text-dim)]">
            <span>0.0s</span><span>{report.analyzedDurationSec.toFixed(1)}s</span>
          </div>
          <div className="flex flex-wrap gap-4 border-t border-[var(--vl-border)] pt-3 text-[10px] text-[var(--vl-text-secondary)]">
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-sky-300" />Speech probability</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-cyan-300" />Mouth aperture</span>
            <span className="font-mono text-[var(--vl-text-dim)]">Current playback: {selectedTime.toFixed(2)}s</span>
          </div>
        </section>
      )}
    </main>
  );
};
