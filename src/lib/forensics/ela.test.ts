import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectHotspots,
  evaluateELAReliability,
  buildForensicVerdict,
  auditAIOriginMetadata,
  getPerceptualRgb,
  computeSobelEdgeMagnitude,
  performELA,
} from './ela';

describe('Error Level Analysis (ELA) Core Engine & Forensic Gate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Original Camera JPEG', () => {
    it('produces 0 hotspots and verdict "no_local_edits_detected" on natural uniform compression', () => {
      const width = 512;
      const height = 512;
      const total = width * height;
      const unscaledDifferences = new Float32Array(total);

      // Natural camera JPEG recompression noise: baseline ~1.8 +/- small noise
      for (let i = 0; i < total; i++) {
        unscaledDifferences[i] = 1.8 + (Math.sin(i * 0.05) * 0.4);
      }

      const { hotspots, isGlobalPattern, blockStats } = detectHotspots(
        unscaledDifferences,
        width,
        height,
        undefined,
        32,
        6.0
      );

      expect(hotspots).toHaveLength(0);
      expect(isGlobalPattern).toBe(false);

      const reliability = evaluateELAReliability({
        fileName: 'DSC_0492.JPG',
        fileType: 'image/jpeg',
        metadata: {
          cameraMake: 'Nikon',
          cameraModel: 'D850',
          iso: '200',
          exposureTime: '1/250',
          dateTimeOriginal: '2026:05:14 14:22:10',
        },
        dimensions: { width, height },
      });

      expect(reliability.reliability).toBe('high');

      const verdict = buildForensicVerdict({
        reliabilityAssessment: reliability,
        hotspots,
        isGlobalPattern,
      });

      expect(verdict.ela_verdict).toBe('no_local_edits_detected');
      expect(verdict.hotspots).toHaveLength(0);
    });
  });

  describe('2. Edited Copy with Pasted Patch', () => {
    it('detects exactly 1 hotspot overlapping a spliced 150x150 patch saved at a different quality', () => {
      const width = 512;
      const height = 512;
      const total = width * height;
      const unscaledDifferences = new Float32Array(total);

      // Baseline error across the image ~1.5 with slight natural texture variance
      for (let i = 0; i < total; i++) {
        unscaledDifferences[i] = 1.5 + ((i % 17) - 8) * 0.05;
      }

      // Paste a 150x150 spliced patch at x: 160..310, y: 160..310 with elevated recompression delta (18.0)
      const patchX = 160;
      const patchY = 160;
      const patchSize = 150;

      for (let y = patchY; y < patchY + patchSize; y++) {
        const row = y * width;
        for (let x = patchX; x < patchX + patchSize; x++) {
          unscaledDifferences[row + x] = 18.0 + ((x % 7) - 3) * 0.1;
        }
      }

      const { hotspots, isGlobalPattern } = detectHotspots(
        unscaledDifferences,
        width,
        height,
        undefined,
        32,
        6.0
      );

      expect(isGlobalPattern).toBe(false);
      expect(hotspots).toHaveLength(1);

      const hotspot = hotspots[0];
      // Bounding box must strictly overlap the patch area (160..310)
      expect(hotspot.x).toBeLessThanOrEqual(patchX);
      expect(hotspot.x + hotspot.w).toBeGreaterThanOrEqual(patchX + patchSize);
      expect(hotspot.y).toBeLessThanOrEqual(patchY);
      expect(hotspot.y + hotspot.h).toBeGreaterThanOrEqual(patchY + patchSize);
      expect(hotspot.peak_z).toBeGreaterThan(6.0);

      const reliability = evaluateELAReliability({
        fileName: 'evidence_spliced.jpg',
        fileType: 'image/jpeg',
        metadata: { cameraMake: 'Canon', cameraModel: 'EOS R5' },
        dimensions: { width, height },
      });

      const verdict = buildForensicVerdict({
        reliabilityAssessment: reliability,
        hotspots,
        isGlobalPattern,
      });

      expect(verdict.ela_verdict).toBe('possible_local_edit');
      expect(verdict.hotspots).toHaveLength(1);
    });
  });

  describe('3. PNG Input Gate', () => {
    it('flags PNG input as "low" reliability and verdict "not_reliable"', () => {
      const reliability = evaluateELAReliability({
        fileName: 'screenshot_capture.png',
        fileType: 'image/png',
        dimensions: { width: 1200, height: 800 },
      });

      expect(reliability.reliability).toBe('low');
      expect(reliability.isJpeg).toBe(false);
      expect(reliability.reliabilityReasons.some((r) => r.includes('PNG'))).toBe(true);

      const verdict = buildForensicVerdict({
        reliabilityAssessment: reliability,
        hotspots: [],
        isGlobalPattern: false,
      });

      expect(verdict.ela_verdict).toBe('not_reliable');
      expect(verdict.hotspots).toHaveLength(0);
    });
  });

  describe('4. WhatsApp-style JPEG with No EXIF', () => {
    it('identifies messaging app recompression and yields reliability "low" and verdict "not_reliable"', () => {
      const reliability = evaluateELAReliability({
        fileName: 'WhatsApp Image 2026-06-03 at 1.19.22 PM.jpeg',
        fileType: 'image/jpeg',
        metadata: {}, // Stripped metadata
        dimensions: { width: 1200, height: 1600 },
      });

      expect(reliability.reliability).toBe('low');
      expect(reliability.isMessagingAppSuspect).toBe(true);
      expect(reliability.messagingAppName).toBe('WhatsApp');
      expect(reliability.hasExif).toBe(false);

      const verdict = buildForensicVerdict({
        reliabilityAssessment: reliability,
        hotspots: [],
        isGlobalPattern: false,
      });

      expect(verdict.ela_verdict).toBe('not_reliable');
      expect(verdict.reliability_reasons.some((r) => r.includes('WhatsApp'))).toBe(true);
      expect(verdict.reliability_reasons.some((r) => r.includes('EXIF'))).toBe(true);
    });
  });

  describe('5. Uniform Global Recompression', () => {
    it('classifies uniformly elevated block error as global and returns no hotspots', () => {
      const differences = new Float32Array(512 * 512).fill(4);
      const { hotspots, isGlobalPattern } = detectHotspots(
        differences,
        512,
        512,
        undefined,
        32,
        6
      );

      expect(isGlobalPattern).toBe(true);
      expect(hotspots).toHaveLength(0);
    });

    it('classifies widespread error (>20% of image) as "global_recompression" and shows NO hotspots', () => {
      const width = 512;
      const height = 512;
      const total = width * height;
      const unscaledDifferences = new Float32Array(total);

      const rows = height / 32;
      const cols = width / 32;

      // 75% baseline blocks with natural variance (~2.0), 25% elevated blocks (>20% coverage)
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const isElevated = r < 4; // 4 rows * 16 cols = 64 / 256 blocks = 25% of image
          const baseVal = isElevated ? 12.0 : 2.0;
          const blockNoise = (((r * 7 + c * 13) % 11) - 5) * 0.08;

          for (let y = r * 32; y < (r + 1) * 32; y++) {
            const row = y * width;
            for (let x = c * 32; x < (c + 1) * 32; x++) {
              unscaledDifferences[row + x] = baseVal + blockNoise;
            }
          }
        }
      }

      const { hotspots, isGlobalPattern, blockStats } = detectHotspots(
        unscaledDifferences,
        width,
        height,
        undefined,
        32,
        6.0
      );

      expect(isGlobalPattern).toBe(true);
      expect(blockStats.coveragePct).toBeGreaterThan(20.0);
      expect(hotspots).toHaveLength(0);

      const reliability = evaluateELAReliability({
        fileName: 'resaved_photo.jpg',
        fileType: 'image/jpeg',
        metadata: { cameraMake: 'Sony', cameraModel: 'A7 IV' },
        dimensions: { width, height },
      });

      const verdict = buildForensicVerdict({
        reliabilityAssessment: reliability,
        hotspots,
        isGlobalPattern,
      });

      expect(verdict.ela_verdict).toBe('global_recompression');
      expect(verdict.hotspots).toHaveLength(0);
    });
  });

  describe('6. Regression Tests: Metric & Bounding Box Sanity', () => {
    it('never produces "+1290% spike" text and never produces a (0,0) full-frame hotspot', () => {
      const width = 640;
      const height = 480;
      const total = width * height;
      const unscaledDifferences = new Float32Array(total);

      // Uniform image with one high-frequency edge pixel at (100, 100)
      for (let i = 0; i < total; i++) {
        unscaledDifferences[i] = 2.8;
      }
      unscaledDifferences[100 * width + 100] = 39.0; // Single pixel spike (like embroidery)

      const { hotspots } = detectHotspots(
        unscaledDifferences,
        width,
        height,
        undefined,
        32,
        6.0
      );

      // Single pixel cannot trigger an anomalous 32x32 block (or >= 3 blocks cluster)
      expect(hotspots).toHaveLength(0);

      // Check text in descriptions
      for (const h of hotspots) {
        expect(h.description).not.toMatch(/\+\d+%\s*spike/);
        // Ensure no full frame box
        expect(h.x === 0 && h.y === 0 && h.w === width && h.h === height).toBe(false);
      }
    });

    it('perceptual colormap maps 0.0 to deep navy and 1.0 to crimson without flat black', () => {
      const [r0, g0, b0] = getPerceptualRgb(0.0);
      expect(r0).toBe(15);
      expect(g0).toBe(23);
      expect(b0).toBe(42);

      const [r1, g1, b1] = getPerceptualRgb(1.0);
      expect(r1).toBe(239);
      expect(g1).toBe(68);
      expect(b1).toBe(68);

      // Mid-tones must be bright and distinct (cyan/teal/green)
      const [rMid, gMid, bMid] = getPerceptualRgb(0.35);
      expect(gMid).toBeGreaterThan(100);
      expect(bMid).toBeGreaterThan(100);
    });
  });

  describe('7. AI-Origin Metadata Audit', () => {
    it('detects AI generation tools named in software tags', async () => {
      const audit = await auditAIOriginMetadata({
        metadata: {
          software: 'Midjourney v6.0',
        },
        fileName: 'cyberpunk_city.jpg',
      });

      expect(audit.status).toBe('signals_found');
      expect(audit.generatorName).toBe('Midjourney');
      expect(audit.signals.some((s) => s.includes('Midjourney'))).toBe(true);
    });

    it('returns "none_found" with honest disclaimer when no AI metadata exists', async () => {
      const audit = await auditAIOriginMetadata({
        metadata: {
          cameraMake: 'Canon',
          cameraModel: 'EOS 5D Mark IV',
        },
        fileName: 'family_vacation.jpg',
      });

      expect(audit.status).toBe('none_found');
      expect(audit.signals).toHaveLength(0);
      expect(audit.details).toContain('No AI-origin signals found in metadata');
      expect(audit.details).toContain('does NOT prove the image is real');
    });

    it('still reports AI metadata when Content Credentials bytes cannot be read', async () => {
      const audit = await auditAIOriginMetadata({
        metadata: { software: 'Stable Diffusion' },
        fileOrBuffer: 'data:;base64,%%%!',
      });

      expect(audit.status).toBe('signals_found');
      expect(audit.generatorName).toBe('Stable Diffusion');
    });
  });
});
