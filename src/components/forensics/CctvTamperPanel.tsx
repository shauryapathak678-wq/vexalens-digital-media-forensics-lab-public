import { useState } from 'react';
import { Activity, AlertCircle, RefreshCw, ShieldCheck, Video } from 'lucide-react';
import {
  analyzeCctvVideo,
  CCTV_MAX_VIDEO_BYTES,
  type CctvVideoAnalysisResult,
} from '@/lib/forensics/cctvVideo';

const CCTV_SAMPLES = [
  { name: 'Clean sample', fileName: 'cctv_clean.mp4' },
  { name: 'Removed footage', fileName: 'cctv_removed.mp4' },
  { name: 'Frozen feed', fileName: 'cctv_frozen.mp4' },
  { name: 'Replayed segment', fileName: 'cctv_replay.mp4' },
  { name: 'Timestamp gap', fileName: 'cctv_gap.mp4' },
];

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resultTone(verdict: CctvVideoAnalysisResult['verdict']): string {
  if (verdict === 'High risk') return 'text-rose-300 border-rose-800/70 bg-rose-950/30';
  if (verdict === 'Needs review') return 'text-amber-300 border-amber-800/70 bg-amber-950/30';
  return 'text-emerald-300 border-emerald-800/70 bg-emerald-950/30';
}

export function CctvTamperPanel() {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<CctvVideoAnalysisResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chooseFile = (file: File | null) => {
    setVideoFile(file);
    setAnalysis(null);
    setError(null);
  };

  const loadSample = async (fileName: string) => {
    setError(null);
    try {
      const response = await fetch(`/samples/cctv/${fileName}`);
      if (!response.ok) throw new Error(`Could not load the bundled sample (HTTP ${response.status}).`);
      const blob = await response.blob();
      chooseFile(new File([blob], fileName, { type: 'video/mp4' }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load the bundled sample.');
    }
  };

  const runAnalysis = async () => {
    if (!videoFile) {
      setError('Choose a video or a bundled sample first.');
      return;
    }
    setIsAnalyzing(true);
    setAnalysis(null);
    setError(null);
    try {
      setAnalysis(await analyzeCctvVideo(videoFile));
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : 'CCTV analysis failed.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const graphWidth = 920;
  const graphHeight = 180;
  const duration = analysis?.series.duration_seconds || 1;
  const change = analysis?.series.change || [];
  const maximumChange = Math.max(...change, 1);
  const graphPoints = change
    .map((value, index) => {
      const x = change.length > 1 ? (index / (change.length - 1)) * graphWidth : graphWidth / 2;
      const y = graphHeight - 8 - (Math.sqrt(value / maximumChange) * (graphHeight - 20));
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const thresholdY = graphHeight - 8 -
    (Math.sqrt(Math.min(analysis?.series.threshold || 0, maximumChange) / maximumChange) * (graphHeight - 20));
  const timeX = (seconds: number) => Math.min(graphWidth, Math.max(0, (seconds / duration) * graphWidth));

  return (
    <section className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="rounded-xl border border-cyan-800/50 bg-cyan-950/40 p-2 text-cyan-300">
          <Activity className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-slate-100">CCTV Tamper & Activity Analysis</h2>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-400">
            Local OpenCV analysis checks frame timing, sudden cuts, freezes, replayed movement, and activity.
            It runs on a temporary copy and does not send footage to an external service.
          </p>
        </div>
      </div>

      <div className="vl-surface grid gap-5 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="space-y-3">
          <label htmlFor="cctv-video-file" className="block text-xs font-medium text-slate-300">
            Select CCTV video (AVI, M4V, MKV, MOV, MP4, or WebM; up to 128 MB)
          </label>
          <input
            id="cctv-video-file"
            type="file"
            accept="video/*,.avi,.m4v,.mkv,.mov,.mp4,.webm"
            disabled={isAnalyzing}
            onChange={(event) => chooseFile(event.target.files?.[0] || null)}
            className="block w-full text-xs text-slate-300 file:mr-3 file:rounded-lg file:border file:border-slate-700 file:bg-slate-900 file:px-3 file:py-2 file:text-xs file:text-slate-200 hover:file:border-cyan-700"
          />
          <div className="flex flex-wrap gap-2">
            {CCTV_SAMPLES.map((sample) => (
              <button
                key={sample.fileName}
                type="button"
                onClick={() => void loadSample(sample.fileName)}
                disabled={isAnalyzing}
                className="rounded-md border border-slate-700 bg-slate-900/80 px-2.5 py-1.5 text-[11px] text-slate-300 hover:border-cyan-700 hover:text-cyan-200 disabled:opacity-50"
              >
                {sample.name}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-slate-500">
            Bundled synthetic clips demonstrate common signals; they contain no real camera footage.
            {videoFile && ` Selected: ${videoFile.name} (${formatBytes(videoFile.size)}).`}
            {videoFile && videoFile.size > CCTV_MAX_VIDEO_BYTES && ' This file exceeds the 128 MB limit.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void runAnalysis()}
          disabled={isAnalyzing || !videoFile || videoFile.size > CCTV_MAX_VIDEO_BYTES}
          className="vl-btn-primary inline-flex items-center justify-center gap-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isAnalyzing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Video className="h-4 w-4" />}
          {isAnalyzing ? 'Analyzing locally…' : 'Analyze CCTV video'}
        </button>
      </div>

      {isAnalyzing && (
        <div className="flex items-center gap-2 rounded-lg border border-cyan-900/60 bg-cyan-950/25 p-3 text-xs text-cyan-200">
          <RefreshCw className="h-4 w-4 animate-spin" />
          Inspecting frames locally. Analysis is limited to 15 seconds; long recordings may return a partial result.
        </div>
      )}

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-900/70 bg-rose-950/30 p-3 text-xs text-rose-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {analysis && (
        <div className="space-y-4">
          <div className={`rounded-xl border p-4 ${resultTone(analysis.verdict)}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest opacity-75">Indicator-based result</p>
                <h3 className="mt-1 text-xl font-bold">{analysis.verdict}</h3>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold tabular-nums">{analysis.risk_score}<span className="text-sm opacity-70"> / 100</span></p>
                <p className="text-[10px] uppercase tracking-wider opacity-70">heuristic risk score</p>
              </div>
            </div>
            <p className="mt-3 text-xs leading-relaxed opacity-90">
              Indicators are not proof. Compression, camera faults, scene changes, or quiet edits can produce false positives or missed findings.
            </p>
          </div>

          <div className="vl-surface space-y-3 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-200">
              <Activity className="h-4 w-4 text-cyan-400" />
              Frame-change timeline
            </div>
            <svg
              viewBox={`0 0 ${graphWidth} ${graphHeight}`}
              role="img"
              aria-label="Video frame-change timeline with timing gaps, movement, freezes, replays, and cut indicators"
              className="h-36 w-full rounded-lg border border-slate-800 bg-slate-950"
              preserveAspectRatio="none"
            >
              {analysis.activity_events.map((event, index) => (
                <rect key={`activity-${index}`} x={timeX(event.start)} y="0" width={Math.max(2, timeX(event.end) - timeX(event.start))} height={graphHeight} fill="rgba(56,189,248,.18)" />
              ))}
              {analysis.frozen_frames.map((segment, index) => (
                <rect key={`frozen-${index}`} x={timeX(segment.start)} y="0" width={Math.max(2, timeX(segment.end) - timeX(segment.start))} height={graphHeight} fill="rgba(251,146,60,.32)" />
              ))}
              {analysis.replayed_segments.flatMap((segment, index) => [
                <rect key={`replay-original-${index}`} x={timeX(segment.original_start)} y="0" width={Math.max(2, timeX(segment.original_start + segment.length_seconds) - timeX(segment.original_start))} height={graphHeight} fill="rgba(192,132,252,.28)" />,
                <rect key={`replay-copy-${index}`} x={timeX(segment.repeated_start)} y="0" width={Math.max(2, timeX(segment.repeated_start + segment.length_seconds) - timeX(segment.repeated_start))} height={graphHeight} fill="rgba(192,132,252,.28)" />,
              ])}
              {analysis.timing_gaps.map((gap, index) => (
                <line key={`gap-${index}`} x1={timeX(gap.at)} x2={timeX(gap.at)} y1="0" y2={graphHeight} stroke="#f87171" strokeWidth="2" />
              ))}
              {analysis.discontinuities.map((cut, index) => (
                <line key={`cut-${index}`} x1={timeX(cut.at)} x2={timeX(cut.at)} y1="0" y2={graphHeight} stroke="#fb7185" strokeWidth="2" />
              ))}
              <line x1="0" x2={graphWidth} y1={thresholdY} y2={thresholdY} stroke="#64748b" strokeDasharray="5 5" />
              <polyline points={graphPoints} fill="none" stroke="#e2e8f0" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            </svg>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-400">
              <span className="text-cyan-300">Blue: movement</span>
              <span className="text-rose-300">Red: gap or sudden cut</span>
              <span className="text-orange-300">Orange: frozen segment</span>
              <span className="text-purple-300">Purple: repeated segment</span>
              <span>Line: frame change</span>
            </div>
            <p className="text-[11px] text-slate-500">
              {analysis.file.frames_analyzed.toLocaleString()} frames · {analysis.file.fps} fps · {analysis.file.resolution} · {analysis.file.duration_seconds}s · timestamps: {analysis.file.timestamp_source}
              {analysis.file.truncated ? ' · partial result (processing or frame limit reached)' : ''}
            </p>
          </div>

          <div className="vl-surface space-y-3 p-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-200">Why this result was returned</h4>
            <ul className="list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-slate-300">
              {analysis.reasons.map((reason, index) => <li key={index}>{reason}</li>)}
            </ul>
            <div className="grid gap-3 border-t border-slate-800 pt-3 sm:grid-cols-2">
              <div className="text-[11px] text-slate-400">
                <p className="mb-1 font-semibold text-slate-300">Activity events</p>
                {analysis.activity_events.length > 0
                  ? analysis.activity_events.map((event, index) => <p key={index}>{event.start_label}–{event.end_label}</p>)
                  : <p>No movement events found.</p>}
              </div>
              <div className="text-[11px] text-slate-400">
                <p className="mb-1 font-semibold text-slate-300">Detected categories</p>
                <p>Timing gaps: {analysis.timing_gaps.length} · Cuts: {analysis.discontinuities.length}</p>
                <p>Frozen sections: {analysis.frozen_frames.length} · Replayed segments: {analysis.replayed_segments.length}</p>
              </div>
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-emerald-900/50 bg-emerald-950/20 p-3 text-[11px] text-emerald-200">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <p className="font-semibold">Temporary-copy and SHA-256 check passed</p>
              <p className="mt-1 break-all font-mono text-emerald-300/80">
                Source: {analysis.custody.source_sha256}
              </p>
              <p className="break-all font-mono text-emerald-300/80">
                Analysis copy: {analysis.custody.analysis_sha256}
              </p>
              <p className="mt-1">The uploaded bytes matched the analysis copy before and after processing.</p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
