import React, { useState, useEffect, useRef } from 'react';
import { EvidenceItem, AnalysisFinding } from '@/types/forensics';
import {
  analyzeAudioBuffer,
  analyzeAudioEnvironment,
  analyzeVoiceContinuity,
  AudioEnvironmentFingerprint,
  AudioForensicReport,
  summarizeAudioEnvironmentComparison,
  VoiceContinuityReport,
} from '@/lib/forensics/audio';
import { calculateSHA256, verifyHashesMatch } from '@/lib/forensics/crypto';
import { getEvidenceSignedUrl } from '@/lib/supabase-sync';
import {
  Music,
  Play,
  Pause,
  Activity,
  FileText,
  AlertTriangle,
  Plus,
  Sparkles,
  Copy,
  Trash2,
  Check,
  Radio,
  Key,
  Headphones,
  Clock,
  ShieldAlert,
  Zap,
  RefreshCw,
  Info,
} from 'lucide-react';

interface AudioForensicsViewProps {
  evidenceList: EvidenceItem[];
  selectedItem?: EvidenceItem;
  onSelectEvidence: (item: EvidenceItem) => void;
  onAddFinding: (finding: Omit<AnalysisFinding, 'id' | 'createdAt'>) => void;
}

export const AudioForensicsView: React.FC<AudioForensicsViewProps> = ({
  evidenceList,
  selectedItem,
  onSelectEvidence,
  onAddFinding,
}) => {
  const audioOnly = evidenceList.filter((e) => e.mediaType === 'audio');
  const activeItem = selectedItem?.mediaType === 'audio' ? selectedItem : audioOnly[0];
  const comparisonItems = activeItem
    ? audioOnly.filter((item) => item.investigationId === activeItem.investigationId)
    : [];

  const [isPlaying, setIsPlaying] = useState(false);
  const [report, setReport] = useState<AudioForensicReport | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [environmentItemA, setEnvironmentItemA] = useState('');
  const [environmentItemB, setEnvironmentItemB] = useState('');
  const [environmentFingerprintA, setEnvironmentFingerprintA] = useState<AudioEnvironmentFingerprint | null>(null);
  const [environmentFingerprintB, setEnvironmentFingerprintB] = useState<AudioEnvironmentFingerprint | null>(null);
  const [environmentError, setEnvironmentError] = useState('');
  const [isComparingEnvironment, setIsComparingEnvironment] = useState(false);
  const [voiceContinuity, setVoiceContinuity] = useState<VoiceContinuityReport | null>(null);
  const [voiceContinuityError, setVoiceContinuityError] = useState('');
  const [isAnalyzingContinuity, setIsAnalyzingContinuity] = useState(false);

  // Transcription state
  const [transcript, setTranscript] = useState<string>('');
  const [isTranscribing, setIsTranscribing] = useState<boolean>(false);
  const [transcribeError, setTranscribeError] = useState<string>('');
  const [transcriptionConsent, setTranscriptionConsent] = useState(false);
  const [copiedTranscript, setCopiedTranscript] = useState(false);
  // TruthScan AI Audio Detection state
  const [truthscanConsent, setTruthscanConsent] = useState(false);
  const [truthscanResult, setTruthscanResult] = useState<{
    aiScore: number;
    humanScore: number;
    overallAiScore: number;
    aiProbability: number;
    verdict: 'AI_GENERATED' | 'NOT_AI_GENERATED' | 'INCONCLUSIVE';
    rawVerdict: string;
    durationSec: number;
    detector: string;
    filename: string;
    cached: boolean;
    scanId?: string | null;
    requestId?: string | null;
    md5?: string | null;
    totalBytes?: number | null;
    timestamp: string;
    source: string;
    chunks?: Array<{ chunkIndex: number; aiScore: number; humanScore: number; aiProbability: number }>;
    isValid?: boolean;
    message?: string;
  } | null>(null);
  const [truthscanError, setTruthscanError] = useState('');
  const [isTruthscanAnalyzing, setIsTruthscanAnalyzing] = useState(false);
  const [truthscanStage, setTruthscanStage] = useState('');
  const [truthscanElapsedSeconds, setTruthscanElapsedSeconds] = useState(0);
  const [truthscanApiKey, setTruthscanApiKey] = useState<string>(() => {
    try {
      return localStorage.getItem('vexalens_truthscan_audio_api_key') || '';
    } catch {
      return '';
    }
  });
  const [showTruthscanKeySettings, setShowTruthscanKeySettings] = useState<boolean>(false);
  const [truthscanCredits, setTruthscanCredits] = useState<number | null>(null);
  const [isLoadingCredits, setIsLoadingCredits] = useState<boolean>(false);

  const fetchTruthScanCredits = async (keyOverride?: string) => {
    setIsLoadingCredits(true);
    try {
      const activeKey = (keyOverride ?? truthscanApiKey).trim();
      const headers: Record<string, string> = {};
      if (activeKey) headers['apikey'] = activeKey;
      const res = await fetch('/api/forensics/ai-audio-credits', { headers });
      if (res.ok) {
        const data = await res.json();
        if (typeof data.credits === 'number') {
          setTruthscanCredits(data.credits);
        }
      }
    } catch {
      // Ignore credits check failure
    } finally {
      setIsLoadingCredits(false);
    }
  };

  const handleTruthscanApiKeyChange = (value: string) => {
    setTruthscanApiKey(value);
    try {
      if (value.trim()) {
        localStorage.setItem('vexalens_truthscan_audio_api_key', value.trim());
      } else {
        localStorage.removeItem('vexalens_truthscan_audio_api_key');
      }
    } catch {
      // ignore storage error
    }
    void fetchTruthScanCredits(value);
  };

  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    setEnvironmentItemA(activeItem?.id ?? '');
    setEnvironmentItemB(comparisonItems.find((item) => item.id !== activeItem?.id)?.id ?? '');
    setEnvironmentFingerprintA(null);
    setEnvironmentFingerprintB(null);
    setEnvironmentError('');
  }, [activeItem?.id, comparisonItems.map((item) => item.id).join('|')]);

  useEffect(() => {
    setVoiceContinuity(null);
    setVoiceContinuityError('');
    setTruthscanConsent(false);
    setTruthscanResult(null);
    setTruthscanError('');
  }, [activeItem?.id]);

  useEffect(() => {
    if (!isTruthscanAnalyzing) return;
    const timer = window.setInterval(() => {
      setTruthscanElapsedSeconds((elapsed) => elapsed + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isTruthscanAnalyzing]);

  useEffect(() => {
    void fetchTruthScanCredits();
  }, []);

  // Analyze audio whenever activeItem changes
  useEffect(() => {
    if (!activeItem || !activeItem.previewUrl) return;

    let isMounted = true;
    setIsAnalyzing(true);
    setTranscript('');
    setTranscribeError('');
    setTranscriptionConsent(false);

    fetch(activeItem.previewUrl)
      .then((res) => res.blob())
      .then((blob) => analyzeAudioBuffer(blob))
      .then((rep) => {
        if (isMounted) setReport(rep);
      })
      .catch((err) => {
        console.warn('Audio analysis error:', err);
      })
      .finally(() => {
        if (isMounted) setIsAnalyzing(false);
      });

    return () => {
      isMounted = false;
    };
  }, [activeItem?.id]);

  // Draw waveform on canvas
  useEffect(() => {
    if (!report || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    // Draw center line
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    const peaks = report.waveformPeaks;
    if (!peaks || peaks.length === 0) return;
    const barWidth = width / peaks.length;

    for (let i = 0; i < peaks.length; i++) {
      const [min, max] = peaks[i];
      const yMin = ((1 + min) / 2) * height;
      const yMax = ((1 + max) / 2) * height;
      const x = i * barWidth;

      // Color based on clipping amplitude
      if (Math.abs(min) > 0.95 || Math.abs(max) > 0.95) {
        ctx.fillStyle = '#f43f5e'; // Rose clipping
      } else {
        ctx.fillStyle = '#22d3ee'; // Cyan
      }

      ctx.fillRect(x, yMin, Math.max(1, barWidth - 1), Math.max(2, yMax - yMin));
    }
  }, [report]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play();
      setIsPlaying(true);
    }
  };

  // Request optional server-side transcription; this does not assess authenticity.
  const handleTranscribe = async () => {
    if (!activeItem) return;
    if (!transcriptionConsent) {
      setTranscribeError('Consent is required before audio is sent to the external transcription provider.');
      return;
    }
    setIsTranscribing(true);
    setTranscribeError('');

    try {
      const res = await fetch(activeItem.previewUrl);
      const blob = await res.blob();
      const reader = new FileReader();

      reader.onloadend = async () => {
        const base64 = reader.result as string;
        try {
          const apiRes = await fetch('/api/forensics/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              audioBase64: base64,
              mimeType: activeItem.mimeType || 'audio/mp3',
            }),
          });

          const data = await apiRes.json();
          if (data.error) {
            setTranscribeError(data.error);
          } else {
            setTranscript(data.transcript);
          }
        } catch (postErr: any) {
          setTranscribeError(postErr.message || 'API call failed');
        } finally {
          setIsTranscribing(false);
        }
      };

      reader.readAsDataURL(blob);
    } catch (err: any) {
      setTranscribeError(err.message || 'Failed to read audio blob');
      setIsTranscribing(false);
    }
  };

  const handleTruthscanAudioAnalysis = async (useSampleData = false) => {
    if (!activeItem) return;
    if (!useSampleData && !truthscanConsent) {
      setTruthscanError('Consent is required before audio is sent to TruthScan for screening.');
      return;
    }

    setIsTruthscanAnalyzing(true);
    setTruthscanElapsedSeconds(0);
    setTruthscanError('');
    setTruthscanResult(null);

    // Sample benchmark path
    if (useSampleData) {
      try {
        setTruthscanStage('Loading TruthScan reference benchmark…');
        const apiResponse = await fetch('/api/forensics/ai-audio-detect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            useSampleData: true,
            fileName: activeItem.fileName,
          }),
        });
        const data = await apiResponse.json();
        if (!apiResponse.ok) {
          throw new Error(data.error || 'Failed to load reference benchmark output.');
        }
        setTruthscanResult({
          aiScore: data.aiScore ?? 0,
          humanScore: data.humanScore ?? 0,
          overallAiScore: data.overallAiScore ?? 0,
          aiProbability: data.aiProbability ?? 0,
          verdict: data.verdict,
          rawVerdict: data.rawVerdict,
          durationSec: data.durationSec ?? 0,
          detector: data.detector || 'truthscan-audio-v2',
          filename: data.filename || activeItem.fileName,
          cached: Boolean(data.cached),
          scanId: data.scanId,
          requestId: data.requestId,
          md5: data.md5 || null,
          totalBytes: data.totalBytes || null,
          timestamp: data.timestamp,
          source: data.source,
          chunks: data.chunks || [],
          isValid: data.isValid,
          message: data.message,
        });
      } catch (error) {
        setTruthscanError(error instanceof Error ? error.message : 'Could not load sample benchmark.');
      } finally {
        setIsTruthscanAnalyzing(false);
        setTruthscanStage('');
      }
      return;
    }

    // Live detection path
    try {
      setTruthscanStage('Step 1/3: Accessing audio evidence file…');
      let blob: Blob | null = null;

      if (activeItem.previewUrl) {
        try {
          const res = await fetch(activeItem.previewUrl);
          if (res.ok) blob = await res.blob();
        } catch {}

        if (!blob || blob.size === 0) {
          try {
            const encoded = encodeURI(activeItem.previewUrl);
            if (encoded !== activeItem.previewUrl) {
              const res = await fetch(encoded);
              if (res.ok) blob = await res.blob();
            }
          } catch {}
        }
      }

      if (!blob || blob.size === 0) {
        if (activeItem.storageUrl) {
          try {
            const res = await fetch(activeItem.storageUrl);
            if (res.ok) blob = await res.blob();
          } catch {}

          if (!blob || blob.size === 0) {
            try {
              const freshSignedUrl = await getEvidenceSignedUrl(activeItem.storageUrl);
              if (freshSignedUrl) {
                const res = await fetch(freshSignedUrl);
                if (res.ok) blob = await res.blob();
              }
            } catch {}
          }
        }
      }

      if (!blob || blob.size === 0) {
        if (audioRef.current?.src) {
          try {
            const res = await fetch(audioRef.current.src);
            if (res.ok) blob = await res.blob();
          } catch {}
        }
      }

      if (!blob || blob.size === 0) {
        throw new Error(
          `Could not read ${activeItem.fileName}. The audio source URL could not be accessed. Click "Test Sample Benchmark" to evaluate the TruthScan reference model.`
        );
      }

      if (blob.size > 100 * 1024 * 1024) {
        throw new Error('TruthScan screening requires an audio file no larger than 100 MiB.');
      }

      setTruthscanStage('Step 2/3: Encoding audio buffer…');
      const audioBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string'
          ? resolve(reader.result)
          : reject(new Error('Could not encode the audio file.'));
        reader.onerror = () => reject(new Error('Could not read the audio file.'));
        reader.readAsDataURL(blob);
      });

      const audioMimeType = [blob.type, activeItem.mimeType]
        .find((type) => type && type.toLowerCase().startsWith('audio/')) || 'audio/mpeg';

      setTruthscanStage('Step 3/3: Running TruthScan neural scan & chunk analysis…');
      const activeKey = truthscanApiKey.trim();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (activeKey) {
        headers['apikey'] = activeKey;
      }

      const apiResponse = await fetch('/api/forensics/ai-audio-detect', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          audioBase64,
          fileName: activeItem.fileName,
          mimeType: audioMimeType,
          useSampleData: false,
          apiKey: activeKey || undefined,
        }),
      });

      const data = await apiResponse.json();
      if (!apiResponse.ok) {
        if (apiResponse.status === 503 && data.hasSampleFallback) {
          throw new Error('TruthScan API key is not configured. Provide your key in "API Key Settings" or click "Test Sample Benchmark" to evaluate against verified reference output.');
        }
        throw new Error(data.error || `TruthScan detection request failed (HTTP ${apiResponse.status}).`);
      }

      setTruthscanResult({
        aiScore: data.aiScore ?? 0,
        humanScore: data.humanScore ?? 0,
        overallAiScore: data.overallAiScore ?? 0,
        aiProbability: data.aiProbability ?? 0,
        verdict: data.verdict,
        rawVerdict: data.rawVerdict,
        durationSec: data.durationSec ?? 0,
        detector: data.detector || 'truthscan-audio-v2',
        filename: data.filename || activeItem.fileName,
        cached: Boolean(data.cached),
        scanId: data.scanId,
        requestId: data.requestId,
        md5: data.md5 || null,
        totalBytes: data.totalBytes || null,
        timestamp: data.timestamp,
        source: data.source,
        chunks: data.chunks || [],
        isValid: data.isValid,
        message: data.message,
      });
      setTruthscanStage('');
      void fetchTruthScanCredits();
    } catch (error) {
      setTruthscanError(error instanceof Error ? error.message : 'TruthScan AI audio analysis failed.');
    } finally {
      setIsTruthscanAnalyzing(false);
      setTruthscanStage('');
    }
  };

  const saveTruthscanAudioFinding = () => {
    if (!activeItem || !truthscanResult) return;
    const aiScore = truthscanResult.aiScore;
    const severity = aiScore >= 75 ? 'critical' : aiScore >= 45 ? 'warning' : 'informational';

    onAddFinding({
      investigationId: activeItem.investigationId,
      evidenceId: activeItem.id,
      title: `TruthScan AI Audio Screening: ${activeItem.fileName} (${aiScore}% AI Likelihood)`,
      severity,
      category: 'synthetic_deepfake',
      evidenceLabel: 'model_prediction',
      observedEvidence: `TruthScan AI Audio Detector reported AI likelihood of ${aiScore}% (Human: ${truthscanResult.humanScore}%, Verdict: ${truthscanResult.rawVerdict}, Engine: ${truthscanResult.detector}). Duration analyzed: ${truthscanResult.durationSec.toFixed(1)}s.${truthscanResult.chunks && truthscanResult.chunks.length > 0 ? ` Analyzed across ${truthscanResult.chunks.length} temporal chunks.` : ''}\nEvidence SHA-256: ${activeItem.sha256Hash}.${truthscanResult.scanId ? `\nReport ID: ${truthscanResult.scanId}` : ''}${truthscanResult.md5 ? `\nFile MD5: ${truthscanResult.md5}` : ''}`,
      simpleExplanation: `TruthScan voice deepfake scan classified this vocal track with ${aiScore}% AI likelihood and ${truthscanResult.humanScore}% human acoustic probability (verdict: ${truthscanResult.rawVerdict}).`,
      technicalExplanation: `Multi-stage neural audio detection via TruthScan API (https://detect-audio.truthscan.com). Model: ${truthscanResult.detector}. Confidence: ${truthscanResult.overallAiScore.toFixed(3)}, Duration: ${truthscanResult.durationSec}s.${truthscanResult.totalBytes ? ` File size: ${truthscanResult.totalBytes} bytes.` : ''}`,
      whyIndicatesAI: aiScore >= 60 ? 'Vocal timbre, synthesis artifacts, and temporal chunk-by-chunk probability patterns align with AI-generated or cloned voice models.' : 'Audio exhibits vocal distribution and natural human speech dynamics consistent with genuine vocal recording.',
      methodReliability: 'TruthScan Multi-Chunk Neural Audio Classifier. Evaluates up to 60s of vocal spectrum.',
      potentialFalsePositives: 'Extremely heavy lossy recompression (low-bitrate MP3/Opus), studio vocoders, or aggressive auto-tune may affect inference confidence.',
      unresolvedQuestions: 'External model scores are screening indicators. Corroborate with vocal tract formant resonance and background acoustic continuity.',
      recommendedNextSteps: 'Cross-reference vocal formant dynamics in the spectrum analyzer and verify background ambient room acoustics.',
      detectionMethod: 'TruthScan AI Audio Detector API (detect-audio.truthscan.com)',
      detectorVersion: truthscanResult.detector || 'truthscan-audio-v2',
      rawDetectorScore: aiScore / 100,
      scoreInterpretation: `Mean AI probability: ${truthscanResult.overallAiScore.toFixed(3)} on scale [0.0–1.0]. >=0.60 indicates AI-generated speech, <=0.35 indicates authentic human speech.`,
      sourceSha256: activeItem.sha256Hash,
      limitations: 'External AI screening provides indicative classification. Should be considered alongside acoustic room continuity and provenance verification.',
    });
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedTranscript(true);
    setTimeout(() => setCopiedTranscript(false), 2000);
  };

  const handleRecordAudioFinding = () => {
    if (!activeItem || !report) return;

    onAddFinding({
      investigationId: activeItem.investigationId,
      evidenceId: activeItem.id,
      title: `Acoustic Signal & Spectrum Audit on ${activeItem.fileName}`,
      severity: report.spectralAnomalies.length > 0 ? 'warning' : 'nominal',
      category: 'audio_signal',
      observedEvidence: `Sample rate: ${report.sampleRateHz} Hz (${report.channels} ch). RMS: ${report.rmsDbfs} dBFS, Peak: ${report.peakDbfs} dBFS. Clipping events: ${report.clippingCount}. Silence ratio: ${report.silenceRatioPercent}%. Detected anomalies: ${report.spectralAnomalies.join('; ') || 'None'}.`,
      simpleExplanation: `Acoustic inspection reveals ${
        report.spectralAnomalies.length > 0
          ? `potential vocal synthesis or processing indicators: ${report.spectralAnomalies[0]}.`
          : 'natural dynamic range and speech distribution without synthetic vocoder clipping.'
      }`,
      technicalExplanation: `FFT dynamic range analysis: Nyquist cutoff at ${report.nyquistHz} Hz. Harmonic resonance distribution in standard vocal fundamental frequencies. Silence envelope ratio measured at ${report.silenceRatioPercent}%.`,
      whyIndicatesAI:
        report.spectralAnomalies.length > 0
          ? 'Frequency discontinuities in upper formant harmonics consistent with neural vocoder synthesis.'
          : 'Continuous analog harmonic resonance without sudden synthetic speech clipping.',
      methodReliability: 'Fast Fourier Transform (FFT) dynamic range and spectral envelope extraction.',
      potentialFalsePositives:
        'Lossy MP3 encoding can introduce compression artifacts that resemble subtle synthetic filters.',
      unresolvedQuestions: 'Requires original multi-track session to confirm room acoustic reverberation.',
      recommendedNextSteps: 'Run phonetic cadence alignment and cross-reference with authentic vocal reference.',
      detectionMethod: 'Web Audio Signal Processing & Dynamic Range FFT Extraction',
      limitations: 'Lossy MP3 encoding can introduce compression artifacts that resemble subtle synthetic filters.',
      detectorVersion: 'VexaLens-AcousticAudit-v2.0',
    });
    alert('Audio acoustic finding recorded in case register.');
  };

  const compareRecordingEnvironments = async () => {
    const itemA = comparisonItems.find((item) => item.id === environmentItemA);
    const itemB = comparisonItems.find((item) => item.id === environmentItemB);
    if (!itemA || !itemB || itemA.id === itemB.id) {
      setEnvironmentError('Choose two different audio files from this case.');
      return;
    }
    setIsComparingEnvironment(true);
    setEnvironmentError('');
    setEnvironmentFingerprintA(null);
    setEnvironmentFingerprintB(null);
    try {
      const readVerifiedAudio = async (item: EvidenceItem): Promise<Blob> => {
        const sourceUrl = item.previewUrl || item.storageUrl;
        if (!sourceUrl) throw new Error(`No audio file is available for ${item.fileName}.`);
        const response = await fetch(sourceUrl);
        if (!response.ok) throw new Error(`Could not read ${item.fileName} (HTTP ${response.status}).`);
        const blob = await response.blob();
        if (blob.size > 25 * 1024 * 1024) throw new Error(`${item.fileName} is larger than the 25 MiB comparison limit.`);
        const actualHash = await calculateSHA256(blob);
        if (!verifyHashesMatch(actualHash, item.sha256Hash)) {
          throw new Error(`The available audio for ${item.fileName} does not match its saved SHA-256. Comparison stopped.`);
        }
        return blob;
      };
      const [blobA, blobB] = await Promise.all([readVerifiedAudio(itemA), readVerifiedAudio(itemB)]);
      const [fingerprintA, fingerprintB] = await Promise.all([
        analyzeAudioEnvironment(blobA),
        analyzeAudioEnvironment(blobB),
      ]);
      setEnvironmentFingerprintA(fingerprintA);
      setEnvironmentFingerprintB(fingerprintB);
    } catch (error) {
      setEnvironmentError(error instanceof Error ? error.message : 'Could not compare these audio files.');
    } finally {
      setIsComparingEnvironment(false);
    }
  };

  const saveEnvironmentComparison = () => {
    const itemA = comparisonItems.find((item) => item.id === environmentItemA);
    const itemB = comparisonItems.find((item) => item.id === environmentItemB);
    if (!itemA || !itemB || !environmentFingerprintA || !environmentFingerprintB) return;
    const observation = summarizeAudioEnvironmentComparison(
      itemA.fileName,
      environmentFingerprintA,
      itemB.fileName,
      environmentFingerprintB
    );
    const rawMeasurements = (name: string, fingerprint: AudioEnvironmentFingerprint, hash: string) =>
      `${name} (SHA-256 ${hash}): ${fingerprint.durationSec.toFixed(1)} seconds; ${fingerprint.sampleRateHz} audio samples per second; quiet-section sound estimate ${fingerprint.noiseFloorDbfs} dBFS; low/mid/high sound shares ${fingerprint.lowBandPercent}/${fingerprint.midBandPercent}/${fingerprint.highBandPercent}%; sound-fade estimate after a loud peak ${fingerprint.decayProxyMs === null ? 'not available' : `${fingerprint.decayProxyMs} ms`}.`;
    const observedEvidence = `${observation}\n${rawMeasurements(itemA.fileName, environmentFingerprintA, itemA.sha256Hash)}\n${rawMeasurements(itemB.fileName, environmentFingerprintB, itemB.sha256Hash)}`;
    for (const item of [itemA, itemB]) {
      onAddFinding({
        investigationId: item.investigationId,
        evidenceId: item.id,
        title: `Audio environment comparison: ${item.fileName}`,
        severity: 'inconclusive',
        category: 'audio_signal',
        evidenceLabel: 'observed_fact',
        observedEvidence,
        simpleExplanation: observation,
        technicalExplanation: 'The comparison records the clip length, recording sample rate, estimated quiet-section sound level, low/mid/high sound shares, and rough fade time after loud peaks.',
        methodReliability: 'Exploratory sound comparison only; not tested to identify a room or recording location.',
        potentialFalsePositives: 'Microphones, distance, recording level, compression, speech, background sound, and editing can change these measurements.',
        unresolvedQuestions: 'These measurements cannot tell whether the recordings were made in the same physical room or location.',
        recommendedNextSteps: 'Compare original recordings and consider differences in microphone, distance, time, and recording conditions.',
        detectionMethod: 'Audio Environment Fingerprint; local feature comparison',
        detectorVersion: '1.0',
        limitations: 'A similar sound pattern does not prove a shared location. The quiet-section sound level and sound-fade time are rough estimates, not direct measurements of room noise or reverberation.',
      });
    }
  };

  const analyzeActiveVoiceContinuity = async () => {
    if (!activeItem) return;
    setIsAnalyzingContinuity(true);
    setVoiceContinuityError('');
    setVoiceContinuity(null);
    try {
      const sourceUrl = activeItem.previewUrl || activeItem.storageUrl;
      if (!sourceUrl) throw new Error(`No audio file is available for ${activeItem.fileName}.`);
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error(`Could not read ${activeItem.fileName} (HTTP ${response.status}).`);
      const blob = await response.blob();
      if (blob.size > 25 * 1024 * 1024) throw new Error('Voice continuity review is limited to files no larger than 25 MiB.');
      const actualHash = await calculateSHA256(blob);
      if (!verifyHashesMatch(actualHash, activeItem.sha256Hash)) {
        throw new Error('The available audio does not match its saved SHA-256. Review stopped.');
      }
      setVoiceContinuity(await analyzeVoiceContinuity(blob));
    } catch (error) {
      setVoiceContinuityError(error instanceof Error ? error.message : 'Could not review continuity in this audio.');
    } finally {
      setIsAnalyzingContinuity(false);
    }
  };

  const saveVoiceContinuityFinding = () => {
    if (!activeItem || !voiceContinuity) return;
    const transitionNotes = voiceContinuity.transitions.length
      ? voiceContinuity.transitions.map((transition) =>
          `${transition.timeSec.toFixed(1)} seconds: ${transition.changes.join('; ')}.`
        ).join(' ')
      : 'No abrupt changes exceeded the review thresholds in the measured segments.';
    const segmentMeasurements = voiceContinuity.segments.map((segment) =>
      `${segment.startSec.toFixed(1)}-${segment.endSec.toFixed(1)} seconds: loudness ${segment.loudnessDbfs} dBFS; low/mid/high sound shares ${segment.lowBandPercent}/${segment.midBandPercent}/${segment.highBandPercent}%; rapid sound changes ${segment.zeroCrossingRate}.`
    ).join('\n');
    onAddFinding({
      investigationId: activeItem.investigationId,
      evidenceId: activeItem.id,
      title: `Voice continuity review: ${activeItem.fileName}`,
      severity: voiceContinuity.transitions.length ? 'warning' : 'informational',
      category: 'audio_signal',
      evidenceLabel: 'observed_fact',
      observedEvidence: `Reviewed ${voiceContinuity.segments.length} overlapping audio segments across ${voiceContinuity.durationSec.toFixed(1)} seconds. ${voiceContinuity.transitions.length} transition(s) exceeded the review thresholds. ${transitionNotes}\nSegment measurements:\n${segmentMeasurements}`,
      simpleExplanation: voiceContinuity.transitions.length
        ? `The audio has ${voiceContinuity.transitions.length} abrupt change(s) in loudness or sound pattern that may be worth listening to. These changes can also happen naturally or because of a microphone, distance, noise, compression, or recording conditions. This does not identify a speaker or prove that the audio was edited.`
        : 'No abrupt changes exceeded the review thresholds in the measured segments. This does not prove the audio is unedited and does not identify a speaker.',
      technicalExplanation: 'The browser measured overlapping half-second windows, recording level (RMS), broad low/mid/high frequency energy shares, and zero-crossing rate. Adjacent windows were flagged using fixed exploratory thresholds: 10 dB level difference, 22 percentage points of spectral change, or 0.12 zero-crossing-rate change.',
      methodReliability: 'Exploratory discontinuity screening for manual listening. Thresholds are practical review cues and have not been validated as an edit detector.',
      potentialFalsePositives: 'Natural pauses or speech changes, different speakers, changes in distance or microphone direction, background sounds, automatic gain control, codec changes, and ordinary compression can cause these transitions.',
      unresolvedQuestions: 'A flagged transition does not show why the sound changed or whether an edit occurred. Voice similarity is not used to identify a speaker.',
      recommendedNextSteps: 'Listen to each marked time in the original file and compare the transition with the waveform and recording context.',
      detectionMethod: 'Voice Continuity Monitor; local segmented audio measurements',
      detectorVersion: '1.0',
      limitations: 'This feature flags measured discontinuities for manual review. It does not determine whether editing occurred, identify a speaker, or prove that two voice segments came from the same person.',
    });
  };

  if (!activeItem) {
    return (
      <div className="flex flex-col items-center justify-center p-16 text-center space-y-4">
        <div className="w-16 h-16 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center">
          <Music className="w-8 h-8 text-slate-600" />
        </div>
        <div>
          <p className="text-slate-300 font-semibold">No audio evidence loaded</p>
          <p className="text-xs text-slate-500 mt-1">Upload an MP3, WAV, or M4A file in Evidence Intake to run acoustic waveform inspection.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* ── HEADER ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800/80">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-mono text-cyan-400 uppercase tracking-widest">
            <Music className="w-3.5 h-3.5" />
            <span>Audio Forensics &amp; Acoustic Spectrum</span>
            <span className="text-slate-700">/</span>
            <span className="text-slate-400 normal-case truncate max-w-[200px]">{activeItem.fileName}</span>
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-100 mt-1">
            Audio Signal Review
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">Voice Continuity Monitor &amp; AI Deepfake Detection</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500">Evidence:</label>
          <select
            value={activeItem.id}
            onChange={(e) => {
              const target = audioOnly.find((a) => a.id === e.target.value);
              if (target) onSelectEvidence(target);
            }}
            className="bg-slate-900/80 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
          >
            {audioOnly.map((a) => (
              <option key={a.id} value={a.id}>{a.fileName}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── KPI STAT BAR ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Sample Rate', value: report ? `${(report.sampleRateHz / 1000).toFixed(1)} kHz` : '—', sub: report ? (report.channels === 1 ? 'Mono' : 'Stereo') : '', accent: '#22d3ee', glow: 'rgba(34,211,238,0.12)', border: 'rgba(34,211,238,0.2)' },
          { label: 'RMS Loudness', value: report ? `${report.rmsDbfs} dBFS` : '—', sub: report ? `Peak ${report.peakDbfs} dBFS` : '', accent: '#a78bfa', glow: 'rgba(167,139,250,0.12)', border: 'rgba(167,139,250,0.2)' },
          { label: 'Clipping Events', value: report ? String(report.clippingCount) : '—', sub: report ? (report.clippingCount > 0 ? 'Distortion detected' : 'Clean signal') : '', accent: report?.clippingCount ? '#f43f5e' : '#34d399', glow: report?.clippingCount ? 'rgba(244,63,94,0.12)' : 'rgba(52,211,153,0.12)', border: report?.clippingCount ? 'rgba(244,63,94,0.2)' : 'rgba(52,211,153,0.2)' },
          { label: 'Silence Ratio', value: report ? `${report.silenceRatioPercent}%` : '—', sub: report ? `${report.durationSec.toFixed(1)}s total` : '', accent: '#fbbf24', glow: 'rgba(251,191,36,0.10)', border: 'rgba(251,191,36,0.2)' },
        ].map((stat) => (
          <div
            key={stat.label}
            style={{ background: 'linear-gradient(135deg,rgba(8,12,24,0.98),rgba(15,23,42,0.85))', borderColor: stat.border, boxShadow: `0 0 20px ${stat.glow}` }}
            className="rounded-2xl border p-4 space-y-1.5 relative overflow-hidden"
          >
            <div style={{ background: `radial-gradient(ellipse at top right, ${stat.glow}, transparent 70%)` }} className="absolute inset-0 pointer-events-none" />
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{stat.label}</div>
            <div style={{ color: stat.accent }} className="text-2xl font-extrabold font-mono leading-none">
              {isAnalyzing ? <span className="text-slate-600 text-sm animate-pulse">…</span> : stat.value}
            </div>
            {stat.sub && <div className="text-[10px] text-slate-600 font-mono">{stat.sub}</div>}
          </div>
        ))}
      </div>

      {/* ── MAIN GRID ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* LEFT COL */}
        <div className="lg:col-span-2 space-y-5">

          {/* Waveform Panel */}
          <div style={{ background: 'linear-gradient(165deg,rgba(2,6,20,0.99),rgba(8,15,35,0.95))' }} className="rounded-2xl border border-slate-800/80 overflow-hidden shadow-2xl">
            {/* Header bar */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800/70 bg-slate-900/30 backdrop-blur-sm">
              <div className="flex items-center gap-2.5">
                <div className="flex gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-rose-500/70" />
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-400/70" />
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400/70" />
                </div>
                <Activity className="w-3.5 h-3.5 text-cyan-400 ml-1" />
                <span className="text-xs font-bold text-slate-200">Interactive Waveform &amp; Amplitude Distribution</span>
              </div>
              <span className="text-[11px] font-mono text-slate-500">
                {isAnalyzing
                  ? <span className="text-cyan-400 animate-pulse">Decoding buffer…</span>
                  : report
                    ? <><span className="text-cyan-300 font-bold">{report.durationSec.toFixed(2)}s</span> · {report.nyquistHz.toLocaleString()} Hz Nyquist</>
                    : '—'}
              </span>
            </div>

            {/* Canvas */}
            <div className="px-5 pt-4 pb-1">
              <div style={{ background: 'rgba(1,3,12,0.95)', boxShadow: 'inset 0 0 60px rgba(34,211,238,0.04)' }} className="w-full h-52 rounded-xl border border-slate-800/50 overflow-hidden flex items-center">
                <canvas ref={canvasRef} width={900} height={192} className="w-full h-full object-contain" />
              </div>
            </div>

            {/* Time ruler */}
            {report && (
              <div className="flex justify-between px-7 pt-1 text-[10px] font-mono text-slate-700 select-none">
                <span>0:00</span>
                <span>{Math.floor(report.durationSec / 60)}:{String(Math.round(report.durationSec % 60)).padStart(2,'0')}</span>
              </div>
            )}

            {/* Player bar */}
            <div className="flex items-center justify-between px-5 py-4">
              <div className="flex items-center gap-3">
                <button
                  onClick={togglePlay}
                  style={{ background: isPlaying ? 'linear-gradient(135deg,#0e7490,#0891b2)' : 'linear-gradient(135deg,#22d3ee,#67e8f9)', boxShadow: '0 4px 16px rgba(34,211,238,0.25)' }}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-slate-950 text-xs font-extrabold transition-all hover:scale-105 active:scale-95"
                >
                  {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  <span>{isPlaying ? 'Pause' : 'Play Audio'}</span>
                </button>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-slate-600 font-mono">{activeItem.mimeType}</span>
                  <span className="text-[10px] text-slate-600 font-mono">SHA-256: {activeItem.sha256Hash.slice(0,14)}…</span>
                </div>
              </div>
              <button
                onClick={handleRecordAudioFinding}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-800/60 hover:bg-slate-700 border border-slate-700/50 hover:border-cyan-500/40 text-xs text-slate-200 transition-all font-semibold"
              >
                <Plus className="w-3.5 h-3.5 text-cyan-400" />
                Save Finding
              </button>
            </div>
            <audio ref={audioRef} src={activeItem.previewUrl} onEnded={() => setIsPlaying(false)} className="hidden" />
          </div>

          {/* Anomaly Banner */}
          {report?.spectralAnomalies && report.spectralAnomalies.length > 0 && (
            <div style={{ background: 'linear-gradient(135deg,rgba(78,30,6,0.5),rgba(40,20,0,0.4))' }} className="rounded-2xl border border-amber-700/50 px-5 py-4 flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-xs font-bold text-amber-300 mb-1.5 uppercase tracking-wide">Acoustic Flags Observed</p>
                <ul className="space-y-1">
                  {report.spectralAnomalies.map((a, i) => (
                    <li key={i} className="text-xs text-amber-200/80 flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400/70 shrink-0" />{a}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* ── Voice Continuity Monitor ── */}
          <section aria-labelledby="voice-continuity-heading" style={{ background: 'linear-gradient(165deg,rgba(2,6,20,0.99),rgba(8,15,35,0.95))' }} className="rounded-2xl border border-slate-800/80 overflow-hidden shadow-xl">
            <div className="px-5 py-4 border-b border-slate-800/70 bg-slate-900/30 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Headphones className="w-4 h-4 text-cyan-400" />
                <h2 id="voice-continuity-heading" className="text-sm font-bold text-slate-100">Voice Continuity Monitor</h2>
              </div>
              <button
                type="button"
                onClick={() => void analyzeActiveVoiceContinuity()}
                disabled={isAnalyzingContinuity}
                style={{ boxShadow: '0 4px 14px rgba(34,211,238,0.18)' }}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-extrabold disabled:opacity-40 transition-all"
              >
                <Zap className="w-3 h-3" />
                {isAnalyzingContinuity ? 'Analyzing…' : 'Run Analysis'}
              </button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-xs leading-5 text-slate-500">
                Detect sudden changes in loudness and spectral patterns. A flag is a listening cue, not proof of editing. Does not identify speakers.
              </p>
              {voiceContinuityError && (
                <div role="alert" className="rounded-xl border border-rose-800/60 bg-rose-950/25 p-3 text-xs text-rose-200 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />{voiceContinuityError}
                </div>
              )}
              {voiceContinuity && (
                <div className="space-y-4">
                  {/* Stats pills */}
                  <div className="flex flex-wrap gap-2">
                    {[
                      { icon: <Clock className="w-3 h-3 text-cyan-400" />, text: `${voiceContinuity.durationSec.toFixed(1)}s analyzed` },
                      { icon: <Activity className="w-3 h-3 text-cyan-400" />, text: `${voiceContinuity.segments.length} segments` },
                      { icon: <ShieldAlert className={`w-3 h-3 ${voiceContinuity.transitions.length > 0 ? 'text-orange-400' : 'text-emerald-400'}`} />, text: `${voiceContinuity.transitions.length} change(s)`, highlight: voiceContinuity.transitions.length > 0 },
                    ].map((pill, i) => (
                      <div key={i} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs ${pill.highlight ? 'bg-orange-950/30 border-orange-800/50 text-orange-300' : 'bg-slate-800/50 border-slate-700/40 text-slate-300'}`}>
                        {pill.icon}<span>{pill.text}</span>
                      </div>
                    ))}
                  </div>
                  {/* Chart */}
                  <svg role="img" aria-label="Loudness chart" viewBox="0 0 1000 120" className="w-full rounded-xl border border-slate-800/60 bg-slate-950/60">
                    <defs>
                      <linearGradient id="vcBarGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.85" />
                        <stop offset="100%" stopColor="#0e7490" stopOpacity="0.3" />
                      </linearGradient>
                    </defs>
                    <line x1="0" y1="112" x2="1000" y2="112" stroke="#1e293b" strokeWidth="1" />
                    {voiceContinuity.segments.map((seg, i) => {
                      const bw = 1000 / voiceContinuity.segments.length;
                      const h = Math.max(2, Math.min(96, ((seg.loudnessDbfs + 80) / 80) * 96));
                      return <rect key={`seg-${i}`} x={i * bw} y={110 - h} width={Math.max(1, bw - 1.5)} height={h} fill="url(#vcBarGrad)" rx="1" />;
                    })}
                    {voiceContinuity.transitions.map((t) => (
                      <line key={`t-${t.timeSec}`} x1={(t.timeSec / voiceContinuity.durationSec) * 1000} y1="4" x2={(t.timeSec / voiceContinuity.durationSec) * 1000} y2="114" stroke="#fb923c" strokeWidth="2" strokeDasharray="4 2" />
                    ))}
                  </svg>
                  <div className="flex justify-between text-[10px] font-mono text-slate-700 px-1">
                    <span>0:00</span><span>{voiceContinuity.durationSec.toFixed(1)}s</span>
                  </div>
                  {voiceContinuity.transitions.length > 0 ? (
                    <ol className="max-h-52 space-y-2 overflow-y-auto pr-1">
                      {voiceContinuity.transitions.map((t) => (
                        <li key={`tn-${t.timeSec}`}>
                          <button
                            type="button"
                            onClick={() => {
                              if (!audioRef.current) return;
                              audioRef.current.currentTime = t.timeSec;
                              void audioRef.current.play().then(() => setIsPlaying(true)).catch((e: unknown) => {
                                setVoiceContinuityError(e instanceof Error ? e.message : 'Could not play audio.');
                              });
                            }}
                            className="w-full rounded-xl border border-orange-900/50 bg-orange-950/20 p-3 text-left text-xs text-orange-100 hover:border-orange-500/70 hover:bg-orange-950/35 transition-all"
                          >
                            <b className="flex items-center gap-1.5"><Play className="w-3 h-3" />{t.timeSec.toFixed(1)}s — listen here</b>
                            <span className="mt-1 block text-orange-200/65">{t.changes.join(' · ')}</span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="rounded-xl border border-emerald-900/40 bg-emerald-950/15 px-4 py-3 text-xs text-emerald-200">
                      No sudden changes exceeded review thresholds. This does not prove the recording is unedited.
                    </p>
                  )}
                  <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-950/15 border border-amber-800/25">
                    <Info className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                    <p className="text-[11px] leading-5 text-amber-200/75">Simple browser measurements, not a validated edit detector. Natural speech variation, microphone movement, AGC, or compression can all trigger flags.</p>
                  </div>
                  <button type="button" onClick={saveVoiceContinuityFinding} className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-700/60 text-xs text-slate-300 hover:border-cyan-500/50 hover:bg-slate-800/40 transition-all">
                    <Plus className="w-3.5 h-3.5 text-cyan-400" />Save observations to case report
                  </button>
                </div>
              )}
              <p className="text-[10px] text-slate-700 border-t border-slate-800/40 pt-3">Audio is analyzed in browser only; this feature does not upload the recording.</p>
            </div>
          </section>

          {/* ── TruthScan AI Audio Detection ── */}
          <section
            aria-labelledby="truthscan-ai-audio-heading"
            style={{ background: 'linear-gradient(165deg,rgba(25,8,55,0.6),rgba(2,6,20,0.98))' }}
            className="rounded-2xl border border-violet-800/50 overflow-hidden shadow-xl"
          >
            <div className="px-5 py-4 border-b border-violet-900/40 bg-violet-950/20 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2.5">
                <div className="w-7 h-7 rounded-xl bg-violet-600/25 border border-violet-500/35 flex items-center justify-center">
                  <Sparkles className="w-3.5 h-3.5 text-violet-300" />
                </div>
                <h2 id="truthscan-ai-audio-heading" className="text-sm font-bold text-slate-100">AI Audio Detection</h2>
                <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-violet-950/60 border border-violet-700/40 text-violet-300 font-bold tracking-wide">
                  TruthScan v2 · 3-Step
                </span>
                {truthscanCredits !== null && (
                  <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-emerald-950/60 border border-emerald-700/40 text-emerald-300 font-semibold flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />{truthscanCredits.toLocaleString()} Credits
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void fetchTruthScanCredits()} disabled={isLoadingCredits} className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800/60 transition-all border border-slate-700/30" title="Refresh credits">
                  <RefreshCw className={`w-3.5 h-3.5 text-violet-400 ${isLoadingCredits ? 'animate-spin' : ''}`} />
                </button>
                <button type="button" onClick={() => setShowTruthscanKeySettings(!showTruthscanKeySettings)} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-slate-700/30 transition-all">
                  <Key className="w-3.5 h-3.5 text-violet-400" />
                  {showTruthscanKeySettings ? 'Hide Key' : 'API Key Settings'}
                  {truthscanApiKey && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
                </button>
              </div>
            </div>

            <div className="p-5 space-y-4">
              <p className="text-xs leading-5 text-slate-500">Multi-stage neural deepfake &amp; synthetic voice detection via <code className="font-mono text-violet-400">detect-audio.truthscan.com</code>. Evaluates temporal speech acoustics across multi-second audio chunks.</p>

              {showTruthscanKeySettings && (
                <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-700/50 space-y-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-300 flex items-center gap-1.5"><Key className="w-3.5 h-3.5 text-violet-400" />TruthScan API Key</span>
                    <span className="text-[11px] text-slate-600">{truthscanApiKey ? 'Key stored in browser' : 'Falls back to .env TRUTHSCAN_API_KEY'}</span>
                  </div>
                  <input
                    type="password"
                    value={truthscanApiKey}
                    onChange={(e) => handleTruthscanApiKeyChange(e.target.value)}
                    placeholder="ts_live_v2_..."
                    className="w-full px-3 py-2 text-xs font-mono bg-slate-900/70 border border-slate-700 rounded-xl text-slate-200 focus:outline-none focus:border-violet-500 placeholder:text-slate-700"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
                    <p>Get your key at <a href="https://truthscan.com/account" target="_blank" rel="noopener noreferrer" className="text-violet-400 hover:text-violet-300 underline">truthscan.com/account</a>.</p>
                    {truthscanCredits !== null && <span className="font-mono text-emerald-400">Balance: <strong>{truthscanCredits.toLocaleString()}</strong> credits</span>}
                  </div>
                </div>
              )}

              <label className="flex items-start gap-2.5 cursor-pointer select-none group">
                <input type="checkbox" checked={truthscanConsent} onChange={(e) => setTruthscanConsent(e.target.checked)} className="mt-0.5 rounded border-slate-600 text-violet-600 focus:ring-violet-500 focus:ring-offset-slate-900" />
                <span className="text-xs text-slate-500 leading-5 group-hover:text-slate-400 transition-colors">I consent to transmitting this audio file to TruthScan AI Detection API for external deepfake &amp; synthetic voice screening.</span>
              </label>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void handleTruthscanAudioAnalysis(false)}
                  disabled={isTruthscanAnalyzing || !truthscanConsent}
                  style={{ background: 'linear-gradient(135deg,#6d28d9,#8b5cf6)', boxShadow: '0 4px 20px rgba(109,40,217,0.35)' }}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-white text-xs font-extrabold disabled:opacity-40 transition-all hover:opacity-90"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  {isTruthscanAnalyzing ? `${truthscanStage || 'Processing…'} (${truthscanElapsedSeconds}s)` : 'Run TruthScan Detection'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleTruthscanAudioAnalysis(true)}
                  disabled={isTruthscanAnalyzing}
                  className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-slate-800/70 hover:bg-slate-700 border border-violet-800/40 hover:border-violet-600/50 text-violet-300 text-xs font-bold transition-all"
                >
                  <Activity className="w-3.5 h-3.5 text-violet-400" />Test Sample Benchmark
                </button>
              </div>

              {truthscanError && (
                <div role="alert" className="p-4 rounded-xl border border-rose-800/50 bg-rose-950/25 space-y-3">
                  <div className="flex items-center gap-2 text-xs font-bold text-rose-300">
                    <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />Audio Detection Error
                  </div>
                  <p className="text-xs text-rose-200/75 leading-relaxed">{truthscanError}</p>
                  <div className="flex flex-wrap gap-2">
                    <a href="https://truthscan.com/account" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-violet-800/40 text-violet-300 text-xs font-semibold transition-all">
                      <Key className="w-3.5 h-3.5 text-violet-400" />Get API Key
                    </a>
                    <button type="button" onClick={() => void handleTruthscanAudioAnalysis(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-violet-700 hover:bg-violet-600 text-white text-xs font-bold transition-all">
                      <Sparkles className="w-3.5 h-3.5" />Sample Benchmark (Free)
                    </button>
                  </div>
                </div>
              )}

              {/* ── Result Card ── */}
              {truthscanResult && (
                <div style={{ background: 'linear-gradient(165deg,rgba(25,8,55,0.4),rgba(2,6,20,0.97))' }} className="rounded-2xl border border-violet-800/50 overflow-hidden">
                  {/* Verdict Banner */}
                  <div className={`px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b ${truthscanResult.rawVerdict === 'ai' ? 'bg-rose-950/25 border-rose-900/50' : 'bg-emerald-950/15 border-emerald-900/40'}`}>
                    <div className="flex flex-wrap items-center gap-3">
                      <span className={`text-sm font-extrabold px-3.5 py-1.5 rounded-full border ${truthscanResult.rawVerdict === 'ai' ? 'bg-rose-950/70 text-rose-200 border-rose-700/50' : 'bg-emerald-950/70 text-emerald-200 border-emerald-700/50'}`}>
                        {truthscanResult.rawVerdict === 'ai' ? '⚠ AI Generated Audio' : '✓ Authentic Human Voice'}
                      </span>
                      <span className="text-[10px] font-mono text-slate-600">{truthscanResult.source === 'sample_dataset' ? 'Sample Benchmark' : 'Live Scan'}</span>
                    </div>
                    <button type="button" onClick={saveTruthscanAudioFinding} style={{ boxShadow: '0 4px 14px rgba(109,40,217,0.3)' }} className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-extrabold transition-all">
                      <Plus className="w-3.5 h-3.5" />Save Finding to Case
                    </button>
                  </div>

                  <div className="p-5 space-y-5">
                    {/* Dual-tone progress bar */}
                    <div className="space-y-2">
                      <div className="flex justify-between text-xs font-extrabold font-mono">
                        <span className="text-rose-400">AI: {truthscanResult.aiScore}%</span>
                        <span className="text-slate-600">Confidence: {truthscanResult.overallAiScore.toFixed(3)}</span>
                        <span className="text-emerald-400">Human: {truthscanResult.humanScore}%</span>
                      </div>
                      <div className="h-5 w-full rounded-full bg-slate-800/60 overflow-hidden flex" style={{ boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.5)' }}>
                        <div style={{ width: `${truthscanResult.aiScore}%`, background: 'linear-gradient(90deg,#be123c,#f43f5e)' }} className="h-full transition-all duration-700 ease-out" />
                        <div style={{ width: `${truthscanResult.humanScore}%`, background: 'linear-gradient(90deg,#047857,#10b981)' }} className="h-full transition-all duration-700 ease-out" />
                      </div>
                      <div className="flex justify-between text-[10px] font-mono text-slate-700">
                        <span>← AI</span><span>Human →</span>
                      </div>
                    </div>

                    {/* Metadata grid */}
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                      {[
                        { label: 'AI Score', value: `${truthscanResult.aiScore}%`, color: 'text-rose-400' },
                        { label: 'Human Score', value: `${truthscanResult.humanScore}%`, color: 'text-emerald-400' },
                        { label: 'Duration', value: `${truthscanResult.durationSec.toFixed(1)}s`, color: 'text-cyan-400' },
                        { label: 'Chunks', value: truthscanResult.chunks?.length ? String(truthscanResult.chunks.length) : '—', color: 'text-violet-400' },
                        { label: 'MD5', value: truthscanResult.md5 ? truthscanResult.md5.slice(0,8)+'…' : '—', color: 'text-slate-400' },
                        { label: 'Scan ID', value: truthscanResult.scanId ? truthscanResult.scanId.slice(0,8)+'…' : '—', color: 'text-slate-400' },
                      ].map((m) => (
                        <div key={m.label} className="p-2.5 rounded-xl bg-slate-900/50 border border-slate-800 text-center">
                          <span className="text-[9px] text-slate-600 uppercase tracking-widest block mb-1">{m.label}</span>
                          <span className={`text-xs font-extrabold font-mono ${m.color} truncate block`} title={m.value}>{m.value}</span>
                        </div>
                      ))}
                    </div>

                    {/* Chunk timeline */}
                    {truthscanResult.chunks && truthscanResult.chunks.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                          Temporal Chunk Analysis · {truthscanResult.chunks.length} segments
                        </p>
                        <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5">
                          {truthscanResult.chunks.map((chunk) => (
                            <div
                              key={`chunk-${chunk.chunkIndex}`}
                              className={`p-2 rounded-xl border text-center ${chunk.aiScore >= 60 ? 'bg-rose-950/40 border-rose-800/50 text-rose-300' : chunk.aiScore <= 35 ? 'bg-emerald-950/40 border-emerald-800/50 text-emerald-300' : 'bg-amber-950/40 border-amber-800/50 text-amber-300'}`}
                            >
                              <span className="text-[9px] uppercase block opacity-50 mb-0.5">#{chunk.chunkIndex}</span>
                              <span className="text-xs font-extrabold font-mono">{chunk.aiScore}%</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* ── Transcription ── */}
          <div style={{ background: 'linear-gradient(165deg,rgba(2,6,20,0.99),rgba(8,15,35,0.95))' }} className="rounded-2xl border border-slate-800/80 overflow-hidden shadow-xl">
            <div className="px-5 py-4 border-b border-slate-800/70 bg-slate-900/30 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-cyan-400" />
                <span className="text-sm font-bold text-slate-100">Machine Transcription</span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800/80 border border-slate-700/40 text-slate-500">Optional</span>
              </div>
              <div className="flex items-center gap-2">
                {transcript && (
                  <>
                    <button onClick={() => copyToClipboard(transcript)} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-slate-800/70 hover:bg-slate-700 border border-slate-700/40 text-xs text-slate-300 transition-all">
                      {copiedTranscript ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-slate-500" />}
                      <span>{copiedTranscript ? 'Copied!' : 'Copy'}</span>
                    </button>
                    <button onClick={() => setTranscript('')} className="p-1.5 rounded-xl bg-slate-800/70 hover:bg-slate-700 border border-slate-700/40 text-slate-500 hover:text-slate-200 transition-all">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </>
                )}
                <button
                  onClick={handleTranscribe}
                  disabled={isTranscribing || !transcriptionConsent}
                  style={{ boxShadow: '0 4px 14px rgba(34,211,238,0.15)' }}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-extrabold transition-all disabled:opacity-50"
                >
                  <Sparkles className="w-3 h-3" />
                  {isTranscribing ? 'Transcribing…' : 'Run Transcription'}
                </button>
              </div>
            </div>
            <div className="p-5 space-y-3">
              <label className="flex items-start gap-2.5 cursor-pointer select-none group">
                <input type="checkbox" checked={transcriptionConsent} onChange={(e) => setTranscriptionConsent(e.target.checked)} className="mt-0.5 rounded" />
                <span className="text-xs text-slate-500 leading-5 group-hover:text-slate-400 transition-colors">I consent to sending this audio file to Google Gemini through the VexaLens server for transcription. This does not enable audio-authenticity detection.</span>
              </label>
              {transcribeError && (
                <div className="p-3 rounded-xl bg-rose-950/25 border border-rose-800/40 text-xs text-rose-300 flex items-center justify-between gap-2">
                  <span>{transcribeError}</span>
                  <button onClick={handleTranscribe} disabled={!transcriptionConsent} className="underline text-[11px] text-cyan-400 hover:text-cyan-300 shrink-0">Retry</button>
                </div>
              )}
              <div style={{ background: 'rgba(1,3,12,0.9)' }} className="p-4 rounded-xl border border-slate-800/50 text-xs leading-relaxed min-h-[80px] font-mono text-slate-300 whitespace-pre-wrap">
                {transcript ? transcript : isTranscribing ? (
                  <span className="flex items-center gap-2 text-cyan-400">
                    <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />Requesting transcript from server model…
                  </span>
                ) : (
                  <span className="text-slate-700">Transcription requires GEMINI_API_KEY on the server. No fallback transcript is generated.</span>
                )}
              </div>
            </div>
          </div>

        </div>

        {/* RIGHT COL */}
        <div className="space-y-4">
          {/* Acoustic Parameters */}
          <div style={{ background: 'linear-gradient(165deg,rgba(2,6,20,0.99),rgba(8,15,35,0.95))' }} className="rounded-2xl border border-slate-800/80 overflow-hidden shadow-xl">
            <div className="px-4 py-3.5 border-b border-slate-800/70 bg-slate-900/30 flex items-center gap-2">
              <Activity className="w-3.5 h-3.5 text-cyan-400" />
              <span className="text-xs font-extrabold text-slate-200 uppercase tracking-widest">Acoustic Parameters</span>
            </div>
            <div className="p-4">
              {report ? (
                <div className="divide-y divide-slate-800/50">
                  {[
                    { label: 'Sample Rate', value: `${report.sampleRateHz.toLocaleString()} Hz` },
                    { label: 'Channels', value: report.channels === 1 ? 'Mono' : 'Stereo' },
                    { label: 'Nyquist Limit', value: `${report.nyquistHz.toLocaleString()} Hz` },
                    { label: 'RMS Loudness', value: `${report.rmsDbfs} dBFS` },
                    { label: 'Peak Level', value: `${report.peakDbfs} dBFS` },
                    { label: 'Clipping Events', value: String(report.clippingCount), warn: report.clippingCount > 0 },
                    { label: 'Silence Ratio', value: `${report.silenceRatioPercent}%` },
                    { label: 'Duration', value: `${report.durationSec.toFixed(2)}s` },
                  ].map((row) => (
                    <div key={row.label} className="flex items-center justify-between py-2.5 text-xs">
                      <span className="text-slate-500">{row.label}</span>
                      <span className={`font-mono font-semibold ${row.warn ? 'text-rose-400' : 'text-slate-200'}`}>{row.value}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3 py-8">
                  <div className="w-8 h-8 rounded-full border-2 border-cyan-500/30 border-t-cyan-400 animate-spin" />
                  <span className="text-xs text-slate-600">Decoding audio buffer…</span>
                </div>
              )}
            </div>
          </div>

          {/* TruthScan Credit Sidebar Widget */}
          {truthscanCredits !== null && (
            <div style={{ background: 'linear-gradient(135deg,rgba(25,8,55,0.6),rgba(2,6,20,0.97))', boxShadow: '0 0 30px rgba(109,40,217,0.12)' }} className="p-4 rounded-2xl border border-violet-800/40 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Zap className="w-3.5 h-3.5 text-violet-400" />
                  <span className="text-xs font-bold text-violet-300">TruthScan Credits</span>
                </div>
                <button type="button" onClick={() => void fetchTruthScanCredits()} disabled={isLoadingCredits} className="text-violet-600 hover:text-violet-400 transition-colors">
                  <RefreshCw className={`w-3 h-3 ${isLoadingCredits ? 'animate-spin' : ''}`} />
                </button>
              </div>
              <div className="text-3xl font-extrabold font-mono text-violet-100">{truthscanCredits.toLocaleString()}</div>
              <div className="h-2 rounded-full bg-violet-900/40 overflow-hidden">
                <div style={{ width: `${Math.min(100, (truthscanCredits / 25000) * 100)}%`, background: 'linear-gradient(90deg,#6d28d9,#a78bfa)' }} className="h-full rounded-full transition-all duration-700" />
              </div>
              <p className="text-[10px] text-violet-600 font-mono">of 25,000 base credits</p>
            </div>
          )}

          {/* Analysis Scope */}
          <div className="p-4 rounded-2xl bg-slate-900/30 border border-slate-800/50 space-y-2">
            <div className="flex items-center gap-2">
              <Info className="w-3.5 h-3.5 text-slate-500" />
              <span className="text-xs font-bold text-slate-400">Analysis Scope</span>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-600">Browser waveform measurements are descriptive. Optional transcription is machine-generated text only; TruthScan provides AI detection via external API.</p>
          </div>
        </div>
      </div>

      {/* ── Audio Environment Fingerprint (Full Width) ── */}
      <section
        aria-labelledby="environment-fingerprint-heading"
        style={{ background: 'linear-gradient(165deg,rgba(2,6,20,0.99),rgba(8,15,35,0.95))' }}
        className="rounded-2xl border border-slate-800/80 overflow-hidden shadow-xl"
      >
        <div className="px-5 py-4 border-b border-slate-800/70 bg-slate-900/30 flex items-center gap-2">
          <Radio className="w-4 h-4 text-cyan-400" />
          <h2 id="environment-fingerprint-heading" className="text-sm font-bold text-slate-100">Audio Environment Fingerprint</h2>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-xs leading-5 text-slate-500">Compare background sound, frequency patterns, and sound-fade across two recordings. Similar features suggest a closer look, but do not prove a shared location.</p>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <label className="block space-y-1.5 text-xs text-slate-500">
              <span className="font-semibold text-slate-400">First recording</span>
              <select value={environmentItemA} onChange={(e) => { setEnvironmentItemA(e.target.value); setEnvironmentFingerprintA(null); setEnvironmentFingerprintB(null); }} className="w-full bg-slate-950/70 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-cyan-500">
                {comparisonItems.map((item) => <option key={item.id} value={item.id}>{item.fileName}</option>)}
              </select>
            </label>
            <label className="block space-y-1.5 text-xs text-slate-500">
              <span className="font-semibold text-slate-400">Second recording</span>
              <select value={environmentItemB} onChange={(e) => { setEnvironmentItemB(e.target.value); setEnvironmentFingerprintA(null); setEnvironmentFingerprintB(null); }} className="w-full bg-slate-950/70 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-cyan-500">
                <option value="">Choose another recording</option>
                {comparisonItems.filter((i) => i.id !== environmentItemA).map((i) => <option key={i.id} value={i.id}>{i.fileName}</option>)}
              </select>
            </label>
            <button type="button" onClick={() => void compareRecordingEnvironments()} disabled={isComparingEnvironment || !environmentItemA || !environmentItemB || comparisonItems.length < 2} style={{ boxShadow: '0 4px 14px rgba(34,211,238,0.15)' }} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-sm font-extrabold disabled:opacity-40 transition-all">
              <Activity className="w-3.5 h-3.5" />{isComparingEnvironment ? 'Comparing…' : 'Compare'}
            </button>
          </div>
          {comparisonItems.length < 2 && <p className="text-xs text-slate-600">Add at least two audio recordings to this case to enable comparison.</p>}
          {environmentError && (
            <div role="alert" className="rounded-xl border border-rose-800/50 bg-rose-950/20 px-4 py-3 text-xs text-rose-200 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />{environmentError}
            </div>
          )}
          {environmentFingerprintA && environmentFingerprintB && (
            <div className="space-y-4">
              <div className="overflow-x-auto rounded-xl border border-slate-800/60">
                <table className="w-full min-w-[560px] text-left text-xs">
                  <thead className="bg-slate-950/60 text-slate-500">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Sound Feature</th>
                      <th className="px-4 py-3 font-semibold text-cyan-500">{comparisonItems.find((i) => i.id === environmentItemA)?.fileName}</th>
                      <th className="px-4 py-3 font-semibold text-violet-400">{comparisonItems.find((i) => i.id === environmentItemB)?.fileName}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/40">
                    {[
                      { label: 'Quiet-section level', a: `${environmentFingerprintA.noiseFloorDbfs} dBFS`, b: `${environmentFingerprintB.noiseFloorDbfs} dBFS` },
                      { label: 'Low-frequency energy', a: `${environmentFingerprintA.lowBandPercent}%`, b: `${environmentFingerprintB.lowBandPercent}%` },
                      { label: 'Mid-frequency energy', a: `${environmentFingerprintA.midBandPercent}%`, b: `${environmentFingerprintB.midBandPercent}%` },
                      { label: 'High-frequency energy', a: `${environmentFingerprintA.highBandPercent}%`, b: `${environmentFingerprintB.highBandPercent}%` },
                      { label: 'Sound fade after peak', a: environmentFingerprintA.decayProxyMs === null ? 'Not measured' : `${environmentFingerprintA.decayProxyMs} ms`, b: environmentFingerprintB.decayProxyMs === null ? 'Not measured' : `${environmentFingerprintB.decayProxyMs} ms` },
                    ].map((row) => (
                      <tr key={row.label} className="hover:bg-slate-900/30 transition-colors">
                        <td className="px-4 py-3 font-medium text-slate-400">{row.label}</td>
                        <td className="px-4 py-3 font-mono text-slate-200">{row.a}</td>
                        <td className="px-4 py-3 font-mono text-slate-200">{row.b}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="rounded-xl border border-cyan-900/40 bg-cyan-950/10 p-4 space-y-1">
                <h3 className="text-xs font-bold text-cyan-300">Observation Summary</h3>
                <p className="text-xs leading-5 text-slate-300">
                  {summarizeAudioEnvironmentComparison(
                    comparisonItems.find((i) => i.id === environmentItemA)?.fileName ?? 'First recording',
                    environmentFingerprintA,
                    comparisonItems.find((i) => i.id === environmentItemB)?.fileName ?? 'Second recording',
                    environmentFingerprintB
                  )}
                </p>
              </div>
              <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-950/15 border border-amber-800/25">
                <Info className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                <p className="text-[11px] leading-5 text-amber-200/70">Feature comparison only — not a room or location match. Microphones, distance, compression, and recording settings all affect results.</p>
              </div>
              <button type="button" onClick={saveEnvironmentComparison} className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-700/50 text-xs text-slate-300 hover:border-cyan-500/40 hover:bg-slate-800/40 transition-all">
                <Plus className="w-3.5 h-3.5 text-cyan-400" />Save comparison as a case finding
              </button>
            </div>
          )}
          <p className="text-[10px] text-slate-700 border-t border-slate-800/40 pt-3">Audio is analyzed in browser only. The comparison does not upload the recordings.</p>
        </div>
      </section>
    </div>
  );
};
