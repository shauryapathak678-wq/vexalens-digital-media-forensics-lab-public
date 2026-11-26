import { ELAParams, EvidenceMetadata } from '@/types/forensics';
import { inspectC2PAManifest } from '@/lib/forensics/c2pa';

export type ELAReliability = 'high' | 'medium' | 'low';

export type ELAVerdict =
  | 'no_local_edits_detected'
  | 'possible_local_edit'
  | 'global_recompression'
  | 'not_reliable';

export interface ELAHotspot {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  xPct: number;
  yPct: number;
  widthPct: number;
  heightPct: number;
  area_pct: number;
  mean_z: number;
  peak_z: number;
  locationName: string;
  description: string;
}

export interface ELAReliabilityAssessment {
  reliability: ELAReliability;
  reliabilityReasons: string[];
  isMessagingAppSuspect: boolean;
  messagingAppName?: string;
  hasExif: boolean;
  format: string;
  isJpeg: boolean;
  dimensions?: { width: number; height: number };
  estimatedJpegQuality?: number;
  recompressionSigns: string[];
}

export interface StructuredForensicVerdict {
  reliability: ELAReliability;
  reliability_reasons: string[];
  ela_verdict: ELAVerdict;
  hotspots: ELAHotspot[];
  exif_summary: {
    hasExif: boolean;
    cameraMake?: string;
    cameraModel?: string;
    software?: string;
    dateTimeOriginal?: string;
    isMessagingAppSuspect: boolean;
    messagingAppName?: string;
    format: string;
    dimensions?: { width: number; height: number };
    estimatedJpegQuality?: number;
    recompressionSigns?: string[];
  };
  ai_origin: {
    status: 'not_assessed' | 'signals_found' | 'none_found';
    signals: string[];
    details: string;
  };
  metrics?: {
    resaveQuality: number;
    blockSize: number;
    zThreshold: number;
    medianBlockDiff: number;
    madBlockDiff: number;
    scaledMAD: number;
    totalBlocks: number;
    anomalousBlocks: number;
    coveragePct: number;
    p99Diff: number;
    meanDiff: number;
  };
}

export interface ELAResult extends StructuredForensicVerdict {
  dataUrl: string;
  width: number;
  height: number;
  plainEnglishExplanation: string;
  hindiExplanation: string;
  formatWarning?: string | null;
  qualityWarning?: string | null;
  disclaimer: string;
  calculationMethod?: string;
}

/**
 * 8-stop smooth perceptual colormap (Dark Navy -> Deep Blue -> Cyan -> Emerald -> Amber -> Crimson)
 * Ensures compression structure is clearly visible and never renders as a flat black heatmap.
 */
const PERCEPTUAL_STOPS: [number, number, number, number][] = [
  [0.00,  15,  23,  42], // Deep Navy / Slate
  [0.15,  30,  58, 138], // Deep Blue
  [0.35,  14, 116, 144], // Cyan / Ocean
  [0.55,  16, 185, 129], // Emerald / Teal Green
  [0.72, 234, 179,   8], // Warm Amber / Yellow
  [0.88, 249, 115,  22], // Bright Orange
  [1.00, 239,  68,  68], // Vivid Crimson Red
];

export function getPerceptualRgb(t: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));
  for (let i = 0; i < PERCEPTUAL_STOPS.length - 1; i++) {
    const s0 = PERCEPTUAL_STOPS[i];
    const s1 = PERCEPTUAL_STOPS[i + 1];
    if (clamped >= s0[0] && clamped <= s1[0]) {
      const span = s1[0] - s0[0];
      const localT = span > 0 ? (clamped - s0[0]) / span : 0;
      const r = Math.round(s0[1] + (s1[1] - s0[1]) * localT);
      const g = Math.round(s0[2] + (s1[2] - s0[2]) * localT);
      const b = Math.round(s0[3] + (s1[3] - s0[3]) * localT);
      return [r, g, b];
    }
  }
  return [239, 68, 68];
}

/**
 * Computes 2D Sobel edge magnitude across luminance channel.
 * Used to down-weight edge blocks so high-contrast text and natural edges do not trigger false positive hotspots.
 */
export function computeSobelEdgeMagnitude(
  rgbaPixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number
): Float32Array {
  const total = width * height;
  const edges = new Float32Array(total);
  if (width < 3 || height < 3) return edges;

  const lum = new Float32Array(total);
  for (let p = 0; p < total; p++) {
    const i = p * 4;
    lum[p] = 0.299 * rgbaPixels[i] + 0.587 * rgbaPixels[i + 1] + 0.114 * rgbaPixels[i + 2];
  }

  for (let y = 1; y < height - 1; y++) {
    const rowPrev = (y - 1) * width;
    const rowCurr = y * width;
    const rowNext = (y + 1) * width;

    for (let x = 1; x < width - 1; x++) {
      const gx =
        (lum[rowPrev + x + 1] + 2 * lum[rowCurr + x + 1] + lum[rowNext + x + 1]) -
        (lum[rowPrev + x - 1] + 2 * lum[rowCurr + x - 1] + lum[rowNext + x - 1]);

      const gy =
        (lum[rowNext + x - 1] + 2 * lum[rowNext + x] + lum[rowNext + x + 1]) -
        (lum[rowPrev + x - 1] + 2 * lum[rowPrev + x] + lum[rowPrev + x - 1]);

      edges[rowCurr + x] = Math.sqrt(gx * gx + gy * gy) / 4;
    }
  }

  return edges;
}

/**
 * Hotspot Detection using robust block statistics (Median and MAD scaled by 1.4826).
 *
 * Rules:
 * - 32x32 block means with Sobel edge attenuation
 * - z = (blockMean - median) / (1.4826 * MAD)
 * - Anomalous only if z > threshold (default 6.0)
 * - 8-connected components, discard < 3 blocks (noise)
 * - If anomalous blocks cover > 20% of image, report 'global error pattern, not a local edit' and show NO hotspots
 * - Never flag "top-scoring region" by default; 0 hotspots is a common, valid result
 */
export function detectHotspots(
  unscaledDifferences: Float32Array,
  width: number,
  height: number,
  edgeMagnitude?: Float32Array,
  blockSize: number = 32,
  zThreshold: number = 6.0
): {
  hotspots: ELAHotspot[];
  isGlobalPattern: boolean;
  blockStats: {
    median: number;
    mad: number;
    scaledMAD: number;
    totalBlocks: number;
    anomalousBlocks: number;
    coveragePct: number;
  };
} {
  if (width < blockSize || height < blockSize || unscaledDifferences.length === 0) {
    return {
      hotspots: [],
      isGlobalPattern: false,
      blockStats: { median: 0, mad: 0, scaledMAD: 0, totalBlocks: 0, anomalousBlocks: 0, coveragePct: 0 },
    };
  }

  const cols = Math.ceil(width / blockSize);
  const rows = Math.ceil(height / blockSize);
  const totalBlocks = cols * rows;

  if (totalBlocks === 0) {
    return {
      hotspots: [],
      isGlobalPattern: false,
      blockStats: { median: 0, mad: 0, scaledMAD: 0, totalBlocks: 0, anomalousBlocks: 0, coveragePct: 0 },
    };
  }

  // 1. Calculate block means for error and edge strength
  const blockMeans: number[][] = [];
  const edgeMeans: number[][] = [];
  const rawBlockList: number[] = [];
  const rawEdgeList: number[] = [];

  for (let r = 0; r < rows; r++) {
    blockMeans[r] = [];
    edgeMeans[r] = [];
    const startY = r * blockSize;
    const endY = Math.min(height, (r + 1) * blockSize);

    for (let c = 0; c < cols; c++) {
      const startX = c * blockSize;
      const endX = Math.min(width, (c + 1) * blockSize);

      let errSum = 0;
      let edgeSum = 0;
      let count = 0;

      for (let y = startY; y < endY; y++) {
        const rowOffset = y * width;
        for (let x = startX; x < endX; x++) {
          const idx = rowOffset + x;
          errSum += unscaledDifferences[idx];
          if (edgeMagnitude) edgeSum += edgeMagnitude[idx];
          count++;
        }
      }

      const meanErr = count > 0 ? errSum / count : 0;
      const meanEdge = count > 0 ? edgeSum / count : 0;

      blockMeans[r][c] = meanErr;
      edgeMeans[r][c] = meanEdge;
      rawBlockList.push(meanErr);
      if (edgeMagnitude) rawEdgeList.push(meanEdge);
    }
  }

  // Calculate median edge to attenuate natural high-contrast edges and text
  let edgeMedian = 0;
  if (rawEdgeList.length > 0) {
    const sortedEdges = [...rawEdgeList].sort((a, b) => a - b);
    edgeMedian = sortedEdges[Math.floor(sortedEdges.length / 2)] || 0;
  }

  // 2. Compute effective block values with edge attenuation
  const effectiveBlockList: number[] = [];
  const effectiveGrid: number[][] = [];

  for (let r = 0; r < rows; r++) {
    effectiveGrid[r] = [];
    for (let c = 0; c < cols; c++) {
      const bMean = blockMeans[r][c];
      const eMean = edgeMeans[r][c];

      // If block has high edge concentration relative to baseline, attenuate to prevent edge false positives
      let eff = bMean;
      if (edgeMagnitude && eMean > Math.max(5, edgeMedian)) {
        const edgeRatio = eMean / Math.max(1, edgeMedian);
        eff = bMean / (1 + 0.65 * Math.min(4, edgeRatio));
      }

      effectiveGrid[r][c] = eff;
      effectiveBlockList.push(eff);
    }
  }

  // 3. Robust statistics: Median and MAD
  const sorted = [...effectiveBlockList].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;

  const absDeviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = absDeviations[Math.floor(absDeviations.length / 2)] || 0;
  const scaledMAD = 1.4826 * mad;

  // 4. Mark anomalous blocks (z > threshold)
  const isAnomalous: boolean[][] = Array.from({ length: rows }, () => Array(cols).fill(false));
  const zScores: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));
  let anomalousCount = 0;

  if (scaledMAD > 0) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const z = (effectiveGrid[r][c] - median) / scaledMAD;
        zScores[r][c] = z;
        if (z > zThreshold) {
          isAnomalous[r][c] = true;
          anomalousCount++;
        }
      }
    }
  }

  const coveragePct = Math.round((anomalousCount / totalBlocks) * 1000) / 10;
  const q1 = sorted[Math.floor((sorted.length - 1) * 0.25)] || 0;
  const q3 = sorted[Math.floor((sorted.length - 1) * 0.75)] || 0;
  const diffuseGlobalPattern = median >= 3 && q3 - q1 < median * 0.35;

  // Broad coverage or consistently elevated blocks indicate global, not localized, differences.
  if (coveragePct > 20.0 || diffuseGlobalPattern) {
    return {
      hotspots: [],
      isGlobalPattern: true,
      blockStats: {
        median: Math.round(median * 100) / 100,
        mad: Math.round(mad * 100) / 100,
        scaledMAD: Math.round(scaledMAD * 100) / 100,
        totalBlocks,
        anomalousBlocks: anomalousCount,
        coveragePct,
      },
    };
  }

  // 6. Connected Components (8-way BFS / flood fill)
  const visited: boolean[][] = Array.from({ length: rows }, () => Array(cols).fill(false));
  const rawComponents: Array<{
    minR: number;
    maxR: number;
    minC: number;
    maxC: number;
    blockCount: number;
    sumZ: number;
    peakZ: number;
  }> = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!isAnomalous[r][c] || visited[r][c]) continue;

      let minR = r;
      let maxR = r;
      let minC = c;
      let maxC = c;
      let blockCount = 0;
      let sumZ = 0;
      let peakZ = zScores[r][c];

      const queue: [number, number][] = [[r, c]];
      visited[r][c] = true;

      while (queue.length > 0) {
        const [cr, cc] = queue.shift()!;
        blockCount++;
        const zVal = zScores[cr][cc];
        sumZ += zVal;
        if (zVal > peakZ) peakZ = zVal;

        if (cr < minR) minR = cr;
        if (cr > maxR) maxR = cr;
        if (cc < minC) minC = cc;
        if (cc > maxC) maxC = cc;

        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = cr + dr;
            const nc = cc + dc;
            if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
              if (isAnomalous[nr][nc] && !visited[nr][nc]) {
                visited[nr][nc] = true;
                queue.push([nr, nc]);
              }
            }
          }
        }
      }

      // Discard components smaller than 3 blocks (noise filter)
      if (blockCount >= 3) {
        rawComponents.push({ minR, maxR, minC, maxC, blockCount, sumZ, peakZ });
      }
    }
  }

  // Sort by peak z-score descending
  rawComponents.sort((a, b) => b.peakZ - a.peakZ);

  // Convert to real bounding boxes with precise image coordinates
  const hotspots: ELAHotspot[] = rawComponents.map((comp, idx) => {
    const rawX = comp.minC * blockSize;
    const rawY = comp.minR * blockSize;
    const rawW = (comp.maxC - comp.minC + 1) * blockSize;
    const rawH = (comp.maxR - comp.minR + 1) * blockSize;

    const x = Math.max(0, rawX);
    const y = Math.max(0, rawY);
    const w = Math.min(width - x, rawW);
    const h = Math.min(height - y, rawH);

    const xPct = Math.round((x / width) * 1000) / 10;
    const yPct = Math.round((y / height) * 1000) / 10;
    const widthPct = Math.round((w / width) * 1000) / 10;
    const heightPct = Math.round((h / height) * 1000) / 10;

    const area_pct = Math.round(((w * h) / (width * height)) * 1000) / 10;
    const mean_z = Math.round((comp.sumZ / comp.blockCount) * 10) / 10;
    const peak_z = Math.round(comp.peakZ * 10) / 10;

    const xMid = (x + w / 2) / width;
    const yMid = (y + h / 2) / height;
    const vLabel = yMid < 0.35 ? 'Upper' : yMid > 0.65 ? 'Lower' : 'Middle';
    const hLabel = xMid < 0.35 ? 'Left' : xMid > 0.65 ? 'Right' : 'Center';
    const locationName = (vLabel === 'Middle' && hLabel === 'Center') ? 'Central Region' : `${vLabel}-${hLabel} Area`;

    return {
      id: `ela_hotspot_${idx + 1}`,
      x,
      y,
      w,
      h,
      xPct,
      yPct,
      widthPct,
      heightPct,
      area_pct,
      mean_z,
      peak_z,
      locationName,
      description: `Localized compression anomaly detected (peak z = ${peak_z.toFixed(1)}, mean z = ${mean_z.toFixed(1)} vs MAD baseline). Area covers ${area_pct.toFixed(1)}% of frame.`,
    };
  });

  return {
    hotspots,
    isGlobalPattern: false,
    blockStats: {
      median: Math.round(median * 100) / 100,
      mad: Math.round(mad * 100) / 100,
      scaledMAD: Math.round(scaledMAD * 100) / 100,
      totalBlocks,
      anomalousBlocks: anomalousCount,
      coveragePct,
    },
  };
}

/**
 * Reliability Gate: Evaluates whether ELA is scientifically valid for the file.
 * Must run BEFORE the forensic verdict.
 */
export function evaluateELAReliability({
  fileName,
  fileType,
  metadata,
  dimensions,
  estimatedJpegQuality,
}: {
  fileName: string;
  fileType?: string;
  metadata?: Partial<EvidenceMetadata>;
  dimensions?: { width: number; height: number };
  estimatedJpegQuality?: number;
}): ELAReliabilityAssessment {
  const reasons: string[] = [];
  const recompressionSigns: string[] = [];
  const lowerName = fileName.toLowerCase();

  // 1. Format check
  const formatHint = (fileType || metadata?.fileFormat || '').toLowerCase();
  const isJpeg = formatHint
    ? /image\/(jpeg|jpg)|image\/p?jpeg/i.test(formatHint)
    : /\.(jpe?g|jfif)$/i.test(lowerName);
  const ext = formatHint.includes('/')
    ? formatHint.split('/').pop() || 'unknown'
    : lowerName.split('.').pop() || 'unknown';

  if (!isJpeg) {
    reasons.push(
      `File format (${ext.toUpperCase()}) is not native JPEG. Error Level Analysis relies on lossy discrete cosine transform (DCT) quantization history; non-JPEG formats (PNG, WebP, screenshots) do not contain authentic single-generation JPEG quantization artifacts.`
    );
  }

  // 2. Messaging / social app detection
  let isMessagingAppSuspect = false;
  let messagingAppName: string | undefined;

  const metadataText = [
    metadata?.software,
    ...Object.entries(metadata?.rawExif || {}).flatMap(([group, values]) =>
      values && typeof values === 'object'
        ? Object.entries(values as Record<string, unknown>).map(([key, value]) => `${group} ${key} ${JSON.stringify(value)}`)
        : [`${group} ${String(values)}`]
    ),
  ].join(' ');
  const messagingText = `${lowerName} ${metadataText}`;

  if (/whatsapp|img-\d{8}-wa|\bwa\d{4}\b/i.test(messagingText)) {
    isMessagingAppSuspect = true;
    messagingAppName = 'WhatsApp';
  } else if (/telegram/i.test(messagingText)) {
    isMessagingAppSuspect = true;
    messagingAppName = 'Telegram';
  } else if (/fb_img|facebook/i.test(messagingText)) {
    isMessagingAppSuspect = true;
    messagingAppName = 'Facebook';
  } else if (/instagram/i.test(messagingText)) {
    isMessagingAppSuspect = true;
    messagingAppName = 'Instagram';
  } else if (/signal/i.test(messagingText)) {
    isMessagingAppSuspect = true;
    messagingAppName = 'Signal';
  } else if (/screenshot/i.test(messagingText)) {
    isMessagingAppSuspect = true;
    messagingAppName = 'Screen Capture';
  } else if (/facebook|instagram|telegram|whatsapp/i.test(messagingText)) {
    isMessagingAppSuspect = true;
    messagingAppName = 'Social app';
  }

  if (isMessagingAppSuspect) {
    reasons.push(
      `Filename indicates the media was transmitted or exported through ${messagingAppName}. Mobile messaging networks strip original camera EXIF and recompress media with lossy multi-generation encoders, rendering ELA differentials unreliable.`
    );
    recompressionSigns.push(`Known ${messagingAppName} recompression pipeline`);
  }

  // 3. EXIF presence check
  const hasCameraTags = Boolean(
    metadata?.cameraMake ||
    metadata?.cameraModel ||
    metadata?.iso ||
    metadata?.exposureTime ||
    metadata?.focalLength ||
    metadata?.dateTimeOriginal
  );

  const hasExif = Boolean(hasCameraTags || (metadata?.rawExif && Object.keys(metadata.rawExif).length > 0));

  if (!hasExif) {
    reasons.push(
      'No camera EXIF metadata detected. The file lacks original camera sensor and capture tags (Make, Model, Exposure), indicating metadata was stripped during re-saving, editing, or platform transmission.'
    );
    recompressionSigns.push('Stripped EXIF metadata structure');
  }

  // 4. Dimensions check (typical of messaging apps)
  const w = dimensions?.width || 0;
  const h = dimensions?.height || 0;
  const maxDim = Math.max(w, h);
  let appResizedDimensions = false;
  if (w > 0 && h > 0) {
    appResizedDimensions = [720, 960, 1024, 1280, 1600].some((limit) => maxDim === limit);

    if (appResizedDimensions && !hasCameraTags) {
      reasons.push(
        `Image dimensions (${w}×${h}) match standard mobile messaging/social app downscaling limits (1600px/1280px cap).`
      );
      recompressionSigns.push(`App-resized raster boundary (${w}×${h})`);
    }
  }

  // 5. Quantization error baseline check
  if (estimatedJpegQuality !== undefined && estimatedJpegQuality < 70) {
    reasons.push(`JPEG quantization tables estimate a low encoding quality (${estimatedJpegQuality}/100), which reduces ELA reliability.`);
    recompressionSigns.push('Low JPEG quantization-table quality estimate');
  }
  if (isMessagingAppSuspect && !hasExif) recompressionSigns.push('Missing EXIF alongside a messaging-app indicator');

  // Determine overall reliability
  let reliability: 'high' | 'medium' | 'low';
  if (!isJpeg || isMessagingAppSuspect || (estimatedJpegQuality !== undefined && estimatedJpegQuality < 70) ||
      recompressionSigns.length >= 2 || (appResizedDimensions && !hasExif)) {
    reliability = 'low';
  } else if (!hasExif || reasons.length > 0) {
    reliability = 'medium';
  } else {
    reliability = 'high';
  }

  return {
    reliability,
    reliabilityReasons: reasons,
    isMessagingAppSuspect,
    messagingAppName,
    hasExif,
    format: ext.toUpperCase(),
    isJpeg,
    dimensions: w && h ? { width: w, height: h } : undefined,
    estimatedJpegQuality,
    recompressionSigns,
  };
}

function jpegQualityTableFor(base: number[], quality: number): number[] {
  const scale = quality < 50 ? Math.floor(5000 / quality) : 200 - quality * 2;
  return base.map((value) => Math.max(1, Math.min(255, Math.floor((value * scale + 50) / 100))));
}

/**
 * Estimates the most likely IJG quality represented by JPEG DQT tables.
 * Non-standard tables are left unestimated rather than assigned a guessed quality.
 */
export function estimateJpegQuality(bytes: ArrayBuffer): number | undefined {
  const data = new Uint8Array(bytes);
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined;
  const tables: number[][] = [];
  let offset = 2;

  while (offset + 4 < data.length) {
    if (data[offset] !== 0xff) break;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const segmentLength = (data[offset] << 8) | data[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > data.length) break;
    if (marker === 0xdb) {
      let tableOffset = offset + 2;
      const segmentEnd = offset + segmentLength;
      while (tableOffset < segmentEnd) {
        const info = data[tableOffset++];
        const precision = info >> 4;
        const valueBytes = precision === 0 ? 1 : 2;
        const count = 64 * valueBytes;
        if (tableOffset + count > segmentEnd) break;
        const values: number[] = [];
        for (let i = 0; i < 64; i++) {
          values.push(valueBytes === 1
            ? data[tableOffset + i]
            : (data[tableOffset + i * 2] << 8) | data[tableOffset + i * 2 + 1]);
        }
        tables.push(values);
        tableOffset += count;
      }
    }
    offset += segmentLength;
  }

  if (!tables.length) return undefined;
  const bases = [
    [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99],
    [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99],
  ];
  const qualityEstimates = tables.map((table) => {
    let bestQuality = 0;
    let bestError = Number.POSITIVE_INFINITY;
    for (const base of bases) {
      for (let quality = 1; quality <= 100; quality++) {
        const expected = jpegQualityTableFor(base, quality);
        const error = table.reduce((sum, value, index) => sum + Math.abs(value - expected[index]), 0) / table.length;
        if (error < bestError) {
          bestError = error;
          bestQuality = quality;
        }
      }
    }
    return bestError <= 2 ? bestQuality : undefined;
  }).filter((quality): quality is number => quality !== undefined);
  return qualityEstimates.length ? Math.round(qualityEstimates.reduce((sum, quality) => sum + quality, 0) / qualityEstimates.length) : undefined;
}

async function loadSourceBytes(source?: File | Blob | ArrayBuffer | string): Promise<ArrayBuffer | undefined> {
  if (!source) return undefined;
  if (source instanceof ArrayBuffer) return source;
  if (typeof Blob !== 'undefined' && source instanceof Blob) return source.arrayBuffer();
  if (typeof source !== 'string') return undefined;
  if (source.startsWith('data:')) {
    const binary = atob(source.split(',')[1] || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
  if (/^(https?:\/\/|blob:)/i.test(source)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(source, { signal: controller.signal });
      if (!response.ok) throw new Error(`Metadata source could not be read (HTTP ${response.status}).`);
      return await response.arrayBuffer();
    } finally {
      clearTimeout(timeout);
    }
  }
  return undefined;
}

/**
 * AI-Origin check limited to verifiable metadata and C2PA Content Credentials manifests.
 * Never claims AI generation from ELA pixel differences. Always resolves quickly with a timeout.
 */
export async function auditAIOriginMetadata(params: {
  metadata?: Partial<EvidenceMetadata>;
  fileOrBuffer?: File | Blob | ArrayBuffer | string;
  fileName?: string;
}): Promise<{
  status: 'not_assessed' | 'signals_found' | 'none_found';
  signals: string[];
  details: string;
  generatorName?: string;
  hasC2pa: boolean;
}> {
  const signals: string[] = [];
  let generatorName: string | undefined;
  let hasC2pa = false;
  let c2paReadError: string | undefined;

  const { metadata, fileOrBuffer } = params;

  // 1. Inspect C2PA manifest if binary buffer is available
  if (fileOrBuffer) {
    try {
      let arrayBuffer: ArrayBuffer | null = null;
      if (fileOrBuffer instanceof ArrayBuffer) {
        arrayBuffer = fileOrBuffer;
      } else if (typeof Blob !== 'undefined' && fileOrBuffer instanceof Blob) {
        arrayBuffer = await fileOrBuffer.arrayBuffer();
      } else if (typeof fileOrBuffer === 'string' && fileOrBuffer.startsWith('data:')) {
        const b64 = fileOrBuffer.split(',')[1] || '';
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        arrayBuffer = bytes.buffer;
      } else if (typeof fileOrBuffer === 'string' && /^(https?:\/\/|blob:)/i.test(fileOrBuffer)) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        try {
          const resp = await fetch(fileOrBuffer, { signal: controller.signal });
          if (!resp.ok) throw new Error(`Metadata source could not be read (HTTP ${resp.status}).`);
          arrayBuffer = await resp.arrayBuffer();
        } finally {
          clearTimeout(timeout);
        }
      }

      if (arrayBuffer) {
        if (arrayBuffer.byteLength > 25 * 1024 * 1024) {
          throw new Error('Metadata origin check is limited to 25 MB.');
        }
        const c2paResult = await Promise.race([
          inspectC2PAManifest(arrayBuffer),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('C2PA inspection timed out.')), 3000)),
        ]);
        if (c2paResult.hasManifest) {
          hasC2pa = true;
          if (c2paResult.digitalSourceType?.includes('trainedAlgorithmicMedia')) {
            signals.push('C2PA manifest declares DigitalSourceType = trainedAlgorithmicMedia (synthetic/AI generated)');
          }
          if (c2paResult.claimGenerator && /midjourney|dall.?e|stable.?diffusion|comfyui|firefly|imagen|flux/i.test(c2paResult.claimGenerator)) {
            signals.push(`C2PA claim generator: ${c2paResult.claimGenerator}`);
            generatorName = c2paResult.claimGenerator;
          }
        }
      }
    } catch (c2paErr) {
      c2paReadError = c2paErr instanceof Error ? c2paErr.message : String(c2paErr);
    }
  }

  // 2. Inspect EXIF, XMP, and IPTC fields in metadata
  if (metadata) {
    const raw = metadata.rawExif || {};
    const textPool: string[] = [];

    if (metadata.software) textPool.push(`Software: ${metadata.software}`);
    if (metadata.cameraMake) textPool.push(`Make: ${metadata.cameraMake}`);
    if (metadata.cameraModel) textPool.push(`Model: ${metadata.cameraModel}`);

    const searchKeys = [
      'software', 'softwareagent', 'creatortool', 'usercomment', 'imagedescription',
      'parameters', 'comment', 'prompt', 'workflow', 'history', 'documentid', 'digitalsourcetype'
    ];

    for (const group of Object.values(raw)) {
      if (group && typeof group === 'object') {
        for (const [k, v] of Object.entries(group as Record<string, any>)) {
          if (searchKeys.some((sk) => k.toLowerCase().includes(sk))) {
            const valStr = typeof v === 'object' && v !== null ? (v.description ?? v.value ?? JSON.stringify(v)) : String(v);
            if (valStr) textPool.push(`${k}: ${valStr}`);
          }
        }
      }
    }

    const combinedText = textPool.join(' | ');

    const aiPatterns: [RegExp, string][] = [
      [/midjourney/i, 'Midjourney'],
      [/dall[-·]?e/i, 'DALL-E (OpenAI)'],
      [/stable[\s_-]?diffusion/i, 'Stable Diffusion'],
      [/comfyui/i, 'ComfyUI'],
      [/automatic1111/i, 'Automatic1111 WebUI'],
      [/invokeai/i, 'InvokeAI'],
      [/novelai/i, 'NovelAI'],
      [/adobe[\s_-]?firefly/i, 'Adobe Firefly'],
      [/bing\s*image\s*creator|designer/i, 'Microsoft Designer / Bing Image Creator'],
      [/flux(\.1)?/i, 'Flux (Black Forest Labs)'],
      [/google\s*imagen/i, 'Google Imagen'],
      [/trainedalgorithmicmedia/i, 'IPTC DigitalSourceType (trainedAlgorithmicMedia)'],
    ];

    for (const [regex, name] of aiPatterns) {
      if (regex.test(combinedText)) {
        signals.push(`Metadata signature detected: ${name}`);
        if (!generatorName) generatorName = name;
      }
    }
  }

  const signalsFound = signals.length > 0;
  return {
    status: signalsFound ? 'signals_found' : c2paReadError ? 'not_assessed' : 'none_found',
    signals,
    generatorName,
    hasC2pa,
    details: signalsFound
      ? `AI generation indicators identified in file metadata (${signals.join('; ')}).`
      : c2paReadError
        ? `Content Credentials could not be inspected: ${c2paReadError}`
      : hasC2pa
        ? 'A Content Credentials manifest marker was found, but no AI-origin declaration was identified in the inspected metadata.'
        : 'No AI-origin signals found in metadata (this does NOT prove the image is real).',
  };
}

/**
 * Builds the unified, single-source-of-truth forensic verdict.
 */
export function buildForensicVerdict({
  reliabilityAssessment,
  hotspots,
  isGlobalPattern,
  metadata,
  aiOriginAssessment,
  metrics,
}: {
  reliabilityAssessment: ELAReliabilityAssessment;
  hotspots: ELAHotspot[];
  isGlobalPattern: boolean;
  metadata?: Partial<EvidenceMetadata>;
  aiOriginAssessment?: { status: 'not_assessed' | 'signals_found' | 'none_found'; signals: string[]; details: string };
  metrics?: any;
}): StructuredForensicVerdict {
  let ela_verdict: ELAVerdict;
  let activeHotspots: ELAHotspot[] = hotspots;

  if (reliabilityAssessment.reliability === 'low') {
    ela_verdict = 'not_reliable';
  } else if (isGlobalPattern) {
    ela_verdict = 'global_recompression';
    activeHotspots = [];
  } else if (hotspots.length > 0) {
    ela_verdict = 'possible_local_edit';
    activeHotspots = hotspots;
  } else {
    ela_verdict = 'no_local_edits_detected';
    activeHotspots = [];
  }

  return {
    reliability: reliabilityAssessment.reliability,
    reliability_reasons: reliabilityAssessment.reliabilityReasons,
    ela_verdict,
    hotspots: activeHotspots,
    exif_summary: {
      hasExif: reliabilityAssessment.hasExif,
      cameraMake: metadata?.cameraMake,
      cameraModel: metadata?.cameraModel,
      software: metadata?.software,
      dateTimeOriginal: metadata?.dateTimeOriginal,
      isMessagingAppSuspect: reliabilityAssessment.isMessagingAppSuspect,
      messagingAppName: reliabilityAssessment.messagingAppName,
      format: reliabilityAssessment.format,
      dimensions: reliabilityAssessment.dimensions,
      estimatedJpegQuality: reliabilityAssessment.estimatedJpegQuality,
      recompressionSigns: reliabilityAssessment.recompressionSigns,
    },
    ai_origin: aiOriginAssessment || {
      status: 'not_assessed',
      signals: [],
      details: 'AI-origin metadata check was not run.',
    },
    metrics,
  };
}

/**
 * Safely loads an image from a URL, blob, or base64 data string.
 */
export async function safelyLoadImage(src: string): Promise<{ img: HTMLImageElement; cleanup: () => void }> {
  if (typeof document === 'undefined') {
    throw new Error('Canvas image loading requires a DOM environment.');
  }

  let loadSrc = src;
  let objectUrlToRevoke: string | null = null;

  if (/^https?:\/\//i.test(src)) {
    try {
      const resp = await fetch(src);
      if (resp.ok) {
        const blob = await resp.blob();
        loadSrc = URL.createObjectURL(blob);
        objectUrlToRevoke = loadSrc;
      }
    } catch {
      loadSrc = src;
    }
  }

  const cleanup = () => {
    if (objectUrlToRevoke) {
      try {
        URL.revokeObjectURL(objectUrlToRevoke);
      } catch {}
    }
  };

  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!loadSrc.startsWith('data:') && !loadSrc.startsWith('blob:')) {
      img.crossOrigin = 'anonymous';
    }

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Image loading timed out.'));
    }, 15000);

    img.onload = () => {
      clearTimeout(timeoutId);
      resolve({ img, cleanup });
    };

    img.onerror = () => {
      clearTimeout(timeoutId);
      if (img.crossOrigin) {
        const fallbackImg = new Image();
        fallbackImg.onload = () => resolve({ img: fallbackImg, cleanup });
        fallbackImg.onerror = () => {
          cleanup();
          reject(new Error('Failed to load image raster. The source URL may be expired or inaccessible.'));
        };
        fallbackImg.src = loadSrc;
      } else {
        cleanup();
        reject(new Error('Failed to load image raster. The source URL may be expired or inaccessible.'));
      }
    };

    img.src = loadSrc;
  });
}

function loadJpegImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!src.startsWith('data:') && !src.startsWith('blob:')) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode recompressed JPEG stream'));
    img.src = src;
  });
}

/**
 * Performs Error Level Analysis (ELA) with:
 * - Default resave quality 95
 * - In-memory recompression
 * - Absolute difference in signed Float32Array (no uint8 overflow/underflow)
 * - Heatmap normalized by 99th percentile of difference values
 * - Multi-stop perceptual colormap
 * - 32x32 block means with robust median + MAD (1.4826) and Sobel edge attenuation
 * - Reliability Gate and Single Source of Truth Verdict
 */
export async function performELA(
  imageSource: HTMLImageElement | HTMLCanvasElement | string,
  params: ELAParams = { quality: 0.95, diffGain: 1.0, colorChannel: 'rgb', invert: false, luminanceOnly: false },
  fileName: string = 'evidence.jpg',
  metadata?: Partial<EvidenceMetadata>,
  fileType?: string,
  fileOrBuffer?: File | Blob | ArrayBuffer | string
): Promise<ELAResult> {
  let activeElement: HTMLImageElement | HTMLCanvasElement;
  let cleanupLoaded: (() => void) | null = null;

  if (typeof imageSource === 'string') {
    const loaded = await safelyLoadImage(imageSource);
    activeElement = loaded.img;
    cleanupLoaded = loaded.cleanup;
  } else {
    activeElement = imageSource;
  }

  try {
    const rawWidth = 'naturalWidth' in activeElement ? activeElement.naturalWidth : activeElement.width;
    const rawHeight = 'naturalHeight' in activeElement ? activeElement.naturalHeight : activeElement.height;

    if (!rawWidth || !rawHeight || rawWidth <= 0 || rawHeight <= 0) {
      throw new Error('Image dimensions must be greater than zero for ELA analysis.');
    }

    const MAX_DIM = 2400;
    let width = rawWidth;
    let height = rawHeight;
    if (rawWidth > MAX_DIM || rawHeight > MAX_DIM) {
      const scale = Math.min(MAX_DIM / rawWidth, MAX_DIM / rawHeight);
      width = Math.max(1, Math.round(rawWidth * scale));
      height = Math.max(1, Math.round(rawHeight * scale));
    }

    if (typeof document === 'undefined') {
      throw new Error('Client-side Canvas ELA engine requires a DOM or Canvas environment.');
    }

    const origCanvas = document.createElement('canvas');
    origCanvas.width = width;
    origCanvas.height = height;
    const origCtx = origCanvas.getContext('2d', { willReadFrequently: true });
    if (!origCtx) throw new Error('Could not acquire 2D canvas context for original image');

    origCtx.drawImage(activeElement, 0, 0, width, height);

    let origData: ImageData;
    try {
      origData = origCtx.getImageData(0, 0, width, height);
    } catch {
      throw new Error('Image data could not be read from canvas (cross-origin security block).');
    }

    // Default resave quality 95
    const quality = typeof params.quality === 'number' && params.quality > 0
      ? Math.min(0.95, params.quality)
      : 0.95;

    // In-memory JPEG recompression
    let compressedDataUrl: string;
    try {
      compressedDataUrl = origCanvas.toDataURL('image/jpeg', quality);
    } catch {
      throw new Error('Canvas JPEG recompression failed.');
    }

    const recompressedImg = await loadJpegImage(compressedDataUrl);

    const compCanvas = document.createElement('canvas');
    compCanvas.width = width;
    compCanvas.height = height;
    const compCtx = compCanvas.getContext('2d', { willReadFrequently: true });
    if (!compCtx) throw new Error('Could not acquire 2D canvas context for recompressed image');

    compCtx.drawImage(recompressedImg, 0, 0, width, height);
    const compData = compCtx.getImageData(0, 0, width, height);

    const elaCanvas = document.createElement('canvas');
    elaCanvas.width = width;
    elaCanvas.height = height;
    const elaCtx = elaCanvas.getContext('2d');
    if (!elaCtx) throw new Error('Could not acquire 2D canvas context for ELA output');

    const elaData = elaCtx.createImageData(width, height);
    const origPixels = origData.data;
    const compPixels = compData.data;
    const outPixels = elaData.data;

    const totalPixels = width * height;
    const isLuminance = params.luminanceOnly;
    const channel = params.colorChannel;
    const isInvert = params.invert;

    // Signed wider-type difference arithmetic (Float32Array)
    let totalRawDiff = 0;
    const unscaledDifferences = new Float32Array(totalPixels);
    const hist = new Uint32Array(256);

    for (let p = 0; p < totalPixels; p++) {
      const i = p * 4;
      const rawDiffR = Math.abs(Number(origPixels[i]) - Number(compPixels[i]));
      const rawDiffG = Math.abs(Number(origPixels[i + 1]) - Number(compPixels[i + 1]));
      const rawDiffB = Math.abs(Number(origPixels[i + 2]) - Number(compPixels[i + 2]));

      let pixelDiff: number;
      if (isLuminance) {
        pixelDiff = 0.299 * rawDiffR + 0.587 * rawDiffG + 0.114 * rawDiffB;
      } else if (channel === 'r') {
        pixelDiff = rawDiffR;
      } else if (channel === 'g') {
        pixelDiff = rawDiffG;
      } else if (channel === 'b') {
        pixelDiff = rawDiffB;
      } else {
        pixelDiff = (rawDiffR + rawDiffG + rawDiffB) / 3;
      }

      unscaledDifferences[p] = pixelDiff;
      totalRawDiff += pixelDiff;

      const bin = Math.min(255, Math.floor(pixelDiff));
      hist[bin]++;
    }

    // Compute 99th percentile for robust normalization
    const targetCount = totalPixels * 0.99;
    let accum = 0;
    let p99 = 1;
    for (let b = 0; b < 256; b++) {
      accum += hist[b];
      if (accum >= targetCount) {
        p99 = Math.max(1, b);
        break;
      }
    }

    // Auto-normalization with amplification gain (default 1.0)
    const gain = Number.isFinite(params.diffGain) && params.diffGain > 0 ? params.diffGain : 1.0;

    for (let p = 0; p < totalPixels; p++) {
      const i = p * 4;
      let val = (unscaledDifferences[p] / p99) * gain;
      if (val > 1.0) val = 1.0;
      if (val < 0.0) val = 0.0;
      if (isInvert) val = 1.0 - val;

      const [cr, cg, cb] = getPerceptualRgb(val);
      outPixels[i] = cr;
      outPixels[i + 1] = cg;
      outPixels[i + 2] = cb;
      outPixels[i + 3] = 255;
    }

    elaCtx.putImageData(elaData, 0, 0);

    const avgError = totalRawDiff / totalPixels;

    // Compute edge magnitude for edge attenuation in hotspot detection
    const edgeMag = computeSobelEdgeMagnitude(origPixels, width, height);

    // 1. Hotspot Detection (32x32 blocks, Median + MAD * 1.4826, z > 6, noise filter >= 3 blocks)
    const blockSize = Math.max(8, Math.min(128, Math.round(params.blockSize || 32)));
    const zThreshold = Math.max(1, Math.min(20, params.zThreshold || 6));
    const { hotspots, isGlobalPattern, blockStats } = detectHotspots(
      unscaledDifferences,
      width,
      height,
      edgeMag,
      blockSize,
      zThreshold
    );

    let sourceBytes: ArrayBuffer | undefined;
    let sourceReadError: string | undefined;
    try {
      sourceBytes = await loadSourceBytes(fileOrBuffer || (typeof imageSource === 'string' ? imageSource : undefined));
    } catch (error) {
      sourceReadError = error instanceof Error ? error.message : String(error);
    }

    // 2. Reliability Gate
    const reliabilityAssessment = evaluateELAReliability({
      fileName,
      fileType,
      metadata,
      dimensions: { width, height },
      estimatedJpegQuality: sourceBytes ? estimateJpegQuality(sourceBytes) : undefined,
    });

    // 3. AI-Origin Metadata Audit
    let aiOriginTimeout: ReturnType<typeof setTimeout> | undefined;
    let aiOrigin: {
      status: 'not_assessed' | 'signals_found' | 'none_found';
      signals: string[];
      details: string;
      hasC2pa: boolean;
    };
    try {
      aiOrigin = await Promise.race([
        auditAIOriginMetadata({
          metadata,
          fileName,
          fileOrBuffer: sourceBytes || (sourceReadError ? fileOrBuffer : undefined),
        }),
        new Promise<{
        status: 'not_assessed';
        signals: string[];
        details: string;
        hasC2pa: boolean;
        }>((resolve) => {
          aiOriginTimeout = setTimeout(() => resolve({
            status: 'not_assessed',
            signals: [],
            details: 'AI-origin metadata check timed out after 7 seconds.',
            hasC2pa: false,
          }), 7000);
        }),
      ]);
    } catch (error) {
      aiOrigin = {
        status: 'not_assessed',
        signals: [],
        details: `AI-origin metadata check failed: ${error instanceof Error ? error.message : String(error)}`,
        hasC2pa: false,
      };
    } finally {
      if (aiOriginTimeout !== undefined) clearTimeout(aiOriginTimeout);
    }

    // 4. Single Source of Truth Structured Forensic Verdict
    const structuredVerdict = buildForensicVerdict({
      reliabilityAssessment,
      hotspots,
      isGlobalPattern,
      metadata,
      aiOriginAssessment: {
        status: aiOrigin.status,
        signals: aiOrigin.signals,
        details: aiOrigin.details,
      },
      metrics: {
        resaveQuality: Math.round(quality * 100),
        blockSize,
        zThreshold,
        medianBlockDiff: blockStats.median,
        madBlockDiff: blockStats.mad,
        scaledMAD: blockStats.scaledMAD,
        totalBlocks: blockStats.totalBlocks,
        anomalousBlocks: blockStats.anomalousBlocks,
        coveragePct: blockStats.coveragePct,
        p99Diff: Math.round(p99 * 10) / 10,
        meanDiff: Math.round(avgError * 100) / 100,
      },
    });

    return {
      ...structuredVerdict,
      dataUrl: elaCanvas.toDataURL('image/png'),
      width,
      height,
      plainEnglishExplanation:
        'ELA detects local edits in JPEGs. It cannot prove an image is AI-generated or authentic, and it is unreliable on files re-shared through WhatsApp or social apps.',
      hindiExplanation:
        'त्रुटि स्तर विश्लेषण (ELA) जेपीईजी में स्थानीय संपादन के संकेत खोजता है। यह अकेले एआई निर्माण या प्रामाणिकता सिद्ध नहीं करता है।',
      formatWarning: !reliabilityAssessment.isJpeg ? reliabilityAssessment.reliabilityReasons[0] : null,
      qualityWarning: quality < 0.9 ? 'Resave quality below 90% can increase recompression artifacts and reduce interpretability.' : null,
      disclaimer: 'ELA highlights compression differences; these differences do not prove manipulation or AI generation.',
      calculationMethod: `Canvas JPEG recompression at Q=${Math.round(quality * 100)}% with 99th-percentile normalization and MAD-scaled block anomaly detection (z > ${zThreshold}).`,
    };
  } finally {
    if (cleanupLoaded) cleanupLoaded();
  }
}
