import { describe, expect, it } from 'vitest';
import {
  computePerceptualHashFromPixels,
  hammingDistance,
  isNearDuplicate,
} from './perceptualHash';

function gradientPixels(width: number, height: number, invert = false, noise = 0): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const base = Math.round((x / (width - 1)) * 255);
      const value = invert ? 255 - base : base;
      const jitter = noise ? ((x * 7 + y * 13) % noise) : 0;
      const clamped = Math.max(0, Math.min(255, value + jitter));
      const offset = (y * width + x) * 4;
      pixels[offset] = clamped;
      pixels[offset + 1] = clamped;
      pixels[offset + 2] = clamped;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

describe('perceptual hash', () => {
  it('produces identical hashes for identical pixels', () => {
    const width = 16;
    const height = 16;
    const hashA = computePerceptualHashFromPixels(gradientPixels(width, height), width, height);
    const hashB = computePerceptualHashFromPixels(gradientPixels(width, height), width, height);

    expect(hashA).toHaveLength(16);
    expect(hashA).toBe(hashB);
    expect(hammingDistance(hashA, hashB)).toBe(0);
    expect(isNearDuplicate(hashA, hashB)).toBe(true);
  });

  it('treats a lightly altered image as a near-duplicate', () => {
    const width = 16;
    const height = 16;
    const original = computePerceptualHashFromPixels(gradientPixels(width, height), width, height);
    const recompressed = computePerceptualHashFromPixels(gradientPixels(width, height, false, 6), width, height);

    expect(isNearDuplicate(original, recompressed, 10)).toBe(true);
  });

  it('separates an inverted image from the original, which is not a near-duplicate', () => {
    const width = 16;
    const height = 16;
    const original = computePerceptualHashFromPixels(gradientPixels(width, height), width, height);
    const inverted = computePerceptualHashFromPixels(gradientPixels(width, height, true), width, height);

    expect(hammingDistance(original, inverted)).toBeGreaterThan(10);
    expect(isNearDuplicate(original, inverted)).toBe(false);
  });

  it('rejects malformed input and mismatched hash lengths', () => {
    expect(computePerceptualHashFromPixels(new Uint8ClampedArray(4), 4, 4)).toBe('');
    expect(hammingDistance('abcd', 'ab')).toBe(Number.POSITIVE_INFINITY);
    expect(isNearDuplicate('abcd', '')).toBe(false);
  });
});
