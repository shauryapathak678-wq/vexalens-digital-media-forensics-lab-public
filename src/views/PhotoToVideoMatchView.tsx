import React, { useState, useRef, useEffect } from 'react';
import { EvidenceItem, AnalysisFinding } from '@/types/forensics';
import {
  ScanFace,
  Video,
  UploadCloud,
  Play,
  Pause,
  Sliders,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  Plus,
  Trash2,
  ShieldAlert,
  Languages,
  Eye,
  RefreshCw,
  Clock,
  Sparkles,
} from 'lucide-react';
import {
  detectFaceInImage,
  matchPhotoAgainstVideoFrames,
  DetectedFaceRegion,
} from '@/lib/forensics/faceMatcher';
import { PhotoToVideoMatchResult, CandidateFaceMatch } from '@/types/forensics';

interface PhotoToVideoMatchViewProps {
  evidenceList: EvidenceItem[];
  onAddFinding: (finding: Omit<AnalysisFinding, 'id' | 'createdAt'>) => void;
}

export const PhotoToVideoMatchView: React.FC<PhotoToVideoMatchViewProps> = ({
  evidenceList,
  onAddFinding,
}) => {
  const imageEvidence = evidenceList.filter((e) => e.mediaType === 'image');
  const videoEvidence = evidenceList.filter((e) => e.mediaType === 'video');

  const [refPhotoSrc, setRefPhotoSrc] = useState<string>(() => {
    return imageEvidence[0]?.previewUrl || '/assets/evidence_sample_portrait_original_1792052939398-CHyeFPC-.jpg';
  });
  const [videoSrc, setVideoSrc] = useState<string>(() => {
    return videoEvidence[0]?.storageUrl || '';
  });

  const [refFaceRegion, setRefFaceRegion] = useState<DetectedFaceRegion | null>(null);
  const [similarityThreshold, setSimilarityThreshold] = useState(0.68);
  const [samplingInterval, setSamplingInterval] = useState(0.5); // seconds
  const [isMatching, setIsMatching] = useState(false);
  const [matchProgress, setMatchProgress] = useState(0);
  const [currentFrameNum, setCurrentFrameNum] = useState(0);
  const [matchResult, setMatchResult] = useState<PhotoToVideoMatchResult | null>(null);
  const [selectedMatch, setSelectedMatch] = useState<CandidateFaceMatch | null>(null);
  const [language, setLanguage] = useState<'en' | 'hi'>('en');
  const [savedFinding, setSavedFinding] = useState(false);
  const [biometricsPurged, setBiometricsPurged] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);

  // Detect face on reference photo changes
  useEffect(() => {
    if (refPhotoSrc) {
      detectFaceInImage(refPhotoSrc).then((face) => {
        setRefFaceRegion(face);
      });
    }
  }, [refPhotoSrc]);

  const handleRefUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        if (evt.target?.result) setRefPhotoSrc(evt.target.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleVideoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setVideoSrc(url);
    }
  };

  const runMatchingPipeline = async () => {
    if (!refPhotoSrc || !videoRef.current) return;
    setIsMatching(true);
    setMatchProgress(0);
    setSavedFinding(false);
    setBiometricsPurged(false);
    setMatchResult(null);
    setSelectedMatch(null);

    try {
      const res = await matchPhotoAgainstVideoFrames(refPhotoSrc, videoRef.current, {
        samplingIntervalSec: samplingInterval,
        similarityThreshold,
        maxFrames: 30,
        onProgress: (percent, frame) => {
          setMatchProgress(percent);
          setCurrentFrameNum(frame);
        },
      });

      setMatchResult(res);
      if (res.candidateMatches.length > 0) {
        setSelectedMatch(res.candidateMatches[0]);
      }
    } catch (err: any) {
      console.error('Photo-to-video matching error:', err);
      setMatchResult({
        referenceFaceCropUrl: '',
        videoFileName: 'Investigative_Video_Evidence',
        framesSampled: 0,
        candidateMatches: [],
        bestSimilarityScore: 0,
        thresholdApplied: similarityThreshold,
        conclusion: 'service_unavailable',
        explanation: 'Matching failed: ' + (err?.message || 'Processing fault. Check that the Python backend is running on port 8000.'),
        hindiExplanation: 'Matching fail ho gayi. Python backend port 8000 par chal raha hai ki nahin check karein.',
        consentNoticeAcknowledged: true,
        biometricRetentionDisclaimer: '',
      });
    } finally {
      setIsMatching(false);
    }
  };


  const handlePurgeBiometrics = () => {
    setMatchResult(null);
    setSelectedMatch(null);
    setRefFaceRegion(null);
    setBiometricsPurged(true);
  };

  const handleSaveFinding = () => {
    if (!matchResult) return;

    onAddFinding({
      investigationId: evidenceList[0]?.investigationId || 'inv_01',
      evidenceId: evidenceList[0]?.id || 'photo_video_match_01',
      title: `Photo-to-Video Match: ${matchResult.conclusion.replace(/_/g, ' ')}`,
      severity: matchResult.conclusion === 'potential_visual_match' ? 'high' : 'nominal',
      category: 'visual_anomaly',
      observedEvidence: `Sampled ${matchResult.framesSampled} frames. Best similarity index: ${(matchResult.bestSimilarityScore * 100).toFixed(1)}% (Threshold: ${(matchResult.thresholdApplied * 100).toFixed(0)}%).`,
      simpleExplanation: matchResult.explanation,
      hindiExplanation: matchResult.hindiExplanation,
      technicalExplanation: `16-D normalized facial geometry embedding cosine distance evaluated. Candidate matches above threshold: ${matchResult.candidateMatches.length}.`,
      whyIndicatesAI: 'Facial geometric vector visual alignment across temporal keyframe sequence.',
      methodReliability: 'Local YCbCr skin-tone segmentation, facial landmark ratio extraction, and unit vector cosine matching.',
      potentialFalsePositives: 'Lighting angle variations, video motion blur, low sensor resolution, and compression artifacts.',
      unresolvedQuestions: 'Visual similarity is not individual identification. Facial appearance alone cannot establish legal identity.',
      recommendedNextSteps: 'Corroborate with biometric government records or secondary forensic physical evidence.',
      detectionMethod: 'VexaLens Facial Feature Embedding Engine v1.9-CPU',
      detectorVersion: '1.9-CPU',
      rawDetectorScore: matchResult.bestSimilarityScore,
      scoreInterpretation: 'Cosine similarity between 0 and 1.0; similarity is not identity probability.',
    });

    setSavedFinding(true);
    setTimeout(() => setSavedFinding(false), 3500);
  };

  const conclusionColors: Record<string, string> = {
    potential_visual_match: 'text-cyan-400 bg-cyan-950/40 border-cyan-800/80',
    no_match_above_threshold: 'text-amber-400 bg-amber-950/40 border-amber-800/80',
    inconclusive: 'text-slate-400 bg-slate-900 border-slate-800',
    service_unavailable: 'text-rose-400 bg-rose-950/40 border-rose-800',
    cartoon_or_non_human: 'text-rose-400 bg-rose-950/40 border-rose-800',
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="p-2 rounded-lg bg-cyan-950/60 border border-cyan-800/60 text-cyan-400">
              <ScanFace className="w-5 h-5" />
            </span>
            <div>
              <h1 className="text-xl font-bold text-slate-100 tracking-tight">Photo-to-Video Match</h1>
              <p className="text-xs text-slate-400 mt-0.5">
                Facial landmark geometry & temporal keyframe visual alignment inspector
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
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
            onClick={runMatchingPipeline}
            disabled={isMatching || !videoSrc || !refPhotoSrc}
            className="flex items-center gap-2 px-3.5 py-1.5 bg-cyan-950/80 hover:bg-cyan-900/90 text-cyan-200 border border-cyan-800/80 rounded-lg text-xs font-medium transition-colors shadow-sm disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isMatching ? 'animate-spin text-cyan-400' : ''}`} />
            {isMatching ? `Matching Frame ${currentFrameNum}...` : 'Run Video Match'}
          </button>
        </div>
      </div>

      {/* Inputs Bar */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Reference Photograph */}
        <div className="lg:col-span-4 bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-cyan-400 uppercase tracking-wider flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-cyan-400" /> Reference Photograph
            </span>
            <label className="cursor-pointer text-[11px] text-cyan-400 hover:text-cyan-300 underline font-medium">
              Upload
              <input type="file" accept="image/*" onChange={handleRefUpload} className="hidden" />
            </label>
          </div>

          <div className="aspect-square bg-slate-900 rounded-lg overflow-hidden border border-slate-800 relative flex items-center justify-center">
            <img src={refPhotoSrc} alt="Reference" className="max-h-full max-w-full object-contain" />
            {refFaceRegion && (
              <div className="absolute bottom-2 right-2 p-1.5 bg-black/70 backdrop-blur rounded-lg border border-cyan-500/50 flex items-center gap-2">
                <img src={refFaceRegion.cropDataUrl} alt="Crop" className="w-10 h-10 rounded border border-cyan-400 object-cover" />
                <div className="text-[10px] text-cyan-300 font-mono">
                  <div>Face Detected</div>
                  <div>{(refFaceRegion.confidence * 100).toFixed(0)}% Conf</div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Video Player & Scrubbing */}
        <div className="lg:col-span-8 bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-cyan-400 uppercase tracking-wider flex items-center gap-1.5">
              <Video className="w-3.5 h-3.5 text-cyan-400" /> Investigative Video Bitstream
            </span>
            <label className="cursor-pointer text-[11px] text-cyan-400 hover:text-cyan-300 underline font-medium">
              Load Video File
              <input type="file" accept="video/*" onChange={handleVideoUpload} className="hidden" />
            </label>
          </div>

          <div className="aspect-video bg-slate-900 rounded-lg overflow-hidden border border-slate-800 relative flex items-center justify-center">
            {videoSrc ? (
              <video
                ref={videoRef}
                src={videoSrc}
                controls
                playsInline
                crossOrigin="anonymous"
                className="max-h-full max-w-full"
              />
            ) : (
              <div className="text-center p-6 text-slate-500">
                <Video className="w-10 h-10 mx-auto mb-2 opacity-40" />
                <p className="text-xs font-mono">No video evidence loaded.</p>
                <p className="text-[11px] text-slate-600 mt-1">Upload an MP4, MOV, or WebM video file to inspect.</p>
              </div>
            )}

            {isMatching && (
              <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm flex flex-col items-center justify-center gap-3">
                <div className="w-10 h-10 rounded-full border-2 border-cyan-500 border-t-transparent animate-spin" />
                <div className="text-center space-y-1">
                  <div className="text-xs text-cyan-300 font-mono tracking-wide">
                    Sampling Video Keyframes... ({matchProgress}%)
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono">
                    Evaluating facial landmark vectors against reference
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Controls: Threshold & Interval */}
          <div className="grid grid-cols-2 gap-4 pt-2 border-t border-slate-900 text-xs text-slate-400">
            <div className="flex items-center gap-2">
              <span className="shrink-0 font-mono">Similarity Threshold ({(similarityThreshold * 100).toFixed(0)}%):</span>
              <input
                type="range"
                min="0.50"
                max="0.90"
                step="0.02"
                value={similarityThreshold}
                onChange={(e) => setSimilarityThreshold(parseFloat(e.target.value))}
                className="flex-1 accent-cyan-500 h-1 bg-slate-800 rounded-lg"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="shrink-0 font-mono">Cadence ({samplingInterval}s):</span>
              <input
                type="range"
                min="0.25"
                max="2.0"
                step="0.25"
                value={samplingInterval}
                onChange={(e) => setSamplingInterval(parseFloat(e.target.value))}
                className="flex-1 accent-cyan-500 h-1 bg-slate-800 rounded-lg"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Match Results & Candidate Timeline */}
      {matchResult && (
        <div className="space-y-4">
          {/* Outcome Banner */}
          <div
            className={`p-4 rounded-xl border flex items-start justify-between gap-4 transition-all ${
              conclusionColors[matchResult.conclusion] || 'text-slate-300 bg-slate-900 border-slate-800'
            }`}
          >
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono font-bold tracking-wider uppercase px-2 py-0.5 rounded bg-black/30 border border-current">
                  {matchResult.conclusion.replace(/_/g, ' ')}
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  Sampled {matchResult.framesSampled} frames
                </span>
              </div>
              <h2 className="text-base font-bold text-slate-100">
                {language === 'en' ? matchResult.explanation : matchResult.hindiExplanation}
              </h2>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleSaveFinding}
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
                    <Plus className="w-3.5 h-3.5" /> Save Finding
                  </>
                )}
              </button>

              <button
                onClick={handlePurgeBiometrics}
                className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-rose-950/40 rounded-lg border border-slate-800 transition-colors"
                title="Purge Ephemeral Biometric Embeddings"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Candidate Matches Timeline */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-cyan-400" /> Candidate Video Matches ({matchResult.candidateMatches.length})
              </span>
              <span className="text-[11px] text-slate-500 font-mono">
                Click candidate to preview side-by-side
              </span>
            </div>

            {matchResult.candidateMatches.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                {matchResult.candidateMatches.map((cand, idx) => {
                  const isSel = selectedMatch?.timestamp === cand.timestamp;
                  return (
                    <button
                      key={idx}
                      onClick={() => setSelectedMatch(cand)}
                      className={`p-2 rounded-lg border text-left transition-all ${
                        isSel
                          ? 'bg-cyan-950/60 border-cyan-600 shadow-[0_0_12px_rgba(88,215,223,0.2)]'
                          : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      <div className="aspect-square bg-slate-950 rounded overflow-hidden mb-1.5 border border-slate-800">
                        <img src={cand.candidateCropUrl} alt="" className="w-full h-full object-cover" />
                      </div>
                      <div className="text-[11px] font-mono text-cyan-300 font-bold">
                        {(cand.similarityScore * 100).toFixed(1)}% Sim
                      </div>
                      <div className="text-[10px] text-slate-400 font-mono">
                        {cand.timestamp}
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="p-6 text-center text-slate-500 font-mono text-xs">
                No candidate frames exceeded the threshold of {(similarityThreshold * 100).toFixed(0)}%.
              </div>
            )}
          </div>

          {/* Detailed Side-by-Side Face Comparison if Candidate Selected */}
          {selectedMatch && refFaceRegion && (
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
              <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider block">
                Visual Face Crop Comparison (Timestamp: {selectedMatch.timestamp})
              </span>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
                <div className="text-center space-y-1">
                  <div className="aspect-square max-w-[140px] mx-auto bg-slate-900 rounded-lg overflow-hidden border border-cyan-600">
                    <img src={refFaceRegion.cropDataUrl} alt="Ref Face" className="w-full h-full object-cover" />
                  </div>
                  <span className="text-xs text-cyan-400 font-mono block">Reference Face</span>
                </div>

                <div className="text-center space-y-2 bg-slate-900/60 p-4 rounded-xl border border-slate-800">
                  <div className="text-2xl font-bold font-mono text-cyan-300">
                    {(selectedMatch.similarityScore * 100).toFixed(1)}%
                  </div>
                  <div className="text-[11px] text-slate-400">Cosine Distance Score</div>
                  <div className="text-[10px] text-slate-500 font-mono">
                    Eye Spacing: {(selectedMatch.eyeSpacingSimilarity * 100).toFixed(0)}% | Geometry: {(selectedMatch.facialGeometryScore * 100).toFixed(0)}%
                  </div>
                </div>

                <div className="text-center space-y-1">
                  <div className="aspect-square max-w-[140px] mx-auto bg-slate-900 rounded-lg overflow-hidden border border-cyan-600">
                    <img src={selectedMatch.candidateCropUrl} alt="Candidate Face" className="w-full h-full object-cover" />
                  </div>
                  <span className="text-xs text-cyan-400 font-mono block">Candidate Crop ({selectedMatch.timestamp})</span>
                </div>
              </div>
            </div>
          )}

          {/* Legal & Privacy Scope Alert */}
          <div className="p-4 bg-slate-950/80 border border-slate-800 rounded-xl space-y-2 text-xs">
            <div className="flex items-center gap-2 font-semibold text-cyan-400 uppercase tracking-wider text-[11px]">
              <ShieldAlert className="w-4 h-4 text-cyan-400" /> Privacy, Consent & Biometric Retention Notice
            </div>
            <p className="text-slate-300 leading-relaxed">
              {matchResult.biometricRetentionDisclaimer}
            </p>
            <p className="text-slate-400 text-[11px]">
              <strong>Forensic Principle:</strong> A facial similarity score reflects geometric pixel alignment under specific lighting and camera angle conditions. It does NOT constitute legal proof of identity or biometric certification.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
