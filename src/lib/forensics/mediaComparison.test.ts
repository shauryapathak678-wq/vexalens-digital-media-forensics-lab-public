import { describe, expect, it } from 'vitest';
import { calculateRasterMetrics, type RasterImage } from './mediaComparison';

function raster(width: number, height: number, color: [number, number, number]): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = 255;
  }
  return { width, height, data };
}

describe('local raster comparison metrics', () => {
  it('reports identical images as identical across pixel and structural metrics', () => {
    const image = raster(16, 16, [40, 100, 220]);
    const metrics = calculateRasterMetrics(image, image);

    expect(metrics.mae).toBe(0);
    expect(metrics.mse).toBe(0);
    expect(metrics.changedPixels).toBe(0);
    expect(metrics.ssim).toBe(1);
    expect(metrics.pHashDistance).toBe(0);
    expect(metrics.dHashDistance).toBe(0);
    expect(metrics.aHashDistance).toBe(0);
    expect(metrics.histogramSimilarity).toBe(1);
  });

  it('counts changed pixels by the requested sensitivity threshold', () => {
    const baseline = raster(2, 1, [0, 0, 0]);
    const suspect = raster(2, 1, [20, 20, 20]);

    expect(calculateRasterMetrics(baseline, suspect, 10).changedPixels).toBe(2);
    expect(calculateRasterMetrics(baseline, suspect, 20).changedPixels).toBe(0);
    expect(calculateRasterMetrics(baseline, suspect, 21).changedPixels).toBe(0);
  });

  it('detects an inserted pixel change without treating it as an authenticity verdict', () => {
    const baseline = raster(16, 16, [220, 220, 220]);
    const suspect = raster(16, 16, [220, 220, 220]);
    const offset = (8 * suspect.width + 8) * 4;
    suspect.data[offset] = 20;
    suspect.data[offset + 1] = 20;
    suspect.data[offset + 2] = 20;

    const metrics = calculateRasterMetrics(baseline, suspect, 24);
    expect(metrics.changedPixels).toBe(1);
    expect(metrics.changedPercent).toBeCloseTo((1 / 256) * 100);
    expect(metrics.ssim).toBeLessThan(1);
  });

  it('rejects mismatched raster dimensions and invalid thresholds', () => {
    expect(() => calculateRasterMetrics(raster(1, 1, [0, 0, 0]), raster(2, 1, [0, 0, 0])))
      .toThrow('Raster dimensions must match');
    expect(() => calculateRasterMetrics(raster(1, 1, [0, 0, 0]), raster(1, 1, [0, 0, 0]), 256))
      .toThrow('between 0 and 255');
  });
});
