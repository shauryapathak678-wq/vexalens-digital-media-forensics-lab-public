import { describe, expect, it } from 'vitest';
import {
  findVoiceContinuityTransitions,
  summarizeAudioEnvironmentComparison,
  type AudioEnvironmentFingerprint,
  type VoiceContinuitySegment,
} from './audio';

const firstRecording: AudioEnvironmentFingerprint = {
  durationSec: 12,
  sampleRateHz: 48000,
  noiseFloorDbfs: -42,
  lowBandPercent: 30,
  midBandPercent: 45,
  highBandPercent: 25,
  decayProxyMs: 120,
};

describe('audio environment comparison summary', () => {
  it('describes measured differences without claiming a shared location', () => {
    const secondRecording: AudioEnvironmentFingerprint = {
      ...firstRecording,
      noiseFloorDbfs: -48,
      lowBandPercent: 35,
      midBandPercent: 40,
      highBandPercent: 25,
      decayProxyMs: 160,
    };

    const summary = summarizeAudioEnvironmentComparison(
      'first.wav',
      firstRecording,
      'second.wav',
      secondRecording
    );

    expect(summary).toContain('first.wav has slightly louder measured background sound (about 6.0 dB)');
    expect(summary).toContain('second.wav has more low-frequency sound (35%) than first.wav (30%)');
    expect(summary).toContain('second.wav has a longer rough sound fade (160 ms) than first.wav (120 ms)');
    expect(summary).toContain('first.wav is 12.0 seconds long and records 48,000 audio samples each second');
    expect(summary).toContain('It does not show that they were recorded in the same room or place');
  });

  describe('voice continuity transition review', () => {
    const segment = (overrides: Partial<VoiceContinuitySegment> = {}): VoiceContinuitySegment => ({
      startSec: 0,
      endSec: 1,
      loudnessDbfs: -24,
      lowBandPercent: 20,
      midBandPercent: 60,
      highBandPercent: 20,
      zeroCrossingRate: 0.1,
      ...overrides,
    });

    it('marks abrupt changes with their timestamp and plain measured differences', () => {
      const transitions = findVoiceContinuityTransitions([
        segment(),
        segment({
          startSec: 0.5,
          endSec: 1.5,
          loudnessDbfs: -10,
          lowBandPercent: 55,
          midBandPercent: 25,
          highBandPercent: 20,
          zeroCrossingRate: 0.3,
        }),
      ]);

      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toMatchObject({
        timeSec: 0.5,
        loudnessChangeDb: 14,
        zeroCrossingChange: 0.2,
      });
      expect(transitions[0].changes).toEqual(expect.arrayContaining([
        expect.stringContaining('Loudness changed by 14.0 dB'),
        expect.stringContaining('Sound-frequency balance shifted'),
        expect.stringContaining('rapid up/down movement'),
      ]));
    });

    it('does not flag small segment-to-segment differences', () => {
      const transitions = findVoiceContinuityTransitions([
        segment(),
        segment({ startSec: 0.5, endSec: 1.5, loudnessDbfs: -26, lowBandPercent: 21, midBandPercent: 59, zeroCrossingRate: 0.11 }),
      ]);
      expect(transitions).toEqual([]);
    });
  });

  it('reports when sound-fade estimates cannot be compared', () => {
    const summary = summarizeAudioEnvironmentComparison(
      'first.wav',
      { ...firstRecording, decayProxyMs: null },
      'second.wav',
      { ...firstRecording, noiseFloorDbfs: -50, decayProxyMs: 100 }
    );

    expect(summary).toContain('A rough sound-fade estimate was not available for both recordings.');
  });
});
