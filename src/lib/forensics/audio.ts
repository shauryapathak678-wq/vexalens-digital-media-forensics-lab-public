/**
 * Audio Signal and Forensic Acoustics Processing Engine
 * Leverages Web Audio API for waveform rendering, frequency spectrum, clipping detection, and dynamic range
 */

export interface AudioForensicReport {
  durationSec: number;
  sampleRateHz: number;
  channels: number;
  rmsDbfs: number;
  peakDbfs: number;
  clippingCount: number;
  silenceRatioPercent: number;
  nyquistHz: number;
  waveformPeaks: Float32Array[];
  spectralAnomalies: string[];
}

export interface AudioEnvironmentFingerprint {
  durationSec: number;
  sampleRateHz: number;
  noiseFloorDbfs: number;
  lowBandPercent: number;
  midBandPercent: number;
  highBandPercent: number;
  decayProxyMs: number | null;
}

export interface VoiceContinuitySegment {
  startSec: number;
  endSec: number;
  loudnessDbfs: number;
  lowBandPercent: number;
  midBandPercent: number;
  highBandPercent: number;
  zeroCrossingRate: number;
}

export interface VoiceContinuityTransition {
  timeSec: number;
  changes: string[];
  loudnessChangeDb: number;
  spectralChangePercent: number;
  zeroCrossingChange: number;
}

export interface VoiceContinuityReport {
  durationSec: number;
  segments: VoiceContinuitySegment[];
  transitions: VoiceContinuityTransition[];
}

function calculateAudioBandPowers(samples: Float64Array, sampleRate: number): [number, number, number] {
  const size = samples.length;
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  real.set(samples);
  let reversed = 0;
  for (let index = 0; index < size; index += 1) {
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
    }
    let bit = size >> 1;
    while (bit > 0 && (reversed & bit) !== 0) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let offset = 0; offset < size; offset += length) {
      let factorReal = 1;
      let factorImaginary = 0;
      const halfLength = length >> 1;
      for (let index = 0; index < halfLength; index += 1) {
        const even = offset + index;
        const odd = even + halfLength;
        const oddReal = real[odd] * factorReal - imaginary[odd] * factorImaginary;
        const oddImaginary = real[odd] * factorImaginary + imaginary[odd] * factorReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = factorReal * stepReal - factorImaginary * stepImaginary;
        factorImaginary = factorReal * stepImaginary + factorImaginary * stepReal;
        factorReal = nextReal;
      }
    }
  }
  const powers: [number, number, number] = [0, 0, 0];
  for (let bin = 1; bin < size / 2; bin += 1) {
    const frequency = (bin * sampleRate) / size;
    const band = frequency < 300 ? 0 : frequency < 2000 ? 1 : 2;
    powers[band] += real[bin] ** 2 + imaginary[bin] ** 2;
  }
  return powers;
}

export function findVoiceContinuityTransitions(
  segments: VoiceContinuitySegment[]
): VoiceContinuityTransition[] {
  const transitions: VoiceContinuityTransition[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    const loudnessChangeDb = Math.abs(current.loudnessDbfs - previous.loudnessDbfs);
    const spectralChangePercent = (
      Math.abs(current.lowBandPercent - previous.lowBandPercent) +
      Math.abs(current.midBandPercent - previous.midBandPercent) +
      Math.abs(current.highBandPercent - previous.highBandPercent)
    ) / 2;
    const zeroCrossingChange = Math.abs(current.zeroCrossingRate - previous.zeroCrossingRate);
    const changes: string[] = [];
    if (loudnessChangeDb >= 10) changes.push(`Loudness changed by ${loudnessChangeDb.toFixed(1)} dB`);
    if (spectralChangePercent >= 22) changes.push(`Sound-frequency balance shifted by about ${spectralChangePercent.toFixed(0)} percentage points`);
    if (zeroCrossingChange >= 0.12) changes.push(`The rapid up/down movement in the sound changed by ${zeroCrossingChange.toFixed(2)}`);
    if (changes.length) {
      transitions.push({
        timeSec: current.startSec,
        changes,
        loudnessChangeDb: Math.round(loudnessChangeDb * 10) / 10,
        spectralChangePercent: Math.round(spectralChangePercent * 10) / 10,
        zeroCrossingChange: Math.round(zeroCrossingChange * 1000) / 1000,
      });
    }
  }
  return transitions;
}

export async function analyzeVoiceContinuity(fileOrBlob: Blob): Promise<VoiceContinuityReport> {
  if (fileOrBlob.size === 0 || fileOrBlob.size > 25 * 1024 * 1024) {
    throw new Error('Choose a non-empty audio file smaller than 25 MiB.');
  }
  const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) throw new Error('Web Audio is not available in this browser.');

  const audioContext = new AudioContextClass();
  try {
    const decoded = await audioContext.decodeAudioData(await fileOrBlob.arrayBuffer());
    if (decoded.duration > 300) throw new Error('Voice continuity review is limited to audio clips of 5 minutes or less.');
    const sampleRate = decoded.sampleRate;
    const samplesPerWindow = Math.max(1, Math.floor(sampleRate));
    const hopSize = Math.max(1, Math.floor(sampleRate / 2));
    const sampleCount = 1024;
    const levelSampleCount = 2048;
    const segments: VoiceContinuitySegment[] = [];

    for (let start = 0; start < decoded.length; start += hopSize) {
      const end = Math.min(start + samplesPerWindow, decoded.length);
      if (end - start < Math.floor(sampleRate * 0.25)) continue;
      const sampledLevels = new Float64Array(levelSampleCount);
      let sumSquares = 0;
      let crossings = 0;
      let prior = 0;
      const channelData = Array.from({ length: decoded.numberOfChannels }, (_, channel) => decoded.getChannelData(channel));
      for (let index = 0; index < levelSampleCount; index += 1) {
        const frameIndex = start + Math.floor((index / levelSampleCount) * (end - start));
        let value = 0;
        for (const channel of channelData) {
          value += channel[frameIndex] / decoded.numberOfChannels;
        }
        sampledLevels[index] = value;
        sumSquares += value * value;
        if (index > 0 && ((value >= 0) !== (prior >= 0))) crossings += 1;
        prior = value;
      }

      const rms = Math.sqrt(sumSquares / levelSampleCount);
      const spectralSamples = new Float64Array(sampleCount);
      const spectrumStart = Math.min(start + Math.floor((end - start - sampleCount) / 2), decoded.length - sampleCount);
      for (let index = 0; index < sampleCount; index += 1) {
        const frameIndex = Math.max(0, spectrumStart + index);
        let value = 0;
        for (const channel of channelData) value += channel[frameIndex] / decoded.numberOfChannels;
        spectralSamples[index] = value * (0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (sampleCount - 1)));
      }
      const powers = calculateAudioBandPowers(spectralSamples, sampleRate);
      const totalPower = powers.reduce((sum, power) => sum + power, 0) || 1;
      const toPercent = (power: number) => Math.round((power / totalPower) * 1000) / 10;
      segments.push({
        startSec: Math.round((start / sampleRate) * 10) / 10,
        endSec: Math.round((end / sampleRate) * 10) / 10,
        loudnessDbfs: rms > 0 ? Math.round(20 * Math.log10(rms) * 10) / 10 : -100,
        lowBandPercent: toPercent(powers[0]),
        midBandPercent: toPercent(powers[1]),
        highBandPercent: toPercent(powers[2]),
        zeroCrossingRate: Math.round((crossings / (levelSampleCount - 1)) * 1000) / 1000,
      });
    }
    if (!segments.length) throw new Error('This audio clip is too short to review.');
    return {
      durationSec: decoded.duration,
      segments,
      transitions: findVoiceContinuityTransitions(segments),
    };
  } finally {
    await audioContext.close();
  }
}

export function summarizeAudioEnvironmentComparison(
  nameA: string,
  fingerprintA: AudioEnvironmentFingerprint,
  nameB: string,
  fingerprintB: AudioEnvironmentFingerprint
): string {
  const levelDifference = Math.abs(fingerprintA.noiseFloorDbfs - fingerprintB.noiseFloorDbfs);
  const levelDescription = fingerprintA.noiseFloorDbfs > fingerprintB.noiseFloorDbfs
    ? `${nameA} has slightly louder measured background sound (about ${levelDifference.toFixed(1)} dB) than ${nameB}`
    : fingerprintA.noiseFloorDbfs < fingerprintB.noiseFloorDbfs
      ? `${nameB} has slightly louder measured background sound (about ${levelDifference.toFixed(1)} dB) than ${nameA}`
      : `the measured background sound is the same for both recordings`;
  const bandDescriptions = [
    ['low', fingerprintA.lowBandPercent, fingerprintB.lowBandPercent],
    ['mid', fingerprintA.midBandPercent, fingerprintB.midBandPercent],
    ['high', fingerprintA.highBandPercent, fingerprintB.highBandPercent],
  ].map(([band, valueA, valueB]) => {
    const difference = Math.abs(Number(valueA) - Number(valueB)).toFixed(1);
    if (Number(valueA) === Number(valueB)) return `Both have the same share of ${band}-frequency sounds (${valueA}%)`;
    const louderFile = Number(valueA) > Number(valueB) ? nameA : nameB;
    const quieterFile = louderFile === nameA ? nameB : nameA;
    return `${louderFile} has more ${band}-frequency sound (${Math.max(Number(valueA), Number(valueB))}%) than ${quieterFile} (${Math.min(Number(valueA), Number(valueB))}%), a difference of ${difference} percentage points`;
  }).join('; ');
  const decayDescription = fingerprintA.decayProxyMs !== null && fingerprintB.decayProxyMs !== null
    ? fingerprintA.decayProxyMs > fingerprintB.decayProxyMs
      ? `${nameA} has a longer rough sound fade (${fingerprintA.decayProxyMs} ms) than ${nameB} (${fingerprintB.decayProxyMs} ms).`
      : fingerprintB.decayProxyMs > fingerprintA.decayProxyMs
        ? `${nameB} has a longer rough sound fade (${fingerprintB.decayProxyMs} ms) than ${nameA} (${fingerprintA.decayProxyMs} ms).`
        : `Both have the same rough sound-fade estimate (${fingerprintA.decayProxyMs} ms).`
    : 'A rough sound-fade estimate was not available for both recordings.';
  const details = (name: string, fingerprint: AudioEnvironmentFingerprint) =>
    `${name} is ${fingerprint.durationSec.toFixed(1)} seconds long and records ${fingerprint.sampleRateHz.toLocaleString()} audio samples each second. Its quiet-section sound estimate is ${fingerprint.noiseFloorDbfs} dBFS; low sounds are ${fingerprint.lowBandPercent}%, mid sounds ${fingerprint.midBandPercent}%, and high sounds ${fingerprint.highBandPercent}%. Its rough sound-fade estimate is ${fingerprint.decayProxyMs === null ? 'not available' : `${fingerprint.decayProxyMs} ms`}.`;

  return `Simple observation: ${levelDescription}. ${bandDescriptions}. ${decayDescription} ${details(nameA, fingerprintA)} ${details(nameB, fingerprintB)} This describes the sound in these files. It does not show that they were recorded in the same room or place.`;
}

export async function analyzeAudioEnvironment(fileOrBlob: Blob): Promise<AudioEnvironmentFingerprint> {
  if (fileOrBlob.size === 0 || fileOrBlob.size > 25 * 1024 * 1024) {
    throw new Error('Choose a non-empty audio file smaller than 25 MiB.');
  }
  const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) throw new Error('Web Audio is not available in this browser.');

  const audioContext = new AudioContextClass();
  try {
    const decoded = await audioContext.decodeAudioData(await fileOrBlob.arrayBuffer());
    if (decoded.duration > 300) throw new Error('For this comparison, audio clips must be 5 minutes or shorter.');
    const samples = decoded.getChannelData(0);
    const sampleRate = decoded.sampleRate;
    const frameSize = 1024;
    const frameStep = Math.max(frameSize, Math.floor(sampleRate * 0.25));
    const frameLevels: number[] = [];
    const bandPowers = [0, 0, 0];
    const envelope: number[] = [];
    const envelopeStep = Math.max(1, Math.floor(sampleRate * 0.02));

    for (let start = 0; start + frameSize < samples.length; start += frameStep) {
      let sumSquares = 0;
      const spectrumSize = 128;
      const real = new Float64Array(spectrumSize);
      const imaginary = new Float64Array(spectrumSize);
      for (let index = 0; index < frameSize; index++) {
        const sample = samples[start + index];
        sumSquares += sample * sample;
        if (index % 8 === 0) {
          const position = index / 8;
          for (let bin = 1; bin < spectrumSize / 2; bin++) {
            const angle = (2 * Math.PI * bin * position) / spectrumSize;
            real[bin] += sample * Math.cos(angle);
            imaginary[bin] -= sample * Math.sin(angle);
          }
        }
      }
      frameLevels.push(Math.sqrt(sumSquares / frameSize));
      for (let bin = 1; bin < spectrumSize / 2; bin++) {
        const frequency = (bin * sampleRate) / (spectrumSize * 8);
        const power = real[bin] ** 2 + imaginary[bin] ** 2;
        bandPowers[frequency < 250 ? 0 : frequency < 600 ? 1 : 2] += power;
      }
    }

    for (let start = 0; start + envelopeStep <= samples.length; start += envelopeStep) {
      let sumSquares = 0;
      for (let index = start; index < start + envelopeStep; index++) sumSquares += samples[index] ** 2;
      envelope.push(Math.sqrt(sumSquares / envelopeStep));
    }
    if (frameLevels.length === 0) throw new Error('This audio clip is too short to compare.');

    const sortedLevels = [...frameLevels].sort((a, b) => a - b);
    const quietLevel = sortedLevels[Math.floor((sortedLevels.length - 1) * 0.2)];
    const noiseFloorDbfs = quietLevel > 0 ? 20 * Math.log10(quietLevel) : -100;
    const totalBandPower = bandPowers.reduce((sum, power) => sum + power, 0) || 1;
    const decaySamples: number[] = [];
    const peakThreshold = sortedLevels[Math.floor((sortedLevels.length - 1) * 0.8)];
    const dropRatio = 0.1;
    const maxDecayFrames = Math.ceil(0.5 / 0.02);
    for (let index = 1; index < envelope.length - maxDecayFrames; index++) {
      if (envelope[index] < peakThreshold || envelope[index] < envelope[index - 1] * 1.5) continue;
      const target = envelope[index] * dropRatio;
      const decayEnd = envelope.slice(index + 1, index + maxDecayFrames + 1).findIndex((value) => value <= target);
      if (decayEnd >= 0) decaySamples.push((decayEnd + 1) * 20);
    }
    const decayProxyMs = decaySamples.length
      ? decaySamples.sort((a, b) => a - b)[Math.floor(decaySamples.length / 2)]
      : null;

    return {
      durationSec: decoded.duration,
      sampleRateHz: sampleRate,
      noiseFloorDbfs: Math.round(noiseFloorDbfs * 10) / 10,
      lowBandPercent: Math.round((bandPowers[0] / totalBandPower) * 1000) / 10,
      midBandPercent: Math.round((bandPowers[1] / totalBandPower) * 1000) / 10,
      highBandPercent: Math.round((bandPowers[2] / totalBandPower) * 1000) / 10,
      decayProxyMs,
    };
  } finally {
    await audioContext.close();
  }
}

export async function analyzeAudioBuffer(fileOrBlob: Blob): Promise<AudioForensicReport> {
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error('Web Audio API is not supported in this browser environment');
  }

  const audioCtx = new AudioContextClass();
  try {
    const arrayBuffer = await fileOrBlob.arrayBuffer();
    if (!arrayBuffer || arrayBuffer.byteLength < 44) {
      throw new Error('Audio file bitstream is empty or truncated');
    }

    const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const duration = decodedBuffer.duration;
    const sampleRate = decodedBuffer.sampleRate;
    const channels = decodedBuffer.numberOfChannels;
    const channelData = decodedBuffer.getChannelData(0); // Primary channel

    let sumSquares = 0;
    let peakVal = 0;
    let clippingCount = 0;
    let silenceSamples = 0;
    const silenceThreshold = 0.005; // -46 dBFS

    for (let i = 0; i < channelData.length; i++) {
      const val = channelData[i];
      const absVal = Math.abs(val);

      sumSquares += val * val;
      if (absVal > peakVal) peakVal = absVal;

    // Detect hard clipping
    if (absVal >= 0.99) {
      clippingCount++;
    }

    if (absVal < silenceThreshold) {
      silenceSamples++;
    }
  }

  const rms = Math.sqrt(sumSquares / channelData.length);
  const rmsDbfs = rms > 0 ? 20 * Math.log10(rms) : -100;
  const peakDbfs = peakVal > 0 ? 20 * Math.log10(peakVal) : -100;
  const silenceRatioPercent = (silenceSamples / channelData.length) * 100;
  const nyquistHz = sampleRate / 2;

  // Extract waveform buckets (e.g. 200 points for crisp visualizer)
  const bucketCount = 200;
  const bucketSize = Math.floor(channelData.length / bucketCount);
  const waveformPeaks: Float32Array[] = [];

  for (let b = 0; b < bucketCount; b++) {
    let min = 1.0;
    let max = -1.0;
    const start = b * bucketSize;
    const end = Math.min(start + bucketSize, channelData.length);

    for (let j = start; j < end; j++) {
      const sample = channelData[j];
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }

    waveformPeaks.push(new Float32Array([min, max]));
  }

  const spectralAnomalies: string[] = [];

  // Inspect for potential TTS / voice synthesis signatures
  if (sampleRate === 24000 || sampleRate === 22050 || sampleRate === 16000) {
    spectralAnomalies.push(`Standard AI voice synthesis sample rate observed: ${sampleRate} Hz`);
  }

  if (clippingCount > 20) {
    spectralAnomalies.push(`Signal clipping detected (${clippingCount} instances): Audio peaks reached digital maximum 0 dBFS`);
  }

  if (silenceRatioPercent > 40) {
    spectralAnomalies.push(`Abnormally high silence ratio (${silenceRatioPercent.toFixed(1)}%): May indicate gated audio or spliced speech segments`);
  }

  return {
    durationSec: duration,
    sampleRateHz: sampleRate,
    channels,
    rmsDbfs: Math.round(rmsDbfs * 10) / 10,
    peakDbfs: Math.round(peakDbfs * 10) / 10,
    clippingCount,
    silenceRatioPercent: Math.round(silenceRatioPercent * 10) / 10,
    nyquistHz,
    waveformPeaks,
    spectralAnomalies,
  };
  } finally {
    try {
      await audioCtx.close();
    } catch {
      // Ignore already closed context
    }
  }
}

/**
 * Generates a valid RIFF/WAVE PCM 16-bit audio blob with dual synthetic speech formant frequencies
 * for reproducible offline forensic testing and calibration.
 */
export function createSyntheticForensicWavBlob(durationSec = 2, fundamentalHz = 220): Blob {
  const sampleRate = 16000;
  const numSamples = Math.floor(sampleRate * durationSec);
  const numChannels = 1;
  const bytesPerSample = 2; // 16-bit
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // Write RIFF Header
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');

  // Write fmt sub-chunk
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, numChannels, true); // NumChannels (1 mono)
  view.setUint32(24, sampleRate, true); // SampleRate (16000)
  view.setUint32(28, byteRate, true); // ByteRate
  view.setUint16(32, blockAlign, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample (16-bit)

  // Write data sub-chunk
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  // Synthesize acoustic wave: F0 fundamental + F1/F2 formants with subtle synthetic jitter
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Envelope attack/decay
    const envelope = Math.min(1, Math.min(t * 10, (durationSec - t) * 5));
    // Fundamental + Formant harmonics (mimicking vocal tract resonance)
    const s1 = Math.sin(2 * Math.PI * fundamentalHz * t);
    const s2 = 0.5 * Math.sin(2 * Math.PI * (fundamentalHz * 2.1) * t);
    const s3 = 0.25 * Math.sin(2 * Math.PI * (fundamentalHz * 3.4) * t);
    const sampleVal = (s1 + s2 + s3) / 1.75 * envelope;

    const int16 = Math.max(-32768, Math.min(32767, Math.floor(sampleVal * 32767)));
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
