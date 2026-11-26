import type { FaceLandmarker, NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { MicVAD } from '@ricky0123/vad-web';

export interface ActivitySample {
  timeSec: number;
  audioRms: number;
  speechScore: number;
  mouthApertureRatio: number | null;
  faceTracked: boolean;
}

export interface ActivityComparison {
  correlation: number | null;
  visualLagSec: number | null;
  sampleCount: number;
}

export interface MouthMotionSummary {
  trackedSamples: number;
  totalSamples: number;
  trackingPercent: number;
  apertureRange: number | null;
}

export interface SpeechSegment {
  startSeconds: number;
  endSeconds: number;
}

export interface SpeechProbabilitySample {
  timeSec: number;
  score: number;
}

export interface LipSyncActivityReport {
  durationSec: number;
  analyzedDurationSec: number;
  width: number;
  height: number;
  sampleIntervalSec: number;
  samples: ActivitySample[];
  speechSegments: SpeechSegment[];
  faceFramesDetected: number;
  audioSignalDetected: boolean;
  speechDetector: string;
  mouthLandmarkModel: string;
  comparison: ActivityComparison;
}

export interface NormalizedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MAX_ANALYSIS_SECONDS = 60;
const MIN_ANALYSIS_SECONDS = 4;
const SAMPLE_INTERVAL_SECONDS = 0.1;
const SPEECH_FRAME_SECONDS = 512 / 16000;

const FACE_LANDMARKER_URL = '/models/lipsync/face_landmarker.task';
const MEDIAPIPE_WASM_URL = '/models/lipsync/mediapipe/wasm/';
const VAD_ASSET_URL = '/models/lipsync/vad/';
const ONNX_RUNTIME_URL = '/models/lipsync/onnxruntime/';

type MouthPoint = Pick<NormalizedLandmark, 'x' | 'y'>;

export function compareActivitySignals(
  audio: Array<number | null>,
  visual: Array<number | null>,
  sampleIntervalSec: number,
  maxLagSamples = 4
): ActivityComparison {
  let bestCorrelation: number | null = null;
  let bestLag = 0;
  let bestCount = 0;

  for (let lag = -maxLagSamples; lag <= maxLagSamples; lag++) {
    const audioValues: number[] = [];
    const visualValues: number[] = [];

    for (let index = 0; index < audio.length; index++) {
      const visualIndex = index + lag;
      if (visualIndex < 0 || visualIndex >= visual.length) continue;
      const audioValue = audio[index];
      const visualValue = visual[visualIndex];
      if (
        audioValue === null ||
        visualValue === null ||
        !Number.isFinite(audioValue) ||
        !Number.isFinite(visualValue)
      ) continue;
      audioValues.push(audioValue);
      visualValues.push(visualValue);
    }

    if (audioValues.length < 8) continue;
    const audioMean = audioValues.reduce((sum, value) => sum + value, 0) / audioValues.length;
    const visualMean = visualValues.reduce((sum, value) => sum + value, 0) / visualValues.length;
    let covariance = 0;
    let audioVariance = 0;
    let visualVariance = 0;

    for (let index = 0; index < audioValues.length; index++) {
      const audioDelta = audioValues[index] - audioMean;
      const visualDelta = visualValues[index] - visualMean;
      covariance += audioDelta * visualDelta;
      audioVariance += audioDelta * audioDelta;
      visualVariance += visualDelta * visualDelta;
    }

    if (audioVariance === 0 || visualVariance === 0) continue;
    const correlation = covariance / Math.sqrt(audioVariance * visualVariance);
    if (bestCorrelation === null || correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
      bestCount = audioValues.length;
    }
  }

  return {
    correlation: bestCorrelation === null ? null : Math.round(bestCorrelation * 1000) / 1000,
    visualLagSec: bestCorrelation === null ? null : Math.round(bestLag * sampleIntervalSec * 100) / 100,
    sampleCount: bestCount,
  };
}

export function calculateMouthApertureRatio(landmarks: readonly MouthPoint[]): number | null {
  const upperLip = landmarks[13];
  const lowerLip = landmarks[14];
  const leftCorner = landmarks[61];
  const rightCorner = landmarks[291];
  if (!upperLip || !lowerLip || !leftCorner || !rightCorner) return null;

  const mouthWidth = Math.hypot(rightCorner.x - leftCorner.x, rightCorner.y - leftCorner.y);
  const mouthOpening = Math.hypot(lowerLip.x - upperLip.x, lowerLip.y - upperLip.y);
  if (
    !Number.isFinite(mouthWidth) ||
    !Number.isFinite(mouthOpening) ||
    mouthWidth <= Number.EPSILON
  ) return null;
  return mouthOpening / mouthWidth;
}

export function summarizeMouthMotion(samples: readonly ActivitySample[]): MouthMotionSummary {
  const measuredApertures = samples
    .map((sample) => sample.mouthApertureRatio)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const trackedSamples = measuredApertures.length;
  const apertureRange = trackedSamples === 0
    ? null
    : Math.max(...measuredApertures) - Math.min(...measuredApertures);
  return {
    trackedSamples,
    totalSamples: samples.length,
    trackingPercent: samples.length === 0 ? 0 : Math.round(trackedSamples / samples.length * 100),
    apertureRange,
  };
}

export function extractSpeechSegments(
  samples: readonly SpeechProbabilitySample[],
  maxSilenceSeconds = 0.2,
  minSpeechSeconds = 0.1,
): SpeechSegment[] {
  const orderedSamples = samples
    .filter((sample) => Number.isFinite(sample.timeSec) && Number.isFinite(sample.score))
    .slice()
    .sort((left, right) => left.timeSec - right.timeSec);
  const segments: SpeechSegment[] = [];
  let segmentStart: number | null = null;
  let lastSpeechTime = 0;

  const finishSegment = () => {
    if (segmentStart === null) return;
    const endSeconds = lastSpeechTime + SPEECH_FRAME_SECONDS;
    if (endSeconds - segmentStart >= minSpeechSeconds) {
      segments.push({ startSeconds: segmentStart, endSeconds });
    }
    segmentStart = null;
  };

  for (const sample of orderedSamples) {
    if (segmentStart === null) {
      if (sample.score >= 0.5) {
        segmentStart = sample.timeSec;
        lastSpeechTime = sample.timeSec;
      }
      continue;
    }

    if (sample.score >= 0.35) {
      lastSpeechTime = sample.timeSec;
    } else if (sample.timeSec - lastSpeechTime > maxSilenceSeconds) {
      finishSegment();
    }
  }
  finishSegment();

  return segments;
}

function validateRegion(region: NormalizedRegion): void {
  const valid = [region.x, region.y, region.width, region.height].every(Number.isFinite);
  if (!valid || region.width <= 0 || region.height <= 0 || region.x < 0 || region.y < 0 ||
      region.x + region.width > 1 || region.y + region.height > 1) {
    throw new Error('Select a visual region fully inside the video frame.');
  }
}

function waitForEvent(target: EventTarget, eventName: string, timeoutMs: number): Promise<void> {
  const media = target as HTMLMediaElement;
  if (
    (eventName === 'loadedmetadata' && media.readyState >= HTMLMediaElement.HAVE_METADATA) ||
    (eventName === 'loadeddata' && media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)
  ) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      target.removeEventListener(eventName, onEvent);
      target.removeEventListener('error', onError);
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out while decoding video (${eventName}).`));
    }, timeoutMs);
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('The selected video could not be decoded by this browser.'));
    };
    target.addEventListener(eventName, onEvent, { once: true });
    if (eventName !== 'error') target.addEventListener('error', onError, { once: true });
  });
}

export async function analyzeLipSyncActivity(
  videoSourceUrl: string,
  region: NormalizedRegion
): Promise<LipSyncActivityReport> {
  validateRegion(region);
  if (!videoSourceUrl) throw new Error('No video source is available for analysis.');
  const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) throw new Error('Web Audio API is not available in this browser.');

  const audioContext = new AudioContextClass();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  const audioCapture = audioContext.createMediaStreamDestination();
  const audioSource = videoSourceUrl;
  const video = document.createElement('video');
  video.preload = 'auto';
  video.playsInline = true;
  video.crossOrigin = 'anonymous';
  let mediaSource: MediaElementAudioSourceNode | undefined;
  let faceLandmarker: FaceLandmarker | undefined;
  let vad: MicVAD | undefined;

  try {
    const metadataReady = waitForEvent(video, 'loadedmetadata', 15000);
    const frameReady = waitForEvent(video, 'loadeddata', 15000);
    video.src = audioSource;
    await Promise.all([metadataReady, frameReady]);

    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.videoWidth <= 0 || video.videoHeight <= 0) {
      throw new Error('The video duration or frame dimensions could not be read.');
    }

    const analyzedDurationSec = Math.min(video.duration, MAX_ANALYSIS_SECONDS);
    if (analyzedDurationSec < MIN_ANALYSIS_SECONDS) {
      throw new Error('At least four seconds of decodable video are required for timing comparison.');
    }

    mediaSource = audioContext.createMediaElementSource(video);
    mediaSource.connect(analyser);
    mediaSource.connect(audioCapture);
    await audioContext.resume();

    const [{ FaceLandmarker, FilesetResolver }, { MicVAD }] = await Promise.all([
      import('@mediapipe/tasks-vision'),
      import('@ricky0123/vad-web'),
    ]);
    const visionFileset = await FilesetResolver.forVisionTasks(
      new URL(MEDIAPIPE_WASM_URL, window.location.origin).toString(),
    );
    faceLandmarker = await FaceLandmarker.createFromOptions(visionFileset, {
      baseOptions: {
        modelAssetPath: new URL(FACE_LANDMARKER_URL, window.location.origin).toString(),
        delegate: 'CPU',
      },
      runningMode: 'IMAGE',
      numFaces: 5,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });

    const speechFrames: SpeechProbabilitySample[] = [];
    let speechSamplesProcessed = 0;
    let speechTimelineOffsetSec = 0;
    let playbackStarted = false;
    vad = await MicVAD.new({
      model: 'v5',
      baseAssetPath: new URL(VAD_ASSET_URL, window.location.origin).toString(),
      onnxWASMBasePath: new URL(ONNX_RUNTIME_URL, window.location.origin).toString(),
      audioContext,
      getStream: async () => audioCapture.stream,
      startOnLoad: false,
      processorType: 'auto',
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
      redemptionMs: 200,
      preSpeechPadMs: 100,
      minSpeechMs: 100,
      submitUserSpeechOnPause: true,
      onFrameProcessed: ({ isSpeech }, frame) => {
        if (!playbackStarted || !Number.isFinite(video.currentTime)) return;
        const timeSec = speechTimelineOffsetSec + speechSamplesProcessed / 16000;
        speechSamplesProcessed += frame.length;
        if (timeSec > analyzedDurationSec) return;
        speechFrames.push({ timeSec, score: isSpeech });
      },
    });
    await vad.start();

    try {
      await video.play();
    } catch {
      throw new Error('The browser could not start synchronized audio/video decoding. Press Analyze from the page and retry.');
    }
    speechSamplesProcessed = 0;
    speechTimelineOffsetSec = video.currentTime;
    playbackStarted = true;

    const count = Math.floor(analyzedDurationSec / SAMPLE_INTERVAL_SECONDS) + 1;
    const samples: ActivitySample[] = [];
    const audioWaveform = new Float32Array(analyser.fftSize);

    for (let index = 0; index < count; index++) {
      const targetTime = Math.min(index * SAMPLE_INTERVAL_SECONDS, analyzedDurationSec);
      while (!video.ended && video.currentTime + 0.02 < targetTime) {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      }
      if (video.ended && video.currentTime < targetTime - SAMPLE_INTERVAL_SECONDS) break;
      const timeSec = Math.min(video.currentTime, analyzedDurationSec);
      if (!faceLandmarker) throw new Error('The local mouth-landmark model did not initialize.');
      const landmarkResult = faceLandmarker.detect(video);
      let mouthApertureRatio: number | null = null;
      for (const landmarks of landmarkResult.faceLandmarks) {
        const ratio = calculateMouthApertureRatio(landmarks);
        if (ratio === null) continue;
        const mouthCenterX = (landmarks[13].x + landmarks[14].x + landmarks[61].x + landmarks[291].x) / 4;
        const mouthCenterY = (landmarks[13].y + landmarks[14].y + landmarks[61].y + landmarks[291].y) / 4;
        if (
          mouthCenterX >= region.x &&
          mouthCenterX <= region.x + region.width &&
          mouthCenterY >= region.y &&
          mouthCenterY <= region.y + region.height
        ) {
          mouthApertureRatio = ratio;
          break;
        }
      }
      analyser.getFloatTimeDomainData(audioWaveform);
      const audioRms = Math.sqrt(
        audioWaveform.reduce((sum, sample) => sum + sample * sample, 0) / audioWaveform.length
      );
      let speechScore = 0;
      let closestSpeechDistance = Number.POSITIVE_INFINITY;
      for (const speechFrame of speechFrames) {
        const distance = Math.abs(speechFrame.timeSec - timeSec);
        if (distance < closestSpeechDistance) {
          closestSpeechDistance = distance;
          speechScore = speechFrame.score;
        }
      }
      if (closestSpeechDistance > SAMPLE_INTERVAL_SECONDS * 2) speechScore = 0;
      samples.push({
        timeSec,
        audioRms,
        speechScore,
        mouthApertureRatio,
        faceTracked: mouthApertureRatio !== null,
      });
    }
    video.pause();

    if (samples.length < 8) {
      throw new Error('The browser ended playback before enough synchronized samples could be collected.');
    }

    await vad.pause();
    await vad.destroy();
    vad = undefined;

    const comparison = compareActivitySignals(
      samples.map((sample) => sample.speechScore),
      samples.map((sample) => sample.mouthApertureRatio),
      SAMPLE_INTERVAL_SECONDS,
      Math.round(1 / SAMPLE_INTERVAL_SECONDS),
    );

    return {
      durationSec: video.duration,
      analyzedDurationSec: samples[samples.length - 1].timeSec,
      width: video.videoWidth,
      height: video.videoHeight,
      sampleIntervalSec: SAMPLE_INTERVAL_SECONDS,
      samples,
      speechSegments: extractSpeechSegments(speechFrames),
      faceFramesDetected: samples.filter((sample) => sample.faceTracked).length,
      audioSignalDetected: samples.some((sample) => sample.audioRms > 0.00001),
      speechDetector: 'Silero VAD v5 (on-device)',
      mouthLandmarkModel: 'MediaPipe Face Landmarker (on-device)',
      comparison,
    };
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    mediaSource?.disconnect();
    analyser.disconnect();
    audioCapture.disconnect();
    faceLandmarker?.close();
    if (vad) await vad.destroy();
    await audioContext.close();
  }
}
