import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Download, Pause, Play, RotateCcw, Volume2 } from 'lucide-react';
import { calculateSHA256, verifyHashesMatch } from '@/lib/forensics/crypto';
import {
  analyzeSyncNetOffset,
  SyncNetAnalysisResult,
  SyncNetStatus,
} from '@/lib/forensics/syncNetClient';

const SAMPLE_VIDEO_URL = '/demo/audio-video-sync-sample.mp4';
const SAMPLE_VIDEO_FILENAME = 'audio-video-sync-sample.mp4';
const SAMPLE_VIDEO_DURATION_SECONDS = 20.015782;
const SAMPLE_VIDEO_FPS = 30;
const DELAY_PRESETS = [100, 300, 500, 1000];

type PlayerName = 'synchronized' | 'delayed';

interface LoadedSample {
  blob: Blob;
  sha256: string;
  url: string;
}

interface AudioGraph {
  synchronizedSource: MediaElementAudioSourceNode;
  delayedSource: MediaElementAudioSourceNode;
  delay: DelayNode;
  delayedGain: GainNode;
}

interface AudioVideoSyncDemoProps {
  syncNetStatus: SyncNetStatus | null;
  syncNetStatusError: string;
  syncNetStatusLoading: boolean;
  onRetrySyncNet: () => void;
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.max(0, seconds % 60);
  return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(1).padStart(4, '0')}`;
}

function Waveform({
  values,
  videoTime,
  audioTime,
  duration,
}: {
  values: number[];
  videoTime: number;
  audioTime: number;
  duration: number;
}) {
  const videoPosition = duration > 0 ? Math.min(100, Math.max(0, videoTime / duration * 100)) : 0;
  const audioPosition = duration > 0 ? Math.min(100, Math.max(0, audioTime / duration * 100)) : 0;

  return (
    <div
      role="img"
      aria-label="Audio waveform with video and audio playback positions"
      className="relative flex h-14 items-center gap-px overflow-hidden rounded-lg border border-[var(--vl-border)] bg-slate-950/60 px-2"
    >
      {values.map((value, index) => (
        <span
          key={index}
          className="min-w-px flex-1 rounded-full bg-sky-300/75"
          style={{ height: `${Math.max(3, value * 44)}px` }}
        />
      ))}
      <span
        className="pointer-events-none absolute inset-y-0 w-px bg-cyan-100 shadow-[0_0_6px_rgba(165,243,252,.9)]"
        style={{ left: `${videoPosition}%` }}
        title="Video position"
      />
      <span
        className="pointer-events-none absolute inset-y-0 w-0.5 bg-amber-300 shadow-[0_0_6px_rgba(252,211,77,.9)]"
        style={{ left: `${audioPosition}%` }}
        title="Audio position"
      />
    </div>
  );
}

export const AudioVideoSyncDemo: React.FC<AudioVideoSyncDemoProps> = ({
  syncNetStatus,
  syncNetStatusError,
  syncNetStatusLoading,
  onRetrySyncNet,
}) => {
  const synchronizedVideoRef = useRef<HTMLVideoElement>(null);
  const delayedVideoRef = useRef<HTMLVideoElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioGraphRef = useRef<AudioGraph | null>(null);
  const [sample, setSample] = useState<LoadedSample | null>(null);
  const [waveform, setWaveform] = useState<number[]>([]);
  const [assetError, setAssetError] = useState('');
  const [playbackError, setPlaybackError] = useState('');
  const [delayMs, setDelayMs] = useState(500);
  const [duration, setDuration] = useState(0);
  const [positions, setPositions] = useState({ synchronized: 0, delayed: 0 });
  const [playing, setPlaying] = useState({ synchronized: false, delayed: false });
  const [analysis, setAnalysis] = useState<{
    result: SyncNetAnalysisResult;
    timestamp: string;
    requestedAt: string;
  } | null>(null);
  const [analysisError, setAnalysisError] = useState('');
  const [analysisTimestamp, setAnalysisTimestamp] = useState('');
  const [analysisRequestedAt, setAnalysisRequestedAt] = useState('');
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisElapsedSeconds, setAnalysisElapsedSeconds] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = '';

    const loadSample = async () => {
      try {
        const response = await fetch(SAMPLE_VIDEO_URL);
        if (!response.ok) {
          throw new Error(`The bundled demo video could not be loaded (HTTP ${response.status}).`);
        }
        const blob = await response.blob();
        if (!blob.size) throw new Error('The bundled demo video is empty.');
        const buffer = await blob.arrayBuffer();
        const [sha256, waveformResponse] = await Promise.all([
          calculateSHA256(buffer),
          fetch('/demo/audio-video-sync-waveform.json'),
        ]);
        if (!waveformResponse.ok) {
          throw new Error(`The sample waveform could not be loaded (HTTP ${waveformResponse.status}).`);
        }
        const waveformPayload: unknown = await waveformResponse.json();
        if (!waveformPayload || typeof waveformPayload !== 'object' || Array.isArray(waveformPayload)) {
          throw new Error('The sample waveform file is invalid.');
        }
        const waveformRecord = waveformPayload as Record<string, unknown>;
        if (waveformRecord.source !== SAMPLE_VIDEO_FILENAME || !Array.isArray(waveformRecord.bars) || waveformRecord.bars.length !== 120) {
          throw new Error('The sample waveform does not match the bundled video.');
        }
        const waveformValues: number[] = [];
        for (const value of waveformRecord.bars) {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
            throw new Error('The sample waveform contains invalid measurements.');
          }
          waveformValues.push(value);
        }
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSample({ blob, sha256, url: objectUrl });
        setWaveform(waveformValues);
        setAssetError('');
      } catch (error) {
        if (!cancelled) {
          setAssetError(error instanceof Error ? error.message : 'The bundled demo video could not be prepared.');
        }
      }
    };

    void loadSample();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      audioGraphRef.current?.synchronizedSource.disconnect();
      audioGraphRef.current?.delayedSource.disconnect();
      audioGraphRef.current?.delay.disconnect();
      audioGraphRef.current?.delayedGain.disconnect();
      audioGraphRef.current = null;
      const context = audioContextRef.current;
      if (context) {
        audioContextRef.current = null;
        void context.close();
      }
    };
  }, []);

  useEffect(() => {
    const context = audioContextRef.current;
    const delay = audioGraphRef.current?.delay;
    if (context && delay) {
      delay.delayTime.setTargetAtTime(delayMs / 1000, context.currentTime, 0.015);
    }
  }, [delayMs]);

  useEffect(() => {
    if (!analysisBusy) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setAnalysisElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [analysisBusy]);

  const ensureAudioGraph = async (): Promise<AudioGraph> => {
    if (typeof window.AudioContext === 'undefined') {
      throw new Error('This browser does not support Web Audio, which is required for the delay demonstration.');
    }
    let context = audioContextRef.current;
    if (!context) {
      context = new window.AudioContext();
      audioContextRef.current = context;
    }
    const synchronizedVideo = synchronizedVideoRef.current;
    const delayedVideo = delayedVideoRef.current;
    if (!context || !synchronizedVideo || !delayedVideo) {
      throw new Error('The demo audio players are not ready yet.');
    }
    if (!audioGraphRef.current) {
      const synchronizedSource = context.createMediaElementSource(synchronizedVideo);
      const delayedSource = context.createMediaElementSource(delayedVideo);
      const delay = context.createDelay(1.05);
      const delayedGain = context.createGain();
      delay.delayTime.value = delayMs / 1000;
      synchronizedSource.connect(context.destination);
      delayedSource.connect(delay);
      delay.connect(delayedGain);
      delayedGain.connect(context.destination);
      audioGraphRef.current = { synchronizedSource, delayedSource, delay, delayedGain };
    }
    await context.resume();
    const graph = audioGraphRef.current;
    if (!graph) throw new Error('The demo audio graph could not be initialized.');
    return graph;
  };

  const muteAndFlushDelayedAudio = () => {
    const context = audioContextRef.current;
    const graph = audioGraphRef.current;
    if (!context || !graph) return;
    graph.delayedGain.gain.setValueAtTime(0, context.currentTime);
    graph.delayedSource.disconnect(graph.delay);
    graph.delay.disconnect(graph.delayedGain);
    const delay = context.createDelay(1.05);
    delay.delayTime.value = delayMs / 1000;
    graph.delayedSource.connect(delay);
    delay.connect(graph.delayedGain);
    graph.delay = delay;
  };

  const play = async (player: PlayerName) => {
    const video = player === 'synchronized' ? synchronizedVideoRef.current : delayedVideoRef.current;
    if (!video || !sample) return;
    setPlaybackError('');
    try {
      const graph = await ensureAudioGraph();
      if (player === 'delayed') {
        const context = audioContextRef.current;
        if (context) graph.delayedGain.gain.setTargetAtTime(1, context.currentTime, 0.005);
      }
      await video.play();
      setPlaying((current) => ({ ...current, [player]: true }));
    } catch (error) {
      setPlaybackError(error instanceof Error ? error.message : 'Playback could not be started.');
    }
  };

  const pause = (player: PlayerName) => {
    const video = player === 'synchronized' ? synchronizedVideoRef.current : delayedVideoRef.current;
    video?.pause();
    if (player === 'delayed') muteAndFlushDelayedAudio();
    setPlaying((current) => ({ ...current, [player]: false }));
  };

  const playBoth = async () => {
    const synchronizedVideo = synchronizedVideoRef.current;
    const delayedVideo = delayedVideoRef.current;
    if (!sample || !synchronizedVideo || !delayedVideo) return;
    setPlaybackError('');
    try {
      const graph = await ensureAudioGraph();
      synchronizedVideo.pause();
      delayedVideo.pause();
      muteAndFlushDelayedAudio();
      synchronizedVideo.currentTime = 0;
      delayedVideo.currentTime = 0;
      const context = audioContextRef.current;
      if (context) graph.delayedGain.gain.setTargetAtTime(1, context.currentTime, 0.005);
      await Promise.all([synchronizedVideo.play(), delayedVideo.play()]);
      setPlaying({ synchronized: true, delayed: true });
    } catch (error) {
      synchronizedVideo.pause();
      delayedVideo.pause();
      muteAndFlushDelayedAudio();
      setPlaying({ synchronized: false, delayed: false });
      setPlaybackError(error instanceof Error ? error.message : 'Both demonstrations could not be started.');
    }
  };

  const restartBoth = () => {
    synchronizedVideoRef.current?.pause();
    delayedVideoRef.current?.pause();
    muteAndFlushDelayedAudio();
    if (synchronizedVideoRef.current) synchronizedVideoRef.current.currentTime = 0;
    if (delayedVideoRef.current) delayedVideoRef.current.currentTime = 0;
    if (audioGraphRef.current && audioContextRef.current) {
      audioGraphRef.current.delayedGain.gain.setTargetAtTime(1, audioContextRef.current.currentTime, 0.005);
    }
    setPositions({ synchronized: 0, delayed: 0 });
    setPlaying({ synchronized: false, delayed: false });
    setPlaybackError('');
  };

  const seek = (player: PlayerName, time: number) => {
    const video = player === 'synchronized' ? synchronizedVideoRef.current : delayedVideoRef.current;
    if (video) video.currentTime = time;
    setPositions((current) => ({ ...current, [player]: time }));
  };

  const runSyncNetAnalysis = async () => {
    if (!sample || !syncNetStatus?.configured) return;
    setAnalysisElapsedSeconds(0);
    setAnalysisBusy(true);
    setAnalysisError('');
    setAnalysisTimestamp('');
    const requestedAt = new Date().toISOString();
    setAnalysisRequestedAt(requestedAt);
    setAnalysis(null);
    try {
      const result = await analyzeSyncNetOffset(sample.blob, '.mp4', sample.sha256);
      if (!verifyHashesMatch(result.source_sha256, sample.sha256)) {
        throw new Error('SyncNet returned a different source SHA-256; the analysis result was not accepted.');
      }
      const timestamp = new Date().toISOString();
      setAnalysis({ result, timestamp, requestedAt });
      setAnalysisTimestamp(timestamp);
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : 'SyncNet analysis failed.');
      setAnalysisTimestamp(new Date().toISOString());
    } finally {
      setAnalysisBusy(false);
    }
  };

  const downloadReport = () => {
    if (!sample) return;
    const syncNetAvailable = syncNetStatus?.configured === true;
    const report = {
      reportGeneratedAt: new Date().toISOString(),
      sourceVideo: {
        filename: SAMPLE_VIDEO_FILENAME,
        sha256: sample.sha256,
        hashScope: 'Exact bundled 20-second demo file; the file is unchanged during playback and analysis.',
        durationSeconds: duration || SAMPLE_VIDEO_DURATION_SECONDS,
        framesPerSecond: SAMPLE_VIDEO_FPS,
        resolution: '480x270',
      },
      actualForensicAnalysis: {
        engine: 'SyncNet',
        engineVersion: analysis?.result.model_version ?? null,
        status: analysisBusy ? 'running' : analysis ? 'completed' : analysisError ? 'failed' : syncNetAvailable ? 'not_run' : 'unavailable',
        requestedAt: analysisRequestedAt || null,
        timestamp: analysis?.timestamp ?? (analysisTimestamp || null),
        settings: {
          fileExtension: '.mp4',
          sourceSha256: sample.sha256,
          requestedAnalysisWindowSeconds: syncNetStatus?.analysis_window_seconds ?? null,
          faceDetectionScale: analysis?.result.face_detection_scale ?? null,
          minimumFaceSizePixels: analysis?.result.min_face_size_pixels ?? null,
          sourceModified: false,
        },
        pipelineFramesPerSecond: analysis?.result.frame_rate ?? null,
        sourceSha256: analysis?.result.source_sha256 ?? null,
        analyzedSegment: analysis ? {
          startSeconds: analysis.result.analysis_segment_start_seconds,
          endSeconds: analysis.result.analysis_segment_end_seconds,
          durationSeconds: analysis.result.analysis_segment_duration_seconds,
        } : null,
        tracks: analysis?.result.tracks.map((track) => ({
          trackIndex: track.track_index,
          signedOffsetFrames: track.offset_frames,
          signedTimingDifferenceMilliseconds: track.offset_seconds * 1000,
          confidenceMeasure: track.confidence_score,
        })) ?? null,
        message: analysis?.result.message ?? (analysisBusy ? 'Analysis is in progress.' : analysisError || syncNetStatusError || null),
        assessment: analysisBusy
          ? 'SyncNet analysis is still running; no result is reported yet.'
          : analysis?.result.tracks.length
            ? 'SyncNet returned model estimates; review the signed per-track offsets. No automatic authenticity verdict is made.'
            : analysis
              ? 'SyncNet completed without a usable face-track estimate; no synchronization conclusion is made.'
          : 'No actual SyncNet result is available; no synchronization conclusion is made about the original demo video.',
      },
      playbackSimulation: {
        type: 'Controlled playback-only simulation; not forensic evidence processing.',
        videoSource: SAMPLE_VIDEO_FILENAME,
        audioSource: 'Embedded original audio from the same unchanged demo file.',
        artificialAudioDelayMilliseconds: delayMs,
        status: delayMs > 0 ? 'SYNCHRONIZATION MISMATCH (simulated)' : 'SYNCHRONIZED (playback baseline)',
        resultType: 'Simulation only; not a SyncNet finding.',
      },
      limitations: [
        'The artificial delay is applied only in the browser playback audio graph; the bundled video file is not modified.',
        'A simulated mismatch is not proof of manipulation, a deepfake, or an actual forensic finding.',
        'SyncNet estimates apply only to the analyzed segment and detected face tracks; no result is fabricated when SyncNet is unavailable.',
        'NASA media is used for factual educational demonstration and is not endorsed by NASA. Review identifiable-person rights before commercial or promotional use.',
      ],
      sampleAttribution: 'NASA, Live Interviews with NASA Astronaut Jeanette Epps, October 4, 2019. See public/demo/ATTRIBUTION.txt.',
    };
    const reportBlob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const reportUrl = URL.createObjectURL(reportBlob);
    const link = document.createElement('a');
    link.href = reportUrl;
    link.download = 'vexalens-audio-video-sync-report.json';
    document.body.append(link);
    link.click();
    window.setTimeout(() => {
      link.remove();
      URL.revokeObjectURL(reportUrl);
    }, 1000);
  };

  const audioPosition = (player: PlayerName) => Math.max(
    0,
    positions[player] - (player === 'delayed' ? delayMs / 1000 : 0),
  );

  const videoPanel = (player: PlayerName) => {
    const isDelayed = player === 'delayed';
    const video = isDelayed ? delayedVideoRef : synchronizedVideoRef;
    const currentTime = positions[player];
    const mismatch = isDelayed && delayMs > 0;
    const title = isDelayed ? 'Artificial audio delay' : 'Original audio';
    return (
      <article className={`vl-surface min-w-0 space-y-4 p-4 sm:p-5 ${mismatch ? 'border-rose-500/30' : ''}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[.18em] text-[var(--vl-text-dim)]">
              {isDelayed ? 'Demonstration B' : 'Demonstration A'}
            </p>
            <h3 className="mt-1 text-base font-semibold">{title}</h3>
          </div>
          <span className={`rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold tracking-wide ${
            mismatch
              ? 'border-rose-400/40 bg-rose-500/10 text-rose-300'
              : 'border-emerald-400/40 bg-emerald-500/10 text-emerald-300'
          }`}>
            {mismatch ? 'SYNCHRONIZATION MISMATCH' : 'SYNCHRONIZED'}
          </span>
        </div>
        <video
          ref={video}
          src={sample?.url}
          className="aspect-video w-full rounded-xl border border-[var(--vl-border)] bg-black object-contain"
          preload="auto"
          playsInline
          onLoadedMetadata={(event) => {
            const videoDuration = event.currentTarget.duration;
            setDuration((current) => Math.max(current, Number.isFinite(videoDuration) ? videoDuration : 0));
          }}
          onTimeUpdate={(event) => {
            const time = event.currentTarget.currentTime;
            setPositions((current) => ({ ...current, [player]: time }));
          }}
          onEnded={() => {
            if (isDelayed) muteAndFlushDelayedAudio();
            setPlaying((current) => ({ ...current, [player]: false }));
          }}
          aria-label={`${title} synchronization video demonstration`}
        />
        <p className={`min-h-10 text-xs leading-5 ${mismatch ? 'text-rose-200/90' : 'text-emerald-200/90'}`}>
          {mismatch
            ? `An artificial ${delayMs} ms audio delay has been introduced for demonstration purposes.`
            : 'Audio and lip movements appear properly aligned. No significant synchronization mismatch detected.'}
        </p>
        <div className="space-y-2">
          <div className="flex items-center justify-between font-mono text-[10px] text-[var(--vl-text-dim)]">
            <span>Video timeline · {formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
          <input
            type="range"
            min="0"
            max={Math.max(duration, 0.01)}
            step="0.05"
            value={Math.min(currentTime, duration)}
            onChange={(event) => seek(player, Number(event.target.value))}
            disabled={!sample || duration <= 0}
            className="w-full accent-cyan-300"
            aria-label={`${title} video playback timeline`}
          />
        </div>
        <Waveform values={waveform} videoTime={currentTime} audioTime={audioPosition(player)} duration={duration} />
        <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-[var(--vl-text-dim)]">
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-cyan-100" />Video</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-300" />Audio {isDelayed ? `· ${delayMs} ms delay` : '· original'}</span>
          <span className="font-mono">Audio time {formatTime(audioPosition(player))}</span>
        </div>
        <button
          type="button"
          onClick={() => playing[player] ? pause(player) : void play(player)}
          disabled={!sample}
          className="vl-btn-secondary w-full justify-center text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          {playing[player] ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {playing[player] ? 'Pause' : 'Play'} {isDelayed ? 'delayed' : 'synchronized'} demonstration
        </button>
      </article>
    );
  };

  const analysisAvailability = syncNetStatusLoading
    ? 'Checking'
    : syncNetStatusError
      ? 'Unavailable'
      : syncNetStatus?.configured
        ? 'Ready'
        : syncNetStatus
          ? 'Unavailable'
          : 'Checking';

  return (
    <section className="space-y-5" aria-labelledby="sync-demo-title">
      <header className="space-y-2">
        <p className="font-mono text-[10px] uppercase tracking-[.2em] text-[var(--vl-ice-cyan)]">
          Controlled playback demonstration
        </p>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="sync-demo-title" className="text-xl font-bold tracking-tight sm:text-2xl">Audio-video synchronization comparison</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-[var(--vl-text-secondary)]">
              Both panels use the same local sample video. Only the delayed panel&apos;s playback audio is routed through an adjustable Web Audio delay; the source file remains unchanged.
            </p>
          </div>
          <button type="button" onClick={downloadReport} disabled={!sample} className="vl-btn-secondary text-xs disabled:opacity-50">
            <Download className="h-3.5 w-3.5" /> Download comparison report
          </button>
        </div>
      </header>

      {assetError && (
        <div role="alert" className="flex gap-2 rounded-xl border border-rose-500/30 bg-rose-950/25 p-4 text-xs leading-5 text-rose-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {assetError}
        </div>
      )}
      {playbackError && (
        <div role="alert" className="flex gap-2 rounded-xl border border-rose-500/30 bg-rose-950/25 p-4 text-xs leading-5 text-rose-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {playbackError}
        </div>
      )}
      {!sample && !assetError && (
        <p role="status" className="rounded-xl border border-[var(--vl-border)] bg-[var(--vl-surface-elevated)] p-4 text-xs text-[var(--vl-text-secondary)]">
          Loading and verifying the bundled sample video…
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {videoPanel('synchronized')}
        {videoPanel('delayed')}
      </div>

      <section className="vl-surface space-y-4 p-4 sm:p-5" aria-label="Demonstration playback controls">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Volume2 className="h-4 w-4 text-cyan-300" /> Comparison controls</h3>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void playBoth()} disabled={!sample} className="vl-btn-primary text-xs disabled:opacity-50">
              <Play className="h-3.5 w-3.5" /> Play both simultaneously
            </button>
            <button type="button" onClick={restartBoth} disabled={!sample} className="vl-btn-secondary text-xs disabled:opacity-50">
              <RotateCcw className="h-3.5 w-3.5" /> Restart both
            </button>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <label className="space-y-2 text-xs">
            <span className="flex items-center justify-between gap-3">
              <span className="font-semibold">Artificial audio delay</span>
              <span className="font-mono text-cyan-200">{delayMs} ms</span>
            </span>
            <input
              type="range"
              min="0"
              max="1000"
              step="10"
              value={delayMs}
              onChange={(event) => setDelayMs(Number(event.target.value))}
              className="w-full accent-cyan-300"
              aria-label="Adjust artificial audio delay in milliseconds"
            />
            <span className="flex justify-between font-mono text-[10px] text-[var(--vl-text-dim)]">
              <span>0 ms · aligned</span><span>1000 ms</span>
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            {DELAY_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setDelayMs(preset)}
                aria-pressed={delayMs === preset}
                className={`rounded-lg border px-3 py-2 font-mono text-[10px] ${
                  delayMs === preset
                    ? 'border-cyan-300/50 bg-cyan-300/10 text-cyan-100'
                    : 'border-[var(--vl-border)] text-[var(--vl-text-secondary)] hover:bg-[var(--vl-surface-elevated)]'
                }`}
              >
                {preset} ms
              </button>
            ))}
            <button type="button" onClick={() => setDelayMs(0)} className="vl-btn-secondary text-[10px]">
              Reset audio delay
            </button>
          </div>
        </div>
      </section>

      <section className="vl-surface space-y-4 p-4 sm:p-5" aria-labelledby="sync-comparison-title">
        <div>
          <h3 id="sync-comparison-title" className="text-sm font-semibold">Demonstration comparison</h3>
          <p className="mt-1 text-[11px] leading-5 text-[var(--vl-text-dim)]">
            Playback status is a controlled simulation. It is separate from the actual SyncNet analysis below.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wide text-[var(--vl-text-dim)]">
              <tr>
                <th className="py-2 pr-4">Parameter</th>
                <th className="py-2 pr-4">Original playback</th>
                <th className="py-2">Delayed playback</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['Source video', SAMPLE_VIDEO_FILENAME, SAMPLE_VIDEO_FILENAME],
                ['Audio track', 'Embedded original audio', 'Same audio, delayed in playback only'],
                ['Audio delay', '0 ms', `${delayMs} ms`],
                ['Lip-sync status', 'SYNCHRONIZED · demo baseline', delayMs > 0 ? 'SYNCHRONIZATION MISMATCH · simulated' : 'SYNCHRONIZED · 0 ms'],
                ['Result type', 'Playback demonstration', 'Playback simulation; not forensic analysis'],
              ].map(([parameter, baseline, simulated]) => (
                <tr key={parameter} className="border-t border-[var(--vl-border)]">
                  <th scope="row" className="py-2.5 pr-4 font-medium text-[var(--vl-text-secondary)]">{parameter}</th>
                  <td className="py-2.5 pr-4">{baseline}</td>
                  <td className="py-2.5">{simulated}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="break-all text-[10px] leading-5 text-[var(--vl-text-dim)]">
          Bundled sample SHA-256: <span className="font-mono">{sample?.sha256 ?? 'Calculating…'}</span>
        </p>
      </section>

      <section className="vl-surface space-y-4 p-4 sm:p-5" aria-labelledby="actual-syncnet-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[.18em] text-[var(--vl-ice-cyan)]">Actual forensic analysis</p>
            <h3 id="actual-syncnet-title" className="mt-1 text-base font-semibold">SyncNet analysis of the original demo video</h3>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-[var(--vl-text-secondary)]">
              This runs the configured local SyncNet model on the unchanged bundled clip. The introduced playback delay is not submitted to or represented as a SyncNet finding.
            </p>
          </div>
          <span className={`rounded-full border px-2.5 py-1 font-mono text-[10px] ${
            analysisAvailability === 'Ready'
              ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-300'
              : 'border-amber-400/40 bg-amber-500/10 text-amber-200'
          }`}>
            {analysisAvailability}
          </span>
        </div>

        {syncNetStatusLoading && (
          <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 text-xs leading-5 text-amber-100">
            {syncNetStatusError || 'Checking local SyncNet readiness…'}
          </p>
        )}
        {syncNetStatusError && !syncNetStatusLoading && (
          <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-950/20 p-3">
            <p className="text-xs leading-5 text-amber-100">SyncNet is unavailable: {syncNetStatusError}</p>
            <button type="button" onClick={onRetrySyncNet} className="vl-btn-secondary text-xs">
              <RotateCcw className="h-3.5 w-3.5" /> Retry readiness check
            </button>
          </div>
        )}
        {syncNetStatus && !syncNetStatus.configured && (
          <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 text-xs leading-5 text-amber-100">
            SyncNet is unavailable because the local backend is missing required files, dependencies, or tools. No analysis result will be fabricated.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void runSyncNetAnalysis()}
            disabled={!sample || !syncNetStatus?.configured || analysisBusy}
            className="vl-btn-primary text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            {analysisBusy ? 'Running actual SyncNet analysis…' : 'Run SyncNet analysis'}
          </button>
          <span className="text-[10px] text-[var(--vl-text-dim)]">
            Engine: SyncNet · Source video: {SAMPLE_VIDEO_FPS} fps · Actual processing FPS is reported by the model
          </span>
        </div>
        {analysisBusy && (
          <p role="status" className="text-xs text-[var(--vl-text-secondary)]">
            The local SyncNet service is analyzing the original clip. Runtime depends on your system and model
            configuration; elapsed time: {Math.floor(analysisElapsedSeconds / 60)}m {analysisElapsedSeconds % 60}s.
          </p>
        )}
        {analysisError && (
          <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/25 p-3 text-xs leading-5 text-rose-200">
            SyncNet analysis failed: {analysisError}
          </p>
        )}
        {analysis && (
          <div className="space-y-3 rounded-xl border border-[var(--vl-border)] bg-[var(--vl-surface-elevated)] p-4">
            <dl className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
              <div><dt className="text-[var(--vl-text-dim)]">Engine / version</dt><dd className="mt-1 font-mono">{analysis.result.model} {analysis.result.model_version}</dd></div>
              <div><dt className="text-[var(--vl-text-dim)]">Video FPS</dt><dd className="mt-1 font-mono">{SAMPLE_VIDEO_FPS} source · {analysis.result.frame_rate} SyncNet pipeline</dd></div>
              <div><dt className="text-[var(--vl-text-dim)]">Analysis status</dt><dd className="mt-1 font-mono">{analysis.result.tracks.length ? 'Completed' : 'Completed · no face tracks'}</dd></div>
              <div><dt className="text-[var(--vl-text-dim)]">Analysis time</dt><dd className="mt-1 break-all font-mono">{analysis.timestamp}</dd></div>
              <div><dt className="text-[var(--vl-text-dim)]">Analyzed segment</dt><dd className="mt-1 font-mono">{analysis.result.analysis_segment_start_seconds.toFixed(2)}–{analysis.result.analysis_segment_end_seconds.toFixed(2)}s</dd></div>
              <div><dt className="text-[var(--vl-text-dim)]">Face-track filter</dt><dd className="mt-1 font-mono">{analysis.result.min_face_size_pixels === undefined ? 'Not reported' : `>${analysis.result.min_face_size_pixels}px · scale ${analysis.result.face_detection_scale ?? '—'}`}</dd></div>
              <div><dt className="text-[var(--vl-text-dim)]">Result source SHA-256</dt><dd className="mt-1 break-all font-mono">{analysis.result.source_sha256}</dd></div>
            </dl>
            {analysis.result.tracks.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[470px] text-left text-xs">
                  <thead className="text-[10px] uppercase text-[var(--vl-text-dim)]">
                    <tr><th className="py-2 pr-3">Face track</th><th className="py-2 pr-3">Signed frame offset</th><th className="py-2">Timing difference</th></tr>
                  </thead>
                  <tbody>
                    {analysis.result.tracks.map((track) => (
                      <tr key={track.track_index} className="border-t border-[var(--vl-border)]">
                        <td className="py-2 pr-3">{track.track_index + 1}</td>
                        <td className="py-2 pr-3 font-mono">{track.offset_frames > 0 ? '+' : ''}{track.offset_frames}</td>
                        <td className="py-2 font-mono">{track.offset_seconds > 0 ? '+' : ''}{(track.offset_seconds * 1000).toFixed(2)} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-amber-200">{analysis.result.message || 'SyncNet completed but returned no usable face-track estimate.'}</p>
            )}
            <p className="text-[10px] leading-5 text-[var(--vl-text-dim)]">
              Offsets are actual SyncNet estimates and follow its signed offset convention. Estimates are not proof of editing or inauthenticity.
              {analysis.result.min_face_size_pixels !== undefined && ` Face tracks with average size at or below ${analysis.result.min_face_size_pixels}px are excluded.`}
            </p>
          </div>
        )}
      </section>

      <p className="text-[10px] leading-5 text-[var(--vl-text-dim)]">
        The playback delay is a controlled simulation, not proof of manipulation or deepfake detection. The sample is NASA material used for a factual educational demonstration; NASA does not endorse VexaLens.{' '}
        <a href="/demo/ATTRIBUTION.txt" target="_blank" rel="noreferrer" className="underline underline-offset-2">
          See the sample attribution and usage guidance.
        </a>
      </p>
    </section>
  );
};
