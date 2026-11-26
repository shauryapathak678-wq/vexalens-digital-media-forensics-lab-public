import { describe, expect, it } from 'vitest';
import { analyzeLsbPixels } from './lsbAnalysis';

describe('LSB browser analysis', () => {
  it('extracts RGB one ratios and three planes', () => {
    class TestImageData {
      width: number;
      height: number;
      data: Uint8ClampedArray;
      colorSpace: PredefinedColorSpace = 'srgb';
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        this.data = new Uint8ClampedArray(width * height * 4);
      }
    }
    Object.defineProperty(globalThis, 'ImageData', {
      configurable: true,
      value: TestImageData,
    });

    const imageData = {
      width: 2,
      height: 1,
      data: new Uint8ClampedArray([
      1, 2, 3, 255,
      2, 3, 4, 255,
      ]),
      colorSpace: 'srgb',
    } as ImageData;

    const result = analyzeLsbPixels(imageData);
    expect(result.channels).toHaveLength(3);
    expect(result.channels[0].ones).toBe(1);
    expect(result.channels[0].oneRatio).toBe(0.5);
    expect(result.channels[0].hiddenTextPreview).toBeTypeOf('string');
    expect(result.channels[0].printableRatio).toBeGreaterThanOrEqual(0);
    expect(result.planes.red.data[0]).toBe(255);
    expect(result.planes.red.data[4]).toBe(0);
  });

});
