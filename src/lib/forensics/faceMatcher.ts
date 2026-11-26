import { PhotoToVideoMatchResult, CandidateFaceMatch, FaceMatchConclusion } from '@/types/forensics';

/**
 * VexaLens Photo-to-Video Match Engine (v3.0)
 *
 * Architecture:
 * - Frame extraction: browser Canvas (client-side, zero-latency)
 * - Face detection, cartoon discrimination & biometric matching: Python FastAPI backend
 *   (OpenCV Haar cascades + 128-D LBP/HOG embeddings, cartoon vs human discrimination)
 *
 * Cartoons are NEVER treated as matching real human faces.
 * Visual similarity is an investigative lead, NOT legal identity proof.
 */

export interface DetectedFaceRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  cropDataUrl: string;
  embedding: number[];
  confidence: number;
  isCartoon: boolean;
  cartoonReason?: string;
  eyeCount: number;
  landmarks: {
    leftEye: { x: number; y: number };
    rightEye: { x: number; y: number };
    noseTip: { x: number; y: number };
    mouthCenter: { x: number; y: number };
  };
}

/** Calls Python backend to detect a real human face and discriminate cartoons. */
export async function detectFaceInImage(
  source: string | HTMLImageElement | HTMLCanvasElement
): Promise<DetectedFaceRegion | null> {
  const base64 = await imageSourceToBase64(source);
  try {
    const resp = await fetch('/api/face-match/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: base64 }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.detected || !data.face) return null;
    const f = data.face;
    return {
      x: f.x, y: f.y, width: f.width, height: f.height,
      cropDataUrl: f.crop_data_url,
      embedding: f.embedding,
      confidence: f.confidence,
      isCartoon: f.is_cartoon ?? false,
      cartoonReason: f.cartoon_reason ?? undefined,
      eyeCount: f.eye_count ?? 0,
      landmarks: {
        leftEye: { x: 38, y: 44 }, rightEye: { x: 74, y: 44 },
        noseTip: { x: 56, y: 64 }, mouthCenter: { x: 56, y: 88 },
      },
    };
  } catch {
    return null;
  }
}

export async function matchPhotoAgainstVideoFrames(
  referenceImage: string | HTMLImageElement,
  videoElement: HTMLVideoElement,
  options: {
    samplingIntervalSec?: number;
    similarityThreshold?: number;
    maxFrames?: number;
    onProgress?: (progressPercent: number, frame: number) => void;
  } = {}
): Promise<PhotoToVideoMatchResult> {
  const threshold = options.similarityThreshold ?? 0.68;
  const interval = options.samplingIntervalSec ?? 0.5;
  const maxFrames = options.maxFrames ?? 30;

  const refBase64 = await imageSourceToBase64(referenceImage);

  const duration =
    Number.isFinite(videoElement.duration) && videoElement.duration > 0
      ? videoElement.duration
      : 10;

  const sampleTimestamps: number[] = [];
  for (let t = 0.2; t < duration && sampleTimestamps.length < maxFrames; t += interval) {
    sampleTimestamps.push(t);
  }

  if (sampleTimestamps.length === 0) {
    return buildErrorResult(
      'Video stream duration was zero or unreadable; no keyframes could be extracted.',
      'Video ki avadhi shunya ya apaThaniiya thi.',
      threshold
    );
  }

  const captureCanvas = document.createElement('canvas');
  captureCanvas.width = videoElement.videoWidth || 640;
  captureCanvas.height = videoElement.videoHeight || 360;
  const captureCtx = captureCanvas.getContext('2d');

  const candidateFrames: { timestamp: string; frame_number: number; image_base64: string }[] = [];

  for (let i = 0; i < sampleTimestamps.length; i++) {
    const t = sampleTimestamps[i];
    await seekVideoToTime(videoElement, t);
    if (captureCtx) {
      captureCtx.drawImage(videoElement, 0, 0, captureCanvas.width, captureCanvas.height);
      const frameBase64 = captureCanvas.toDataURL('image/jpeg', 0.82);
      const mm = Math.floor(t / 60).toString().padStart(2, '0');
      const ss = Math.floor(t % 60).toString().padStart(2, '0');
      const ms = Math.floor((t % 1) * 1000).toString().padStart(3, '0');
      candidateFrames.push({
        timestamp: mm + ':' + ss + '.' + ms,
        frame_number: i + 1,
        image_base64: frameBase64,
      });
    }
    options.onProgress?.(Math.round(((i + 1) / sampleTimestamps.length) * 60), i + 1);
  }

  // Send all frames to Python backend for genuine biometric comparison
  let backendResult: any = null;
  try {
    const resp = await fetch('/api/face-match/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reference_image_base64: refBase64,
        candidate_frames: candidateFrames,
        similarity_threshold: threshold,
        cadence_sec: interval,
      }),
    });
    options.onProgress?.(90, sampleTimestamps.length);
    if (resp.ok) {
      backendResult = await resp.json();
    }
  } catch {
    // Backend not running — return service_unavailable gracefully
    return {
      referenceFaceCropUrl: '',
      videoFileName: videoElement.title || 'Investigative_Video_Evidence',
      framesSampled: candidateFrames.length,
      candidateMatches: [],
      bestSimilarityScore: 0,
      thresholdApplied: threshold,
      conclusion: 'service_unavailable' as FaceMatchConclusion,
      explanation:
        'Python facial biometric service is unavailable. Check the backend service health.',
      hindiExplanation:
        'Python facial backend offline hai. FastAPI server shuru karein.',
      consentNoticeAcknowledged: true,
      biometricRetentionDisclaimer:
        'Biometric feature vectors are generated in ephemeral memory for this session only.',
    };
  }

  options.onProgress?.(100, sampleTimestamps.length);

  if (!backendResult) {
    return buildErrorResult(
      'Backend returned an invalid response.',
      'Backend se galat response mila.',
      threshold
    );
  }

  // Map backend response to PhotoToVideoMatchResult
  const rawCandidates: CandidateFaceMatch[] = (backendResult.candidateMatches ?? []).map(
    (c: any, idx: number): CandidateFaceMatch => ({
      timestamp: c.timestamp ?? '--:--',
      frameNumber: c.frame_number ?? idx + 1,
      similarityScore: Math.round((c.facial_similarity ?? c.similarityScore ?? 0) * 1000) / 1000,
      candidateCropUrl: c.candidateCropUrl ?? '',
      eyeSpacingSimilarity: 0,
      facialGeometryScore: Math.round((c.facial_similarity ?? 0) * 100) / 100,
    })
  );
  rawCandidates.sort((a, b) => b.similarityScore - a.similarityScore);

  return {
    referenceFaceCropUrl:
      backendResult.referenceFaceCropUrl ?? backendResult.reference_crop_url ?? '',
    videoFileName: videoElement.title || 'Investigative_Video_Evidence',
    framesSampled:
      backendResult.framesSampled ?? backendResult.frames_sampled ?? candidateFrames.length,
    candidateMatches: rawCandidates,
    bestSimilarityScore:
      backendResult.bestSimilarityScore ?? backendResult.best_facial_similarity ?? 0,
    thresholdApplied: backendResult.thresholdApplied ?? threshold,
    conclusion: (backendResult.conclusion ?? 'no_match_above_threshold') as FaceMatchConclusion,
    explanation: backendResult.explanation ?? '',
    hindiExplanation: backendResult.hindiExplanation ?? '',
    consentNoticeAcknowledged: true,
    biometricRetentionDisclaimer:
      backendResult.biometricRetentionDisclaimer ??
      'Biometric feature vectors are generated in ephemeral memory for this session only.',
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildErrorResult(
  explanation: string,
  hindi: string,
  threshold: number
): PhotoToVideoMatchResult {
  return {
    referenceFaceCropUrl: '',
    videoFileName: 'Investigative_Video_Evidence',
    framesSampled: 0,
    candidateMatches: [],
    bestSimilarityScore: 0,
    thresholdApplied: threshold,
    conclusion: 'inconclusive',
    explanation,
    hindiExplanation: hindi,
    consentNoticeAcknowledged: true,
    biometricRetentionDisclaimer:
      'Biometric feature vectors are generated in ephemeral memory for this session only.',
  };
}

async function imageSourceToBase64(
  source: string | HTMLImageElement | HTMLCanvasElement
): Promise<string> {
  if (typeof source === 'string') {
    if (source.startsWith('data:')) return source;
    try {
      const resp = await fetch(source);
      const blob = await resp.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch {
      return source;
    }
  } else if (source instanceof HTMLCanvasElement) {
    return source.toDataURL('image/jpeg', 0.92);
  } else {
    // HTMLImageElement
    const canvas = document.createElement('canvas');
    canvas.width = source.naturalWidth || source.width || 320;
    canvas.height = source.naturalHeight || source.height || 320;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.drawImage(source, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.92);
  }
}

function seekVideoToTime(video: HTMLVideoElement, timeSec: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 3000); // guard against stalled seeks
    const onSeeked = () => {
      clearTimeout(timeout);
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = Math.min(video.duration || 100, Math.max(0, timeSec));
  });
}
