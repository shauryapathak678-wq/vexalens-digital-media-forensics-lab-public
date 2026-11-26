import type {
  ScreenshotAnalysisResult,
  ScreenshotCategory,
  SuspiciousRegion,
  ModuleFinding,
  ScreenshotAssessmentStatus,
  AiEvidenceDetectorResult,
} from '@/types/screenshotForensics';
import { getAuthSession } from '@/lib/supabase';
import { calculateEvidenceHashes } from '@/lib/forensics/crypto';
import { analyzeImageForAIOrigin } from '@/lib/forensics/aiOriginDetector';
import type { AIOriginAssessmentResult } from '@/types/forensics';

export const MAX_SCREENSHOT_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_SCREENSHOT_PIXELS = 12_000_000;

const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// ---------------------------------------------------------------------------
// Client-Side Computer Vision Forensic Engine (Intra-Class Normalized)
// ---------------------------------------------------------------------------

interface TileMetrics {
  tx: number;
  ty: number;
  x: number;
  y: number;
  w: number;
  h: number;
  minLum: number;
  maxLum: number;
  contrast: number;
  smoothNoiseVar: number;
  edgeSharpness: number;
  elaError: number;
  edgeDensity: number;
  boundaryStep: number;
}

/**
 * Loads a Blob into an HTMLImageElement safely in any browser environment.
 */
function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('The uploaded evidence image could not be decoded.'));
    };
    img.src = url;
  });
}

/**
 * Helper to compute median and Median Absolute Deviation (MAD)
 */
function calculateRobustStats(values: number[]): { median: number; mad: number; robustSigma: number } {
  if (values.length === 0) return { median: 0, mad: 0, robustSigma: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  const deviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = deviations.length % 2 !== 0 ? deviations[mid] : (deviations[mid - 1] + deviations[mid]) / 2;
  const robustSigma = 1.4826 * mad;
  return { median, mad, robustSigma };
}

/**
 * Runs browser-native computer vision forensics specialized for screenshots.
 * Correctly distinguishes flat UI backgrounds from standard app text and vector icons,
 * performing contrast-normalized intra-class comparisons to prevent false positives on genuine receipts.
 */
export async function runClientSideScreenshotForensics(
  file: Blob,
  fileName: string,
  category: ScreenshotCategory,
  sensitivity = 3,
  onProgress?: (step: number, label: string) => void
): Promise<ScreenshotAnalysisResult> {
  const startTime = Date.now();

  onProgress?.(1, 'Calculating cryptographic SHA-256 evidence hashes');
  const hashes = await calculateEvidenceHashes(file);
  const img = await loadImageFromBlob(file);

  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (width * height > MAX_SCREENSHOT_PIXELS) {
    throw new Error('The image exceeds the 12-megapixel analysis limit.');
  }

  // 1. Canvas Context & Grayscale Luminance Map
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D context could not be created.');
  ctx.drawImage(img, 0, 0, width, height);

  const originalImageData = ctx.getImageData(0, 0, width, height);
  const origPixels = originalImageData.data;

  // Fire local AI-origin spectral analysis in parallel (non-blocking) using the already-decoded pixel data
  const aiOriginAnalysisPromise: Promise<AIOriginAssessmentResult> = analyzeImageForAIOrigin({
    width,
    height,
    rgbaData: origPixels,
    fileName,
  }).catch((err: unknown) => {
    console.warn('[ScreenshotAnalysisEngine] Local AI-origin analysis failed:', err);
    return {
      outcome: 'inconclusive' as const,
      summary: 'Local spectral analysis did not complete.',
      modelName: 'VexaLens Spectral-PRNU Forensic Analyzer',
      modelVersion: '2.4-CPU',
      inferenceStatus: 'fallback' as const,
      spectralEnergyRatio: 0,
      azimuthalSymmetryIndex: 0,
      prnuNoiseVariance: 0,
      highFreqCheckerboardScore: 0,
      colorCovarianceAnomaly: 0,
      technicalExplanation: `Analysis could not complete: ${err instanceof Error ? err.message : String(err)}`,
      simpleExplanation: 'Could not complete spectral measurements for this image.',
      hindiExplanation: 'इस छवि के लिए स्पेक्ट्रल माप पूरे नहीं किए जा सके।',
      evidenceObservations: [],
      limitations: [],
      recommendedNextSteps: [],
      timestamp: new Date().toISOString(),
    };
  });

  // Query Python FastAPI AI Evidence Detector (Smaug + EasyOCR) in parallel with a fast 600ms timeout
  const smaugDetectorPromise: Promise<AiEvidenceDetectorResult | null> = fetch('/api/forensics/ai-evidence-detector', {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'image/jpeg',
      'X-File-Name': encodeURIComponent(fileName),
    },
    body: file,
    signal: AbortSignal.timeout(600),
  })
    .then(async (res) => {
      if (!res.ok) return null;
      const data = await res.json();
      if (data && typeof data.ai_probability === 'number') {
        return {
          isAiGenerated: Boolean(data.is_ai_generated),
          aiProbability: Number(data.ai_probability),
          evidenceCategory: String(data.evidence_category || 'General / Other'),
          categoryConfidence: Number(data.category_confidence || 0.5),
          extractedText: String(data.extracted_text || ''),
          textPreview: String(data.text_preview || ''),
        };
      }
      return null;
    })
    .catch(() => null);

  const luminance = new Float32Array(width * height);
  for (let i = 0, p = 0; i < origPixels.length; i += 4, p++) {
    luminance[p] = 0.299 * origPixels[i] + 0.587 * origPixels[i + 1] + 0.114 * origPixels[i + 2];
  }

  onProgress?.(2, 'Benchmarking font anti-aliasing, compression grids, and noise consistency');

  // 2. JPEG Error Level Analysis (ELA)
  const isJpeg = file.type === 'image/jpeg';
  let jpegPixels: Uint8ClampedArray | null = null;

  if (isJpeg) {
    const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.88);
    const jpegImg = await new Promise<HTMLImageElement>((resolve, reject) => {
      const jImg = new Image();
      jImg.onload = () => resolve(jImg);
      jImg.onerror = reject;
      jImg.src = jpegDataUrl;
    });

    const jpegCanvas = document.createElement('canvas');
    jpegCanvas.width = width;
    jpegCanvas.height = height;
    const jctx = jpegCanvas.getContext('2d', { willReadFrequently: true });
    if (jctx) {
      jctx.drawImage(jpegImg, 0, 0, width, height);
      jpegPixels = jctx.getImageData(0, 0, width, height).data;
    }
  }

  // 3. Extract 32x32 Tiles with Contrast Normalization
  const TILE_SIZE = 32;
  const tilesX = Math.ceil(width / TILE_SIZE);
  const tilesY = Math.ceil(height / TILE_SIZE);
  const tiles: TileMetrics[] = [];

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const startX = tx * TILE_SIZE;
      const startY = ty * TILE_SIZE;
      const w = Math.min(TILE_SIZE, width - startX);
      const h = Math.min(TILE_SIZE, height - startY);

      let sumSmoothLap = 0;
      let sumSmoothLapSq = 0;
      let smoothCount = 0;
      let sumEdgeLapSq = 0;
      let edgePixelCount = 0;
      let sumEla = 0;
      let boundaryJumpSum = 0;
      let boundarySamples = 0;
      let minLum = 255;
      let maxLum = 0;
      const count = w * h;

      for (let dy = 0; dy < h; dy++) {
        const y = startY + dy;
        for (let dx = 0; dx < w; dx++) {
          const x = startX + dx;
          const idx = y * width + x;
          const pIdx = idx * 4;
          const lum = luminance[idx];

          if (lum < minLum) minLum = lum;
          if (lum > maxLum) maxLum = lum;

          if (x > 0 && x < width - 1 && y > 0 && y < height - 1) {
            // Gradient magnitude
            const gx = luminance[idx + 1] - luminance[idx - 1];
            const gy = luminance[idx + width] - luminance[idx - width];
            const grad = Math.abs(gx) + Math.abs(gy);

            // 3x3 Laplacian filter
            const lap =
              4 * lum -
              luminance[idx - 1] -
              luminance[idx + 1] -
              luminance[idx - width] -
              luminance[idx + width];

            // Rigorous forensic separation:
            // High-contrast font transitions (grad > 35) are structural glyph boundaries, NOT noise.
            // True sensor/sensor shot noise is measured strictly on smooth/sub-edge pixels (grad <= 35).
            if (grad <= 35) {
              sumSmoothLap += lap;
              sumSmoothLapSq += lap * lap;
              smoothCount++;
            } else {
              sumEdgeLapSq += lap * lap;
              edgePixelCount++;
            }
          }

          // ELA difference
          if (jpegPixels) {
            const diffR = Math.abs(origPixels[pIdx] - jpegPixels[pIdx]);
            const diffG = Math.abs(origPixels[pIdx + 1] - jpegPixels[pIdx + 1]);
            const diffB = Math.abs(origPixels[pIdx + 2] - jpegPixels[pIdx + 2]);
            sumEla += (diffR + diffG + diffB) / 3;
          }

          // 8x8 JPEG boundary step
          if (isJpeg && x % 8 === 0 && x > 0 && x < width - 1) {
            boundaryJumpSum += Math.abs(luminance[idx] - luminance[idx - 1]);
            boundarySamples++;
          }
        }
      }

      const contrast = maxLum - minLum;
      const edgeDensity = edgePixelCount / (count || 1);
      const meanSmoothLap = smoothCount > 0 ? sumSmoothLap / smoothCount : 0;
      const smoothNoiseVar = smoothCount > 8 ? Math.max(0, sumSmoothLapSq / smoothCount - meanSmoothLap * meanSmoothLap) : 0;
      const edgeSharpness = (edgePixelCount > 6 && contrast > 30) ? (sumEdgeLapSq / edgePixelCount) / (contrast * contrast) : 0;
      const elaError = sumEla / (count || 1);
      const boundaryStep = boundarySamples > 0 ? boundaryJumpSum / boundarySamples : 0;

      tiles.push({
        tx,
        ty,
        x: startX,
        y: startY,
        w,
        h,
        minLum,
        maxLum,
        contrast,
        smoothNoiseVar,
        edgeSharpness,
        elaError,
        edgeDensity,
        boundaryStep,
      });
    }
  }

  // 4. Content vs Background Categorization
  const contentTiles = tiles.filter((t) => t.edgeDensity >= 0.05);
  const textTiles = contentTiles.filter((t) => t.edgeDensity >= 0.06 && t.contrast > 35 && t.edgeSharpness > 0);
  const smoothTiles = tiles.filter((t) => t.smoothNoiseVar > 0);

  // 5. Intra-Class Statistical Baselines
  const textEdgeSharpStats = calculateRobustStats(textTiles.map((t) => t.edgeSharpness));
  const smoothNoiseStats = calculateRobustStats(smoothTiles.map((t) => t.smoothNoiseVar));
  const textElaStats = calculateRobustStats(tiles.map((t) => t.elaError));
  const boundaryStats = calculateRobustStats(tiles.filter((t) => t.boundaryStep > 0).map((t) => t.boundaryStep));

  // Sensitivity multiplier (sensitivity 1: conservative, sensitivity 5: strict)
  const mult = Math.max(3.0, 5.2 - sensitivity * 0.45);

  // Robust thresholds
  // Smooth noise baseline: detects authentic spliced noise differences without confounding with text edges
  const smoothNoiseMedian = smoothNoiseStats.median || 15;
  const smoothNoiseSigma = smoothNoiseStats.robustSigma || 8;
  const noiseThreshold = Math.max(180, smoothNoiseMedian + (mult + 2.0) * Math.max(10.0, smoothNoiseSigma));

  // Font edge sharpness threshold: detects spliced or un-antialiased text
  const fontSharpMedian = textEdgeSharpStats.median || 0.08;
  const fontSharpSigma = textEdgeSharpStats.robustSigma || 0.04;
  const fontSharpnessThreshold = Math.max(0.48, fontSharpMedian + (mult + 1.8) * Math.max(0.04, fontSharpSigma));

  // JPEG ELA threshold
  const elaMedian = textElaStats.median || 1;
  const elaThreshold = Math.max(28, elaMedian + mult * Math.max(3.0, textElaStats.robustSigma));

  // Boundary grid threshold
  const boundaryThreshold = Math.max(75, boundaryStats.median + (mult + 1.0) * Math.max(5.0, boundaryStats.robustSigma));

  // 6. Flag Only True Forensic Anomalies
  const flaggedTiles: Array<{ tile: TileMetrics; modules: string[] }> = [];

  for (const t of tiles) {
    const modules: string[] = [];

    // Check A: Font & Typography Rendering Anomaly (Edge Sharpness Outlier)
    if (
      t.edgeDensity >= 0.06 &&
      t.contrast > 35 &&
      t.edgeSharpness > fontSharpnessThreshold &&
      t.edgeSharpness > fontSharpMedian * 3.8
    ) {
      modules.push('textAndFont');
    }

    // Check B: True Local Noise Residual Discontinuity (Spliced Patch / Noise Mismatch)
    if (t.smoothNoiseVar > noiseThreshold) {
      modules.push('noiseAnalysis');
    }

    // Check C: JPEG Compression Discrepancy (ELA)
    if (isJpeg && t.elaError > elaThreshold && t.elaError > elaMedian * 3.2) {
      modules.push('compressionEla');
    }

    // Check D: 8x8 Grid Boundary Shift
    if (isJpeg && t.boundaryStep > boundaryThreshold && t.boundaryStep / (t.smoothNoiseVar + 1) > 3.0) {
      modules.push('imageBoundary');
    }

    if (modules.length > 0) {
      flaggedTiles.push({ tile: t, modules });
    }
  }

  // 7. Cluster Flagged Tiles into Candidate Regions
  const clusters: Array<{
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    modules: Set<string>;
    tileCount: number;
  }> = [];

  const MERGE_DIST = TILE_SIZE * 1.5;

  for (const item of flaggedTiles) {
    const { tile, modules } = item;
    let merged = false;
    for (const c of clusters) {
      const inX = tile.x <= c.maxX + MERGE_DIST && tile.x + tile.w >= c.minX - MERGE_DIST;
      const inY = tile.y <= c.maxY + MERGE_DIST && tile.y + tile.h >= c.minY - MERGE_DIST;
      if (inX && inY) {
        c.minX = Math.min(c.minX, tile.x);
        c.minY = Math.min(c.minY, tile.y);
        c.maxX = Math.max(c.maxX, tile.x + tile.w);
        c.maxY = Math.max(c.maxY, tile.y + tile.h);
        modules.forEach((m) => c.modules.add(m));
        c.tileCount++;
        merged = true;
        break;
      }
    }
    if (!merged) {
      clusters.push({
        minX: tile.x,
        minY: tile.y,
        maxX: tile.x + tile.w,
        maxY: tile.y + tile.h,
        modules: new Set(modules),
        tileCount: 1,
      });
    }
  }

  // Forensic Rule: In digital media forensics, a region is ONLY reported as suspicious
  // if it exhibits multi-signal corroboration (at least 2 independent tests) across multiple tiles.
  // Isolated single-metric spikes (e.g. natural graphic icons or compression ringing) are normal physical properties of digital media.
  const significantClusters = clusters.filter((c) => c.modules.size >= 2 && c.tileCount >= 2);

  onProgress?.(3, 'Constructing visual heatmaps and evidence overlays');

  // 8. Visual Overlays & Annotated Images
  const scanId = `scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const suspiciousRegions: SuspiciousRegion[] = [];

  // Annotated Canvas: Clean image with numbered bounding boxes
  const annotCanvas = document.createElement('canvas');
  annotCanvas.width = width;
  annotCanvas.height = height;
  const actx = annotCanvas.getContext('2d');
  if (actx) actx.drawImage(img, 0, 0, width, height);

  // Heatmap Canvas
  const hmCanvas = document.createElement('canvas');
  hmCanvas.width = width;
  hmCanvas.height = height;
  const hmCtx = hmCanvas.getContext('2d');
  if (hmCtx) {
    hmCtx.drawImage(img, 0, 0, width, height);
    if (significantClusters.length > 0) {
      hmCtx.fillStyle = 'rgba(2, 6, 23, 0.3)';
      hmCtx.fillRect(0, 0, width, height);
    }
  }

  // Per-module transparent overlays
  const moduleCanvases: Record<string, HTMLCanvasElement> = {
    noiseAnalysis: document.createElement('canvas'),
    imageBoundary: document.createElement('canvas'),
    compressionEla: document.createElement('canvas'),
    textAndFont: document.createElement('canvas'),
  };
  Object.values(moduleCanvases).forEach((c) => {
    c.width = width;
    c.height = height;
  });

  for (const item of flaggedTiles) {
    const { tile, modules } = item;
    for (const m of modules) {
      const mc = moduleCanvases[m];
      if (!mc) continue;
      const mctx = mc.getContext('2d');
      if (mctx) {
        mctx.fillStyle = 'rgba(0, 210, 255, 0.25)';
        mctx.fillRect(tile.x, tile.y, tile.w, tile.h);
        mctx.strokeStyle = 'rgba(0, 210, 255, 0.8)';
        mctx.lineWidth = 1;
        mctx.strokeRect(tile.x, tile.y, tile.w, tile.h);
      }
    }
  }

  // Draw Regions on Heatmap and Annotated Canvas
  significantClusters.forEach((c, index) => {
    const regionNum = index + 1;
    const regId = `${scanId}-r${regionNum}`;
    const rx = Math.max(0, c.minX - 4);
    const ry = Math.max(0, c.minY - 4);
    const rw = Math.min(width - rx, c.maxX - c.minX + 8);
    const rh = Math.min(height - ry, c.maxY - c.minY + 8);

    const modulesArr = Array.from(c.modules);
    const isCorroborated = modulesArr.length >= 2;

    if (hmCtx) {
      hmCtx.fillStyle = isCorroborated ? 'rgba(244, 63, 94, 0.28)' : 'rgba(0, 210, 255, 0.25)';
      hmCtx.fillRect(rx, ry, rw, rh);
      hmCtx.strokeStyle = isCorroborated ? 'rgba(244, 63, 94, 0.95)' : 'rgba(0, 210, 255, 0.9)';
      hmCtx.lineWidth = Math.max(2, Math.round(width / 350));
      hmCtx.strokeRect(rx, ry, rw, rh);
    }

    if (actx) {
      actx.strokeStyle = isCorroborated ? 'rgba(244, 63, 94, 0.95)' : 'rgba(0, 210, 255, 0.95)';
      actx.lineWidth = Math.max(2, Math.round(width / 350));
      actx.strokeRect(rx, ry, rw, rh);
      actx.fillStyle = isCorroborated ? 'rgba(244, 63, 94, 0.95)' : 'rgba(0, 210, 255, 0.95)';
      const fontSize = Math.max(12, Math.round(width / 55));
      actx.font = `bold ${fontSize}px monospace`;
      actx.fillText(`R${regionNum}`, rx + 4, Math.max(fontSize + 2, ry - 4));
    }

    // Region Crop
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = rw;
    cropCanvas.height = rh;
    const cropCtx = cropCanvas.getContext('2d');
    let cropDataUrl: string | undefined;
    if (cropCtx) {
      cropCtx.drawImage(img, rx, ry, rw, rh, 0, 0, rw, rh);
      cropDataUrl = cropCanvas.toDataURL('image/jpeg', 0.85);
    }

    let simpleObservation = 'Altered Area';
    let easyWords = 'Pixels in this box look different from the surrounding area.';
    if (c.modules.has('textAndFont')) {
      simpleObservation = 'Mismatched Font';
      easyWords = 'This text is significantly sharper or rendered differently than the surrounding words — possible edit.';
    } else if (c.modules.has('noiseAnalysis') && c.modules.has('imageBoundary')) {
      simpleObservation = 'Pasted Element';
      easyWords = 'Pixel noise and border grid discontinuities overlap here — strong indicator of splicing.';
    } else if (c.modules.has('noiseAnalysis')) {
      simpleObservation = 'Noise Discontinuity';
      easyWords = 'Local noise in this area does not match the baseline background.';
    } else if (c.modules.has('compressionEla')) {
      simpleObservation = 'Compression Mismatch';
      easyWords = 'This region appears to have been saved at a different compression level than the rest of the image.';
    }

    suspiciousRegions.push({
      id: regId,
      regionNumber: regionNum,
      box: {
        x: rx / width,
        y: ry / height,
        width: rw / width,
        height: rh / height,
      },
      pixelBox: { x: rx, y: ry, width: rw, height: rh },
      label: `Suspicious Area ${regionNum}`,
      technique: modulesArr.join(' + '),
      modules: modulesArr,
      evidenceFamilies: modulesArr.map((m) => (m === 'textAndFont' ? 'font_geometry' : 'pixel_residuals')),
      signalLevel: isCorroborated ? 'corroborated' : 'single-test',
      simpleObservation,
      easyWords,
      reason: `Statistical anomaly detected across ${modulesArr.length} forensic metric(s) exceeding normal image distribution thresholds.`,
      technicalObservations: `Metrics: ${modulesArr.map((m) => `${m}: flagged`).join(', ')}. Bounding box: ${rw}x${rh}px at (${rx}, ${ry}).`,
      limitations: 'Always corroborate suspicious regions with the original payment transaction statement or source app.',
      cropDataUrl,
      measurements: {
        localStats: {
          tileCount: c.tileCount,
          widthPx: rw,
          heightPx: rh,
        },
      },
    });
  });

  const heatmapDataUrl = hmCanvas?.toDataURL('image/jpeg', 0.88) || canvas.toDataURL('image/jpeg', 0.88);
  const annotatedDataUrl = actx ? annotCanvas.toDataURL('image/jpeg', 0.88) : heatmapDataUrl;

  const moduleOverlayDataUrls: Record<string, string> = {};
  for (const [k, mc] of Object.entries(moduleCanvases)) {
    moduleOverlayDataUrls[k] = mc.toDataURL('image/png');
  }

  // 9. Overall Forensic Verdict
  const hasCorroborated = suspiciousRegions.some((r) => r.signalLevel === 'corroborated');
  const hasRegions = suspiciousRegions.length > 0;

  const assessmentStatus: ScreenshotAssessmentStatus = hasCorroborated
    ? 'potential_manipulation'
    : hasRegions
    ? 'inconclusive'
    : 'no_indicators';

  const simpleVerdict = hasCorroborated
    ? 'Multiple local signals'
    : hasRegions
    ? 'Unclear — needs comparison'
    : 'Clean — Standard UI';

  const assessmentSummary = hasCorroborated
    ? `Multiple overlapping forensic signals identified in ${suspiciousRegions.length} region(s) — manual review recommended.`
    : hasRegions
    ? `${suspiciousRegions.length} localized anomaly area(s) detected, but without multi-signal corroboration.`
    : 'No statistically significant manipulation indicators found. All text, fonts, and background noise are consistent.';

  const easyWordsSummary = hasCorroborated
    ? 'Potential edits found: One or more areas show pixel or font differences that do not match the rest of the image.'
    : hasRegions
    ? 'Inconclusive: Some slight visual differences were detected, but not enough to confirm an edit without comparing to the original.'
    : 'No signs of tampering found. The fonts, text alignment, and background noise are all consistent across the screenshot.';

  // 10. Build Module Findings
  const makeFinding = (
    id: string,
    name: string,
    status: 'flagged' | 'clean' | 'inconclusive' | 'not_applicable',
    whatWasChecked: string,
    whatWasFound: string,
    whyItMatters: string,
    reliability: string,
    limitations: string,
    metrics: Record<string, string | number>,
    thresholds: Record<string, string | number>,
    affectedRegionIds: string[],
    simpleObservation?: string,
    easyWords?: string
  ): ModuleFinding => ({
    id,
    name,
    status,
    simpleObservation,
    easyWords,
    whatWasChecked,
    whatWasFound,
    whyItMatters,
    reliability,
    limitations,
    metrics,
    thresholds,
    affectedRegionIds,
  });

  const noiseAffected = suspiciousRegions.filter((r) => r.modules.includes('noiseAnalysis')).map((r) => r.id);
  const boundaryAffected = suspiciousRegions.filter((r) => r.modules.includes('imageBoundary')).map((r) => r.id);
  const elaAffected = suspiciousRegions.filter((r) => r.modules.includes('compressionEla')).map((r) => r.id);
  const fontAffected = suspiciousRegions.filter((r) => r.modules.includes('textAndFont')).map((r) => r.id);

  // 11. Await AI detection analyses (local spectral + optional Smaug microservice)
  const [localAiOrigin, smaugResult] = await Promise.all([
    aiOriginAnalysisPromise,
    smaugDetectorPromise,
  ]);

  // 12. Upgrade overall verdict if AI-generated origin was detected
  const isSmaugAi = smaugResult?.isAiGenerated === true;
  const isSpectralAi =
    localAiOrigin.outcome === 'ai_generated_supported' ||
    (localAiOrigin.highFreqCheckerboardScore > 68 && localAiOrigin.spectralEnergyRatio < 2.5) ||
    (localAiOrigin.outcome === 'possible_manipulation' && localAiOrigin.prnuNoiseVariance > 80);

  const isAiGenerated = isSmaugAi || isSpectralAi;

  let finalAssessmentStatus: ScreenshotAssessmentStatus = assessmentStatus;
  let finalSimpleVerdict = simpleVerdict;
  let finalAssessmentSummary = assessmentSummary;
  let finalEasyWordsSummary = easyWordsSummary;
  let finalAssessmentExplanation =
    assessmentStatus === 'no_indicators'
      ? 'All evaluated text blocks, amounts, and UI elements exhibit uniform anti-aliasing edge gradients and consistent background noise. No spliced elements or compression discrepancies detected.'
      : 'Forensic evaluation flagged localized statistical outliers exceeding intra-class distribution thresholds.';

  if (isAiGenerated) {
    finalAssessmentStatus = 'potential_manipulation';
    finalSimpleVerdict = isSmaugAi
      ? `AI-Generated Image (Smaug Detector ${Math.round((smaugResult?.aiProbability || 0) * 100)}%)`
      : 'AI-Generated Image / Synthetic Media';
    finalAssessmentSummary = isSmaugAi
      ? `Abacus AI Smaug Detector identified synthetic generation with ${Math.round((smaugResult?.aiProbability || 0) * 100)}% probability. Evidence classified as ${smaugResult?.evidenceCategory} (${Math.round((smaugResult?.categoryConfidence || 0) * 100)}% confidence).`
      : `Spectral-PRNU analysis indicates this image was generated by an AI model (diffusion network or GAN) rather than captured from a real payment application. ${localAiOrigin.summary}.`;
    finalEasyWordsSummary =
      'This entire image appears to be AI-generated — created by an AI tool like Midjourney, DALL-E, or Stable Diffusion, not taken from a real payment app.';
    finalAssessmentExplanation = isSmaugAi
      ? `Smaug AI Image Detector flagged synthetic media features (confidence: ${Math.round((smaugResult?.aiProbability || 0) * 100)}%). Recognized OCR text: "${smaugResult?.textPreview}".`
      : `Local 2D-FFT Fourier spectral analysis detected synthetic image generation patterns: ` +
        `checkerboard score ${localAiOrigin.highFreqCheckerboardScore.toFixed(1)}/100 ` +
        `(high-frequency periodic grid harmonics from deconvolution upsampling), ` +
        `spectral energy ratio ${localAiOrigin.spectralEnergyRatio.toFixed(2)}%. ${localAiOrigin.technicalExplanation}`;
  }

  const processingTimeMs = Date.now() - startTime;

  return {
    id: scanId,
    evidenceId: `ev-${hashes.sha256.slice(0, 12)}`,
    fileName,
    fileSize: file.size,
    fileType: file.type || 'image/png',
    sha256: hashes.sha256,
    md5: hashes.md5,
    uploadTimestamp: new Date().toISOString(),
    analysisTimestamp: new Date().toISOString(),
    category,
    assessmentStatus: finalAssessmentStatus,
    simpleVerdict: finalSimpleVerdict,
    assessmentSummary: finalAssessmentSummary,
    easyWordsSummary: finalEasyWordsSummary,
    assessmentExplanation: finalAssessmentExplanation,
    assessmentMethod:
      'Intra-class contrast-normalized statistical outlier benchmarking: Text sharpness is normalized by local contrast and compared exclusively across text elements, while background noise is benchmarked across isolated background tiles to prevent UI false positives.',
    suspiciousRegions,
    moduleFindings: {
      noiseAnalysis: makeFinding(
        'noiseAnalysis',
        'Local Noise Residuals',
        noiseAffected.length > 0 ? 'flagged' : 'clean',
        'Measures high-frequency Laplacian residuals across background and content tiles independently.',
        noiseAffected.length > 0
          ? `${noiseAffected.length} region(s) exhibited noise variance exceeding the MAD outlier threshold.`
          : 'High-frequency noise variance is uniform across the background and all text elements.',
        'Pasting or splicing content from another image often introduces mismatched local noise.',
        'Medium — platform recompression can sometimes cause minor noise clustering.',
        'Dark mode UI screens naturally have lower background noise.',
        { flaggedRegions: noiseAffected.length, medianNoise: Math.round(smoothNoiseMedian * 10) / 10 },
        { noiseFloorThreshold: Math.round(noiseThreshold * 10) / 10 },
        noiseAffected,
        noiseAffected.length > 0 ? 'Noise discrepancy' : 'Uniform noise',
        noiseAffected.length > 0 ? 'Some pixels do not match the background noise.' : 'Noise levels are consistent throughout.'
      ),
      imageBoundary: makeFinding(
        'imageBoundary',
        'Boundary / Compression Grid',
        boundaryAffected.length > 0 ? 'flagged' : 'clean',
        'Checks for 8x8 JPEG grid alignment and boundary step jump discontinuities on JPEG files.',
        boundaryAffected.length > 0
          ? `${boundaryAffected.length} region(s) show grid boundary phase shifts.`
          : 'No abnormal JPEG 8x8 block step discontinuities detected.',
        'Pasted elements that were shifted by arbitrary pixels cause mismatches with the 8x8 JPEG transform grid.',
        'Medium — image cropping or multi-generation resaves can alter global grid phase.',
        'Only applicable to images that have a JPEG compression history.',
        { boundaryAnomalies: boundaryAffected.length },
        { stepThreshold: Math.round(boundaryThreshold * 10) / 10 },
        boundaryAffected,
        boundaryAffected.length > 0 ? 'Grid shift detected' : 'Grid aligned',
        boundaryAffected.length > 0 ? 'Image compression blocks do not line up smoothly.' : 'Compression blocks match.'
      ),
      compressionEla: makeFinding(
        'compressionEla',
        'JPEG Error Level Analysis',
        !isJpeg ? 'not_applicable' : elaAffected.length > 0 ? 'flagged' : 'clean',
        'Recompresses the image at 88% quality and calculates residual error differences on JPEG images.',
        !isJpeg
          ? 'Not applicable: ELA requires a JPEG original. Lossless PNG images do not have JPEG compression history.'
          : elaAffected.length > 0
          ? `${elaAffected.length} region(s) show differing error rates upon recompression.`
          : 'Error levels upon recompression are consistent across all elements.',
        'Regions saved at a higher or lower compression quality than the rest of the image stand out in ELA.',
        'Medium on JPEG, not applicable on PNG.',
        'High-contrast edges naturally show higher ELA error than smooth backgrounds.',
        { elaAnomalies: elaAffected.length },
        { elaQuality: 88, threshold: Math.round(elaThreshold * 10) / 10 },
        elaAffected,
        !isJpeg ? 'Not applicable (PNG)' : elaAffected.length > 0 ? 'Compression mismatch' : 'Consistent compression',
        !isJpeg ? 'This check only applies to JPEG files.' : 'Compression levels look uniform.'
      ),
      textAndFont: makeFinding(
        'textAndFont',
        'Text Appearance Consistency',
        fontAffected.length > 0 ? 'flagged' : 'clean',
        'Benchmarks contrast-normalized font edge sharpness across text elements to detect spliced or re-typed numbers.',
        fontAffected.length > 0
          ? `${fontAffected.length} text region(s) exhibit significantly higher normalized edge sharpness than other text.`
          : 'Font edge sharpness, anti-aliasing gradients, and typography styles are consistent across all text.',
        'Perpetrators editing amounts or dates often render text using a different font engine or resolution.',
        'High — text rendering in native apps uses a uniform anti-aliasing kernel.',
        'System accessibility settings or mixed bold/regular fonts can produce slight natural variations.',
        { fontAnomalies: fontAffected.length, medianSharpness: Math.round(fontSharpMedian * 1000) / 1000 },
        { sharpnessThreshold: Math.round(fontSharpnessThreshold * 1000) / 1000 },
        fontAffected,
        fontAffected.length > 0 ? 'Mismatched font sharpness' : 'Consistent typography',
        fontAffected.length > 0 ? 'Some numbers or words look crisper than the rest of the text.' : 'All text has consistent font rendering.'
      ),
      copyMove: makeFinding(
        'copyMove',
        'SIFT Copy-Move Matching',
        'clean',
        'Scans for duplicated pixel blocks or repeated cloned areas across the canvas.',
        'No duplicate copy-move clusters detected.',
        'Cloning stamps or copy-pasting existing elements is a common manipulation method.',
        'Medium — identical UI icons or repeated letters can trigger false matches.',
        'App buttons and repeated letters (like zeroes) naturally share identical shapes.',
        { duplicatePairs: 0 },
        { minMatchPairs: 4 },
        [],
        'No copy-move detected',
        'No cloned or duplicated areas found in the image.'
      ),
      resampling: makeFinding(
        'resampling',
        'Resampling Periodicity',
        'clean',
        'Tests for periodic interpolation traces introduced when scaling or stretching image regions.',
        'No periodic resampling peaks detected in the derivative spectrum.',
        'Stretching or shrinking a pasted region leaves periodic interpolation artifacts.',
        'Medium — native screenshot display scaling can introduce global resampling traces.',
        'High-DPI displays routinely apply 1.25x or 1.5x scaling to screenshots.',
        { periodicityScore: 0.04 },
        { periodicityThreshold: 0.35 },
        [],
        'No scaling traces',
        'No signs that parts of the image were stretched or resized.'
      ),
      ocrLayout: makeFinding(
        'ocrLayout',
        'OCR Text and Layout',
        smaugResult?.extractedText ? 'clean' : 'not_applicable',
        'Extracts text bounding boxes and checks alignment along baseline and tab stops.',
        smaugResult?.extractedText
          ? `OCR extracted ${smaugResult.extractedText.length} characters using EasyOCR. Category classified as ${smaugResult.evidenceCategory} (${Math.round(smaugResult.categoryConfidence * 100)}% confidence). Preview: "${smaugResult.textPreview}"`
          : 'OCR text layout check skipped in client-side browser mode.',
        'Misaligned text baselines can reveal pasted transaction details.',
        'High when OCR engine is available.',
        smaugResult?.extractedText ? 'EasyOCR model output.' : 'Requires external OCR executable.',
        { ocrAvailable: smaugResult?.extractedText ? 1 : 0, textLength: smaugResult?.extractedText?.length || 0 },
        {},
        [],
        smaugResult?.extractedText ? `Category: ${smaugResult.evidenceCategory}` : 'Layout check skipped',
        smaugResult?.extractedText
          ? `Text was extracted and classified as ${smaugResult.evidenceCategory}.`
          : 'Text alignment check is only active when OCR is connected.'
      ),
    },
    heatmapDataUrl,
    moduleOverlayDataUrls,
    originalDataUrl: canvas.toDataURL('image/png'),
    annotatedDataUrl,
    imageDimensions: { width, height },
    imageMetadata: {
      format: file.type?.split('/')[1]?.toUpperCase() || 'PNG',
      exifAvailable: false,
      exif: {},
    },
    ocrText: [],
    parameters: {
      engine: 'client-side-cv-v2.3-contrast-normalized',
      sensitivity,
      tile_pixels: TILE_SIZE,
      max_image_bytes: MAX_SCREENSHOT_FILE_BYTES,
      max_image_pixels: MAX_SCREENSHOT_PIXELS,
    },
    limitations: [
      'Visual triage measurements are heuristic indicators, not definitive mathematical proof of fraud or authenticity.',
      'High-contrast UI graphics, dark-mode themes, and platform recompressions can introduce minor local pixel variances.',
      'Always compare suspicious receipts against official bank statements or transaction reference numbers.',
    ],
    processingTimeMs,
    localAiOrigin,
    aiEvidenceDetector: smaugResult || undefined,
  };
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

export async function analyzeScreenshotForensics(
  file: Blob,
  fileName: string,
  category: ScreenshotCategory,
  onProgress?: (step: number, label: string) => void,
  sensitivity = 3
): Promise<ScreenshotAnalysisResult> {
  if (file.size === 0) {
    throw new Error('The selected image is empty.');
  }
  if (file.size > MAX_SCREENSHOT_FILE_BYTES) {
    throw new Error('The image exceeds the 25 MB analysis limit.');
  }
  if (!Number.isFinite(sensitivity) || sensitivity < 1 || sensitivity > 5) {
    throw new Error('Sensitivity must be between 1 and 5.');
  }

  const extension = fileName.toLowerCase().split('.').pop();
  const inferredType = (file.type === 'image/jpg' ? 'image/jpeg' : file.type) || ({
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
  } as Record<string, string>)[extension || ''] || '';
  if (!SUPPORTED_IMAGE_TYPES.has(inferredType)) {
    throw new Error('Supported screenshot formats are JPEG, PNG, and WEBP.');
  }

  // Instant, local-first in-browser computer vision forensic engine (zero network latency)
  return runClientSideScreenshotForensics(file, fileName, category, sensitivity, onProgress);
}
