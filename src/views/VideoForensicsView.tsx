import React, { useState, useRef, useEffect } from 'react';
import { EvidenceItem, AnalysisFinding } from '@/types/forensics';
import { extractVideoKeyframes, ExtractedFrame, VideoForensicAnalysis } from '@/lib/forensics/video';
import { formatShortHash } from '@/lib/forensics/crypto';
import { CctvTamperPanel } from '@/components/forensics/CctvTamperPanel';
import { VideoMutationTreePanel } from '@/components/forensics/VideoMutationTreePanel';
import {
  AlertCircle,
  Video,
  Play,
  Pause,
  Layers,
  Clock,
  Sparkles,
  ArrowRight,
  HardDrive,
  Copy,
  Check,
  RotateCcw,
  SkipBack,
  SkipForward,
  Maximize2,
  Film,
  ShieldCheck,
  Hash,
  Sliders,
  CheckCircle2,
  RefreshCw,
} from 'lucide-react';

interface VideoForensicsViewProps {
  evidenceList: EvidenceItem[];
  selectedItem?: EvidenceItem;
  onSelectEvidence: (item: EvidenceItem) => void;
  onAddFinding: (finding: Omit<AnalysisFinding, 'id' | 'createdAt'>) => void;
  onTransferFrameToImageForensics: (frameDataUrl: string, frameTime: string) => void;
}

export const VideoForensicsView: React.FC<VideoForensicsViewProps> = ({
  evidenceList,
  selectedItem,
  onSelectEvidence,
  onAddFinding,
  onTransferFrameToImageForensics,
}) => {
  const videosOnly = evidenceList.filter((e) => e.mediaType === 'video');
  const activeItem = selectedItem?.mediaType === 'video' ? selectedItem : videosOnly[0];

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [isLooping, setIsLooping] = useState<boolean>(false);
  const [keyframeCount, setKeyframeCount] = useState<number>(6);
  const [keyframeAnalysis, setKeyframeAnalysis] = useState<VideoForensicAnalysis | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [selectedFrame, setSelectedFrame] = useState<ExtractedFrame | null>(null);
  const [compareFrame, setCompareFrame] = useState<ExtractedFrame | null>(null);
  const [videoLoadError, setVideoLoadError] = useState<string | null>(null);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [findingSuccess, setFindingSuccess] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    setVideoLoadError(null);
    setCompareFrame(null);
  }, [activeItem?.id]);

  // Extract keyframes when active item changes or density changes
  useEffect(() => {
    if (!activeItem || !activeItem.previewUrl) return;

    let isMounted = true;
    setIsExtracting(true);

    extractVideoKeyframes(activeItem.previewUrl, keyframeCount)
      .then((res) => {
        if (isMounted) {
          setKeyframeAnalysis(res);
          if (res.frames.length > 0) {
            setSelectedFrame(res.frames[0]);
          }
        }
      })
      .catch((err) => {
        console.warn('Keyframe extraction warning:', err);
      })
      .finally(() => {
        if (isMounted) setIsExtracting(false);
      });

    return () => {
      isMounted = false;
    };
  }, [activeItem?.id, activeItem?.previewUrl, keyframeCount]);

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
      setIsPlaying(false);
    } else {
      videoRef.current.play();
      setIsPlaying(true);
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
      setDuration(videoRef.current.duration || 0);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    setCurrentTime(time);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
  };

  const stepFrame = (frames: number) => {
    if (!videoRef.current) return;
    videoRef.current.pause();
    setIsPlaying(false);
    const frameDuration = 1 / 30; // Approx 30fps
    const newTime = Math.max(0, Math.min(duration, videoRef.current.currentTime + frames * frameDuration));
    videoRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const handlePlaybackRateChange = (rate: number) => {
    setPlaybackRate(rate);
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedHash(id);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  const handleRecordFrameFinding = () => {
    if (!activeItem || !selectedFrame) return;

    onAddFinding({
      investigationId: activeItem.investigationId,
      evidenceId: activeItem.id,
      title: `Keyframe Hash Register & Temporal Integrity at ${selectedFrame.formattedTime}`,
      severity: 'nominal',
      category: 'provenance',
      observedEvidence: `Frame #${selectedFrame.index} at ${selectedFrame.formattedTime} extracted and hashed. Cryptographic SHA-256 digest: ${selectedFrame.sha256}. Frame resolution: ${selectedFrame.width}x${selectedFrame.height}px.`,
      plainEnglishSummary: `The selected video frame at timecode ${selectedFrame.formattedTime} has been registered with an unforgeable cryptographic hash, allowing inter-frame manipulation verification.`,
      detectionMethod: 'NIST Video Keyframe Extraction & SHA-256 Bitstream Digest',
      limitations: 'Variable framerate encoding can shift timecode alignment by up to 1 frame.',
      detectorVersion: 'VexaLens-VideoAudit-v2.1',
    });

    setFindingSuccess(`Frame #${selectedFrame.index} logged to investigation findings`);
    setTimeout(() => setFindingSuccess(null), 3000);
  };

  const formatSMPTE = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const millis = Math.floor((seconds % 1) * 100);
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs
      .toString()
      .padStart(2, '0')}.${millis.toString().padStart(2, '0')}`;
  };

  if (!activeItem) {
    return (
      <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
        <div className="p-8 text-center space-y-4 vl-surface">
          <div className="w-16 h-16 rounded-2xl bg-cyan-950/40 border border-cyan-800/40 flex items-center justify-center mx-auto text-cyan-400">
            <Film className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-bold text-slate-100">No Video Evidence Ingested</h2>
          <p className="text-sm text-slate-400 max-w-md mx-auto">
            Ingest MP4, WebM, or MOV streams to activate keyframe auditing, or use the local CCTV analysis section below.
          </p>
        </div>
        <CctvTamperPanel />
        <VideoMutationTreePanel />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
      {/* Precision Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800/80 pb-5">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-mono text-cyan-400">
            <span className="flex items-center gap-1.5 font-bold uppercase tracking-wider">
              <Film className="w-3.5 h-3.5 text-cyan-400" /> Video Forensics Lab
            </span>
            <span className="text-slate-600">/</span>
            <span className="text-slate-300 font-mono">{activeItem.fileName}</span>
            <span className="text-slate-600">/</span>
            <span className="vl-badge-cyan">Bitstream Scrubbing</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">
            Temporal Video Integrity & Keyframe Cryptographic Register
          </h1>
          <p className="text-xs text-slate-400 max-w-2xl">
            Audit inter-frame consistency, extract deterministic SHA-256 keyframe digests, and route suspicious frames directly to the ELA pixel laboratory.
          </p>
        </div>

        {/* Video Selector Dropdown & Telemetry */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 bg-slate-900/80 border border-slate-800 px-3 py-1.5 rounded-lg text-xs font-mono">
            <span className="text-slate-400">Target Video:</span>
            <select
              value={activeItem.id}
              onChange={(e) => {
                const target = videosOnly.find((v) => v.id === e.target.value);
                if (target) onSelectEvidence(target);
              }}
              className="bg-transparent text-cyan-300 font-medium focus:outline-none cursor-pointer"
            >
              {videosOnly.map((v) => (
                <option key={v.id} value={v.id} className="bg-slate-900 text-slate-200">
                  {v.fileName} ({v.isOriginal ? 'Baseline' : 'Suspect'})
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Success Notification Alert */}
      {findingSuccess && (
        <div className="flex items-center gap-2.5 p-3 rounded-lg bg-emerald-950/40 border border-emerald-700/60 text-emerald-300 text-xs font-medium animate-fadeIn">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{findingSuccess}</span>
        </div>
      )}

      {/* Main Grid: Left Video Player Deck, Right Keyframe Register */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Master Video Stream Monitor (7 cols) */}
        <div className="lg:col-span-7 space-y-4">
          <div className="vl-surface p-4 space-y-4">
            {/* Monitor Header with Telemetry Badges */}
            <div className="flex items-center justify-between text-xs pb-2 border-b border-slate-800/80">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></span>
                <span className="font-mono text-slate-300 font-medium">STREAM INSPECTOR MONITOR</span>
              </div>
              <div className="flex items-center gap-2 font-mono text-[11px] text-slate-400">
                <span className="px-2 py-0.5 rounded bg-slate-800/70 border border-slate-700/50">
                  {keyframeAnalysis ? `${keyframeAnalysis.width}×${keyframeAnalysis.height}` : 'Auto-Detect'}
                </span>
                <span className="px-2 py-0.5 rounded bg-slate-800/70 border border-slate-700/50">
                  {activeItem.mimeType}
                </span>
                <span className="px-2 py-0.5 rounded bg-cyan-950/60 border border-cyan-800/50 text-cyan-300">
                  ~30 FPS
                </span>
              </div>
            </div>

            {/* Video Canvas / Viewport */}
            <div className="relative rounded-lg overflow-hidden bg-slate-950 border border-slate-800 flex items-center justify-center min-h-[320px] shadow-inner group">
              {videoLoadError ? (
                <div className="p-8 text-center space-y-3 text-slate-400">
                  <AlertCircle className="w-10 h-10 text-amber-400 mx-auto" />
                  <p className="text-sm font-semibold text-slate-200">Codec or Container Emulation Notice</p>
                  <p className="text-xs text-slate-400 max-w-md mx-auto leading-relaxed">{videoLoadError}</p>
                  <div className="pt-2">
                    <span className="font-mono text-[11px] bg-slate-900 px-3 py-1.5 rounded border border-slate-800 text-slate-400">
                      Bitstream SHA-256: {formatShortHash(activeItem.sha256Hash, 8, 8)}
                    </span>
                  </div>
                </div>
              ) : activeItem.previewUrl ? (
                <>
                  <video
                    ref={videoRef}
                    src={activeItem.previewUrl}
                    loop={isLooping}
                    onTimeUpdate={handleTimeUpdate}
                    onEnded={() => setIsPlaying(false)}
                    onError={() => {
                      setVideoLoadError(
                        'Direct in-browser playback of this container format is constrained. Extracted forensic keyframes and cryptographic digests remain fully verifiable.'
                      );
                      setIsPlaying(false);
                    }}
                    className="max-h-[380px] w-full object-contain"
                  />

                  {/* On-Screen HUD Overlay */}
                  <div className="absolute top-3 left-3 bg-slate-950/85 backdrop-blur border border-slate-800/80 px-2.5 py-1 rounded text-[11px] font-mono text-cyan-400 pointer-events-none flex items-center gap-2">
                    <Clock className="w-3 h-3 text-cyan-400" />
                    <span>{formatSMPTE(currentTime)}</span>
                  </div>

                  <div className="absolute top-3 right-3 bg-slate-950/85 backdrop-blur border border-slate-800/80 px-2 py-1 rounded text-[10px] font-mono text-slate-300 pointer-events-none">
                    RATE: {playbackRate}x
                  </div>
                </>
              ) : (
                <div className="p-8 text-center text-xs text-slate-500">
                  No video stream URL accessible.
                </div>
              )}
            </div>

            {/* Precision Scrubbing Bar */}
            <div className="space-y-2 pt-1">
              <div className="relative">
                <input
                  type="range"
                  min="0"
                  max={duration || 1}
                  step="0.001"
                  value={currentTime}
                  onChange={handleSeek}
                  className="w-full accent-cyan-400 cursor-pointer h-2 bg-slate-950 rounded-lg appearance-none"
                />
              </div>

              {/* Timecode Readouts & Controls Deck */}
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-300">
                {/* Playback & Frame Stepping */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => stepFrame(-1)}
                    title="Previous Frame (-1 frame / 33ms)"
                    className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 hover:text-cyan-400 transition-colors"
                  >
                    <SkipBack className="w-3.5 h-3.5" />
                  </button>

                  <button
                    onClick={togglePlay}
                    className="p-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold shadow-sm transition-all"
                    title={isPlaying ? 'Pause' : 'Play'}
                  >
                    {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                  </button>

                  <button
                    onClick={() => stepFrame(1)}
                    title="Next Frame (+1 frame / 33ms)"
                    className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 hover:text-cyan-400 transition-colors"
                  >
                    <SkipForward className="w-3.5 h-3.5" />
                  </button>

                  <div className="flex items-center gap-1.5 font-mono text-xs pl-2">
                    <span className="text-cyan-300 font-semibold">{formatSMPTE(currentTime)}</span>
                    <span className="text-slate-600">/</span>
                    <span className="text-slate-400">{formatSMPTE(duration)}</span>
                  </div>
                </div>

                {/* Speed & Loop Tools */}
                <div className="flex items-center gap-2">
                  <div className="flex items-center rounded-lg bg-slate-900 border border-slate-800 p-0.5 text-[11px] font-mono">
                    {[0.25, 0.5, 1, 2].map((speed) => (
                      <button
                        key={speed}
                        onClick={() => handlePlaybackRateChange(speed)}
                        className={`px-2 py-0.5 rounded transition-colors ${
                          playbackRate === speed
                            ? 'bg-cyan-500/20 text-cyan-300 font-bold'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {speed}x
                      </button>
                    ))}
                  </div>

                  <button
                    onClick={() => setIsLooping(!isLooping)}
                    className={`p-1.5 rounded-lg border text-xs transition-colors ${
                      isLooping
                        ? 'bg-cyan-950/60 border-cyan-800 text-cyan-300'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                    title={isLooping ? 'Loop Enabled' : 'Loop Disabled'}
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Stream Hash Integrity Card */}
            <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/80 flex items-center justify-between text-xs font-mono">
              <div className="flex items-center gap-2 truncate text-slate-400">
                <Hash className="w-4 h-4 text-cyan-400 shrink-0" />
                <span>Container SHA-256:</span>
                <span className="text-slate-200 truncate">{activeItem.sha256Hash}</span>
              </div>
              <button
                onClick={() => copyToClipboard(activeItem.sha256Hash, 'container')}
                className="ml-2 text-slate-400 hover:text-cyan-300 shrink-0"
                title="Copy hash"
              >
                {copiedHash === 'container' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        </div>

        {/* Right: Cryptographic Keyframe Register & Deep Inspector (5 cols) */}
        <div className="lg:col-span-5 space-y-4">
          <div className="vl-surface p-4 space-y-4 flex flex-col h-full">
            {/* Keyframe Register Controls */}
            <div className="flex items-center justify-between pb-2 border-b border-slate-800/80">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200 uppercase tracking-wider">
                <Layers className="w-4 h-4 text-cyan-400" />
                <span>Keyframe Matrix ({keyframeAnalysis?.frames.length || 0})</span>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-[11px] text-slate-400">Count:</label>
                <select
                  value={keyframeCount}
                  onChange={(e) => setKeyframeCount(parseInt(e.target.value, 10))}
                  disabled={isExtracting}
                  className="bg-slate-900 border border-slate-800 rounded px-2 py-0.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                >
                  <option value={4}>4 frames</option>
                  <option value={6}>6 frames</option>
                  <option value={8}>8 frames</option>
                  <option value={12}>12 frames</option>
                </select>
              </div>
            </div>

            {/* Keyframe Thumbnail Grid */}
            <div className="space-y-2">
              {isExtracting ? (
                <div className="py-12 text-center space-y-3">
                  <RefreshCw className="w-6 h-6 text-cyan-400 animate-spin mx-auto" />
                  <p className="text-xs text-cyan-300 font-mono">Extracting video keyframes & computing hashes…</p>
                </div>
              ) : keyframeAnalysis?.frames && keyframeAnalysis.frames.length > 0 ? (
                <div className="grid grid-cols-3 sm:grid-cols-3 gap-2.5 max-h-[260px] overflow-y-auto p-1 pr-2">
                  {keyframeAnalysis.frames.map((frame) => {
                    const isSelected = selectedFrame?.index === frame.index;
                    return (
                      <button
                        key={frame.index}
                        onClick={() => setSelectedFrame(frame)}
                        className={`relative rounded-lg border text-left overflow-hidden transition-all group ${
                          isSelected
                            ? 'border-cyan-400 ring-2 ring-cyan-500/40 shadow-lg shadow-cyan-950/40'
                            : 'border-slate-800 hover:border-slate-700 bg-slate-950/60'
                        }`}
                      >
                        <img
                          src={frame.dataUrl}
                          alt={`Frame ${frame.index}`}
                          className="w-full h-16 object-cover bg-black group-hover:scale-105 transition-transform"
                        />
                        <div className="p-1.5 bg-slate-950/95 text-[10px] space-y-0.5 border-t border-slate-800/80">
                          <div className="flex justify-between font-mono">
                            <span className="text-slate-300 font-semibold">#{frame.index}</span>
                            <span className="text-cyan-400 font-medium">{frame.formattedTime}</span>
                          </div>
                          <div className="text-slate-500 font-mono truncate text-[9px]">
                            {formatShortHash(frame.sha256, 4, 4)}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="py-10 text-center text-xs text-slate-500">
                  Keyframes could not be extracted for this stream.
                </div>
              )}
            </div>

            {/* Selected Frame Detail Deck */}
            {selectedFrame && (
              <div className="mt-auto pt-4 border-t border-slate-800/80 space-y-3 bg-slate-950/70 p-4 rounded-xl border border-slate-800">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded bg-cyan-950/60 border border-cyan-800/80 font-mono text-[11px] text-cyan-300 font-bold">
                      FRAME #{selectedFrame.index}
                    </span>
                    <span className="text-slate-300 font-medium">Timecode: {selectedFrame.formattedTime}</span>
                  </div>
                  <span className="font-mono text-slate-400 text-[11px]">
                    {selectedFrame.width}×{selectedFrame.height}px
                  </span>
                </div>

                {/* Per-Frame Hash Readout */}
                <div className="flex items-center justify-between p-2 rounded bg-slate-900 border border-slate-800 text-[11px] font-mono">
                  <div className="truncate text-slate-300">
                    <span className="text-slate-500">Frame SHA-256: </span>
                    <span className="text-cyan-300">{selectedFrame.sha256}</span>
                  </div>
                  <button
                    onClick={() => copyToClipboard(selectedFrame.sha256, `frame-${selectedFrame.index}`)}
                    className="ml-2 text-slate-400 hover:text-cyan-300 shrink-0"
                    title="Copy frame hash"
                  >
                    {copiedHash === `frame-${selectedFrame.index}` ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>

                {/* Actions: Direct Route to ELA Lab & Register Finding */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                  <button
                    onClick={() => onTransferFrameToImageForensics(selectedFrame.dataUrl, selectedFrame.formattedTime)}
                    className="vl-btn-primary w-full text-xs py-2"
                    title="Export extracted raster frame directly to ELA and EXIF forensic engine"
                  >
                    <Sparkles className="w-3.5 h-3.5 mr-1" />
                    Send to ELA Lab →
                  </button>

                  <button
                    onClick={handleRecordFrameFinding}
                    className="vl-btn-secondary w-full text-xs py-2"
                  >
                    <ShieldCheck className="w-3.5 h-3.5 mr-1 text-cyan-400" />
                    Log Hash Finding
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <CctvTamperPanel />
      <VideoMutationTreePanel />
    </div>
  );
};
