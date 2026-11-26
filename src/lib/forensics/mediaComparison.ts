export interface RasterImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface RasterMetrics {
  width: number;
  height: number;
  mae: number;
  mse: number;
  changedPixels: number;
  changedPercent: number;
  ssim: number;
  pHashDistance: number;
  dHashDistance: number;
  aHashDistance: number;
  histogramSimilarity: number;
  baselinePHash: string;
  suspectPHash: string;
  differenceMap: Uint8Array;
}

export interface DifferenceRegion {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  area: number;
  meanDifference: number;
}

export interface AlignmentSummary {
  status: 'homography' | 'manual-fit';
  baselineKeypoints: number;
  suspectKeypoints: number;
  goodMatches: number;
  inliers: number;
  inlierRate: number;
  note: string;
}

export interface CopyMoveCandidate {
  first: { x: number; y: number };
  second: { x: number; y: number };
  descriptorDistance: number;
}

export interface LocalImageComparison {
  metrics: RasterMetrics;
  alignment: AlignmentSummary;
  alignedSuspect: HTMLCanvasElement;
  edgeMap: string;
  edgeSimilarity: number;
  baselineNoiseMean: number;
  suspectNoiseMean: number;
  noiseDistribution: { baseline: number[]; suspect: number[] };
  regions: DifferenceRegion[];
  copyMoveCandidates: CopyMoveCandidate[];
}

export interface ManualImageOffset {
  x: number;
  y: number;
}

type OpenCvRuntime = typeof import('@techstark/opencv-js');
type OpenCvPackage = { default: OpenCvRuntime | Promise<OpenCvRuntime> };

let openCvPromise: Promise<OpenCvRuntime> | undefined;

async function loadOpenCv(): Promise<OpenCvRuntime> {
  if (!openCvPromise) {
    openCvPromise = (async () => {
      const imported = await import('@techstark/opencv-js') as unknown as OpenCvPackage;
      const cv = await Promise.resolve(imported.default);
      if (typeof cv.Mat !== 'function') {
        throw new Error('The local OpenCV runtime did not initialize correctly.');
      }
      return cv;
    })();
  }
  return openCvPromise;
}

function assertRaster(image: RasterImage): void {
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.data.length !== image.width * image.height * 4
  ) {
    throw new Error('Image pixel data is invalid or incomplete.');
  }
}

function grayscale(image: RasterImage): Float64Array {
  const result = new Float64Array(image.width * image.height);
  for (let pixel = 0, offset = 0; pixel < result.length; pixel++, offset += 4) {
    result[pixel] = image.data[offset] * 0.299
      + image.data[offset + 1] * 0.587
      + image.data[offset + 2] * 0.114;
  }
  return result;
}

function sampleNearest(values: Float64Array, width: number, height: number, outWidth: number, outHeight: number): Float64Array {
  const output = new Float64Array(outWidth * outHeight);
  for (let y = 0; y < outHeight; y++) {
    const sourceY = Math.min(height - 1, Math.floor((y + 0.5) * height / outHeight));
    for (let x = 0; x < outWidth; x++) {
      const sourceX = Math.min(width - 1, Math.floor((x + 0.5) * width / outWidth));
      output[y * outWidth + x] = values[sourceY * width + sourceX];
    }
  }
  return output;
}

function bitString(values: number[]): string {
  let result = '';
  for (let index = 0; index < values.length; index += 4) {
    result += parseInt(values.slice(index, index + 4).join(''), 2).toString(16);
  }
  return result;
}

function hashDistance(left: string, right: string): number {
  let distance = 0;
  for (let index = 0; index < left.length; index++) {
    let value = parseInt(left[index], 16) ^ parseInt(right[index], 16);
    while (value) {
      distance += value & 1;
      value >>>= 1;
    }
  }
  return distance;
}

function perceptualHash(gray: Float64Array, width: number, height: number): string {
  const input = sampleNearest(gray, width, height, 32, 32);
  const coefficients: number[] = [];
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < 32; y++) {
        const cy = Math.cos(((2 * y + 1) * v * Math.PI) / 64);
        for (let x = 0; x < 32; x++) {
          sum += input[y * 32 + x]
            * Math.cos(((2 * x + 1) * u * Math.PI) / 64)
            * cy;
        }
      }
      coefficients.push(sum);
    }
  }
  const ordered = coefficients.slice(1).sort((a, b) => a - b);
  const median = ordered[Math.floor(ordered.length / 2)];
  return bitString(coefficients.map((value) => Number(value > median)));
}

function differenceHash(gray: Float64Array, width: number, height: number): string {
  const input = sampleNearest(gray, width, height, 9, 8);
  const bits: number[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits.push(Number(input[y * 9 + x] > input[y * 9 + x + 1]));
  }
  return bitString(bits);
}

function averageHash(gray: Float64Array, width: number, height: number): string {
  const input = sampleNearest(gray, width, height, 8, 8);
  const average = input.reduce((sum, value) => sum + value, 0) / input.length;
  return bitString(Array.from(input, (value) => Number(value >= average)));
}

function ssim(left: Float64Array, right: Float64Array, width: number, height: number): number {
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  let total = 0;
  let windows = 0;

  for (let top = 0; top < height; top += 8) {
    for (let leftEdge = 0; leftEdge < width; leftEdge += 8) {
      const bottom = Math.min(height, top + 8);
      const rightEdge = Math.min(width, leftEdge + 8);
      let sumLeft = 0;
      let sumRight = 0;
      let sumLeftSquared = 0;
      let sumRightSquared = 0;
      let sumProduct = 0;
      let count = 0;

      for (let y = top; y < bottom; y++) {
        for (let x = leftEdge; x < rightEdge; x++) {
          const index = y * width + x;
          const a = left[index];
          const b = right[index];
          sumLeft += a;
          sumRight += b;
          sumLeftSquared += a * a;
          sumRightSquared += b * b;
          sumProduct += a * b;
          count++;
        }
      }

      const meanLeft = sumLeft / count;
      const meanRight = sumRight / count;
      const varianceLeft = Math.max(0, sumLeftSquared / count - meanLeft * meanLeft);
      const varianceRight = Math.max(0, sumRightSquared / count - meanRight * meanRight);
      const covariance = sumProduct / count - meanLeft * meanRight;
      const numerator = (2 * meanLeft * meanRight + c1) * (2 * covariance + c2);
      const denominator = (meanLeft * meanLeft + meanRight * meanRight + c1)
        * (varianceLeft + varianceRight + c2);
      total += numerator / denominator;
      windows++;
    }
  }

  return windows ? total / windows : 0;
}

function histogramSimilarity(left: RasterImage, right: RasterImage): number {
  const bins = 64;
  const leftHistogram = [new Float64Array(bins), new Float64Array(bins), new Float64Array(bins)];
  const rightHistogram = [new Float64Array(bins), new Float64Array(bins), new Float64Array(bins)];
  const pixels = left.width * left.height;

  for (let offset = 0; offset < left.data.length; offset += 4) {
    for (let channel = 0; channel < 3; channel++) {
      leftHistogram[channel][left.data[offset + channel] >>> 2]++;
      rightHistogram[channel][right.data[offset + channel] >>> 2]++;
    }
  }

  let similarity = 0;
  for (let channel = 0; channel < 3; channel++) {
    let distance = 0;
    for (let bin = 0; bin < bins; bin++) {
      distance += Math.abs(leftHistogram[channel][bin] - rightHistogram[channel][bin]);
    }
    similarity += 1 - distance / (2 * pixels);
  }
  return similarity / 3;
}

export function calculateRasterMetrics(
  baseline: RasterImage,
  suspect: RasterImage,
  sensitivityThreshold = 20,
): RasterMetrics {
  assertRaster(baseline);
  assertRaster(suspect);
  if (baseline.width !== suspect.width || baseline.height !== suspect.height) {
    throw new Error('Raster dimensions must match before calculating pixel metrics.');
  }
  if (!Number.isFinite(sensitivityThreshold) || sensitivityThreshold < 0 || sensitivityThreshold > 255) {
    throw new Error('Difference sensitivity must be between 0 and 255.');
  }

  const pixels = baseline.width * baseline.height;
  const differenceMap = new Uint8Array(pixels);
  let absoluteTotal = 0;
  let squareTotal = 0;
  let changedPixels = 0;

  for (let pixel = 0, offset = 0; pixel < pixels; pixel++, offset += 4) {
    const red = Math.abs(baseline.data[offset] - suspect.data[offset]);
    const green = Math.abs(baseline.data[offset + 1] - suspect.data[offset + 1]);
    const blue = Math.abs(baseline.data[offset + 2] - suspect.data[offset + 2]);
    const meanDifference = (red + green + blue) / 3;
    differenceMap[pixel] = Math.round(meanDifference);
    absoluteTotal += red + green + blue;
    squareTotal += red * red + green * green + blue * blue;
    if (meanDifference > sensitivityThreshold) changedPixels++;
  }

  const baselineGray = grayscale(baseline);
  const suspectGray = grayscale(suspect);
  const baselinePHash = perceptualHash(baselineGray, baseline.width, baseline.height);
  const suspectPHash = perceptualHash(suspectGray, suspect.width, suspect.height);
  const baselineDHash = differenceHash(baselineGray, baseline.width, baseline.height);
  const suspectDHash = differenceHash(suspectGray, suspect.width, suspect.height);
  const baselineAHash = averageHash(baselineGray, baseline.width, baseline.height);
  const suspectAHash = averageHash(suspectGray, suspect.width, suspect.height);

  return {
    width: baseline.width,
    height: baseline.height,
    mae: absoluteTotal / (pixels * 3),
    mse: squareTotal / (pixels * 3),
    changedPixels,
    changedPercent: pixels ? (changedPixels / pixels) * 100 : 0,
    ssim: ssim(baselineGray, suspectGray, baseline.width, baseline.height),
    pHashDistance: hashDistance(baselinePHash, suspectPHash),
    dHashDistance: hashDistance(baselineDHash, suspectDHash),
    aHashDistance: hashDistance(baselineAHash, suspectAHash),
    histogramSimilarity: histogramSimilarity(baseline, suspect),
    baselinePHash,
    suspectPHash,
    differenceMap,
  };
}

function toRaster(canvas: HTMLCanvasElement): RasterImage {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('The browser could not create an image-analysis canvas.');
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function canvasFromRaster(raster: RasterImage): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = raster.width;
  canvas.height = raster.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The browser could not create a result canvas.');
  const imageData = context.createImageData(raster.width, raster.height);
  imageData.data.set(raster.data);
  context.putImageData(imageData, 0, 0);
  return canvas;
}

function createAlignedCanvas(
  source: HTMLCanvasElement,
  width: number,
  height: number,
  offset: ManualImageOffset,
): HTMLCanvasElement {
  const result = document.createElement('canvas');
  result.width = width;
  result.height = height;
  const context = result.getContext('2d');
  if (!context) throw new Error('The browser could not create an alignment canvas.');
  const scale = Math.min(width / source.width, height / source.height);
  const drawWidth = source.width * scale;
  const drawHeight = source.height * scale;
  context.drawImage(
    source,
    (width - drawWidth) / 2 + offset.x,
    (height - drawHeight) / 2 + offset.y,
    drawWidth,
    drawHeight,
  );
  return result;
}

function getPoint(keypoints: InstanceType<OpenCvRuntime['KeyPointVector']>, index: number): { x: number; y: number } {
  const point = keypoints.get(index).pt;
  return { x: point.x, y: point.y };
}

function findAlignment(
  cv: OpenCvRuntime,
  baseline: HTMLCanvasElement,
  suspect: HTMLCanvasElement,
  offset: ManualImageOffset,
): { canvas: HTMLCanvasElement; summary: AlignmentSummary } {
  const baselineMat = cv.imread(baseline);
  const suspectMat = cv.imread(suspect);
  const baselineGray = new cv.Mat();
  const suspectGray = new cv.Mat();
  const baselineKeypoints = new cv.KeyPointVector();
  const suspectKeypoints = new cv.KeyPointVector();
  const baselineDescriptors = new cv.Mat();
  const suspectDescriptors = new cv.Mat();
  const mask = new cv.Mat();
  const matches = new cv.DMatchVectorVector();
  const baselinePoints = new cv.Mat();
  const suspectPoints = new cv.Mat();
  const inlierMask = new cv.Mat();
  const homography = new cv.Mat();
  let orb: InstanceType<OpenCvRuntime['ORB']>;
  let matcher: InstanceType<OpenCvRuntime['BFMatcher']>;
  let aligned: HTMLCanvasElement | undefined;
  let homographyError = '';

  try {
    cv.cvtColor(baselineMat, baselineGray, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(suspectMat, suspectGray, cv.COLOR_RGBA2GRAY);
    orb = new cv.ORB(1600);
    orb.detectAndCompute(baselineGray, mask, baselineKeypoints, baselineDescriptors);
    orb.detectAndCompute(suspectGray, mask, suspectKeypoints, suspectDescriptors);

    let goodMatches: Array<{ source: { x: number; y: number }; target: { x: number; y: number } }> = [];
    if (!baselineDescriptors.empty() && !suspectDescriptors.empty()) {
      matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
      matcher.knnMatch(suspectDescriptors, baselineDescriptors, matches, 2);
      for (let index = 0; index < matches.size(); index++) {
        const pair = matches.get(index);
        try {
          if (pair.size() < 2) continue;
          const first = pair.get(0);
          const second = pair.get(1);
          if (first.distance < 0.75 * second.distance) {
            goodMatches.push({
              source: getPoint(suspectKeypoints, first.queryIdx),
              target: getPoint(baselineKeypoints, first.trainIdx),
            });
          }
        } finally {
          pair.delete();
        }
      }
    }

    if (goodMatches.length >= 4) {
      suspectPoints.create(goodMatches.length, 1, cv.CV_32FC2);
      baselinePoints.create(goodMatches.length, 1, cv.CV_32FC2);
      for (let index = 0; index < goodMatches.length; index++) {
        const match = goodMatches[index];
        suspectPoints.data32F[index * 2] = match.source.x;
        suspectPoints.data32F[index * 2 + 1] = match.source.y;
        baselinePoints.data32F[index * 2] = match.target.x;
        baselinePoints.data32F[index * 2 + 1] = match.target.y;
      }
      try {
        const estimated = cv.findHomography(suspectPoints, baselinePoints, cv.RANSAC, 4, inlierMask);
        try {
          estimated.copyTo(homography);
        } finally {
          estimated.delete();
        }
      } catch (error) {
        homographyError = error instanceof Error ? error.message : String(error);
      }
    }

    const inliers = inlierMask.empty() ? 0 : cv.countNonZero(inlierMask);
    const inlierRate = goodMatches.length ? inliers / goodMatches.length : 0;
    const useHomography = !homography.empty()
      && goodMatches.length >= 8
      && inliers >= 8
      && inlierRate >= 0.15;
    if (useHomography) {
      const warped = new cv.Mat();
      try {
        cv.warpPerspective(
          suspectMat,
          warped,
          homography,
          new cv.Size(baseline.width, baseline.height),
          cv.INTER_LINEAR,
          cv.BORDER_CONSTANT,
          new cv.Scalar(0, 0, 0, 0),
        );
        aligned = document.createElement('canvas');
        aligned.width = baseline.width;
        aligned.height = baseline.height;
        cv.imshow(aligned, warped);
        if (offset.x !== 0 || offset.y !== 0) {
          const shifted = document.createElement('canvas');
          shifted.width = baseline.width;
          shifted.height = baseline.height;
          const context = shifted.getContext('2d');
          if (!context) throw new Error('The browser could not apply the manual alignment adjustment.');
          context.drawImage(aligned, offset.x, offset.y);
          aligned = shifted;
        }
      } finally {
        warped.delete();
      }
    }

    if (!aligned) aligned = createAlignedCanvas(suspect, baseline.width, baseline.height, offset);
    const status = useHomography ? 'homography' : 'manual-fit';
    const summary: AlignmentSummary = {
      status,
      baselineKeypoints: baselineKeypoints.size(),
      suspectKeypoints: suspectKeypoints.size(),
      goodMatches: goodMatches.length,
      inliers,
      inlierRate,
      note: useHomography
        ? 'ORB feature correspondences and a RANSAC homography were used to align the suspect image.'
        : homographyError
          ? `RANSAC homography failed (${homographyError}); a centered aspect-preserving fit was used. Manual x/y shifts are available.`
          : 'Automatic homography did not meet the minimum match/inlier criteria; a centered aspect-preserving fit was used. Manual x/y shifts are available.',
    };
    return { canvas: aligned, summary };
  } finally {
    baselineMat.delete();
    suspectMat.delete();
    baselineGray.delete();
    suspectGray.delete();
    baselineKeypoints.delete();
    suspectKeypoints.delete();
    baselineDescriptors.delete();
    suspectDescriptors.delete();
    mask.delete();
    matches.delete();
    baselinePoints.delete();
    suspectPoints.delete();
    inlierMask.delete();
    homography.delete();
    if (typeof orb! !== 'undefined') orb.delete();
    if (typeof matcher! !== 'undefined') matcher.delete();
  }
}

function extractRegions(cv: OpenCvRuntime, metrics: RasterMetrics, threshold: number): DifferenceRegion[] {
  const difference = new cv.Mat(metrics.height, metrics.width, cv.CV_8UC1);
  const binary = new cv.Mat();
  const closed = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
  try {
    difference.data.set(metrics.differenceMap);
    cv.threshold(difference, binary, threshold, 255, cv.THRESH_BINARY);
    cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel);
    cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const regions: DifferenceRegion[] = [];
    for (let index = 0; index < contours.size(); index++) {
      const contour = contours.get(index);
      try {
        const bounds = cv.boundingRect(contour);
        const area = cv.contourArea(contour);
        if (area < 12 || bounds.width < 3 || bounds.height < 3) continue;
        let sum = 0;
        let count = 0;
        for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
          for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
            sum += metrics.differenceMap[y * metrics.width + x];
            count++;
          }
        }
        regions.push({
          id: regions.length + 1,
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          area,
          meanDifference: count ? sum / count : 0,
        });
      } finally {
        contour.delete();
      }
    }
    return regions.sort((a, b) => b.area - a.area).slice(0, 100).map((region, index) => ({ ...region, id: index + 1 }));
  } finally {
    difference.delete();
    binary.delete();
    closed.delete();
    contours.delete();
    hierarchy.delete();
    kernel.delete();
  }
}

export async function detectDifferenceRegions(
  metrics: RasterMetrics,
  threshold: number,
): Promise<DifferenceRegion[]> {
  const cv = await loadOpenCv();
  return extractRegions(cv, metrics, threshold);
}

function findCopyMoveCandidates(cv: OpenCvRuntime, suspect: HTMLCanvasElement): CopyMoveCandidate[] {
  const image = cv.imread(suspect);
  const gray = new cv.Mat();
  const keypoints = new cv.KeyPointVector();
  const descriptors = new cv.Mat();
  const mask = new cv.Mat();
  const matches = new cv.DMatchVectorVector();
  let orb: InstanceType<OpenCvRuntime['ORB']>;
  let matcher: InstanceType<OpenCvRuntime['BFMatcher']>;
  try {
    cv.cvtColor(image, gray, cv.COLOR_RGBA2GRAY);
    orb = new cv.ORB(1800);
    orb.detectAndCompute(gray, mask, keypoints, descriptors);
    if (descriptors.empty()) return [];
    matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
    matcher.knnMatch(descriptors, descriptors, matches, 3);
    const candidates: CopyMoveCandidate[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < matches.size(); index++) {
      const group = matches.get(index);
      try {
        const viable: Array<{ match: { queryIdx: number; trainIdx: number; distance: number }; first: { x: number; y: number }; second: { x: number; y: number } }> = [];
        for (let candidateIndex = 0; candidateIndex < group.size(); candidateIndex++) {
          const match = group.get(candidateIndex);
          if (match.queryIdx === match.trainIdx || match.distance > 28) continue;
          const query = getPoint(keypoints, match.queryIdx);
          const train = getPoint(keypoints, match.trainIdx);
          const first = match.queryIdx < match.trainIdx ? query : train;
          const second = match.queryIdx < match.trainIdx ? train : query;
          if (Math.hypot(first.x - second.x, first.y - second.y) < Math.min(suspect.width, suspect.height) * 0.08) continue;
          viable.push({ match, first, second });
        }
        if (viable.length >= 2 && viable[0].match.distance < 0.75 * viable[1].match.distance) {
          const { match, first, second } = viable[0];
          const key = [match.queryIdx, match.trainIdx].sort((a, b) => a - b).join(':');
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({ first, second, descriptorDistance: match.distance });
        }
      } finally {
        group.delete();
      }
    }
    const displacementGroups = new Map<string, CopyMoveCandidate[]>();
    for (const candidate of candidates) {
      const dx = candidate.second.x - candidate.first.x;
      const dy = candidate.second.y - candidate.first.y;
      const key = `${Math.round(dx / 12)}:${Math.round(dy / 12)}`;
      const group = displacementGroups.get(key) || [];
      group.push(candidate);
      displacementGroups.set(key, group);
    }
    return [...displacementGroups.values()]
      .filter((group) => group.length >= 4)
      .flat()
      .sort((a, b) => a.descriptorDistance - b.descriptorDistance)
      .slice(0, 20);
  } finally {
    image.delete();
    gray.delete();
    keypoints.delete();
    descriptors.delete();
    mask.delete();
    matches.delete();
    if (typeof orb! !== 'undefined') orb.delete();
    if (typeof matcher! !== 'undefined') matcher.delete();
  }
}

function makeEdgeMap(cv: OpenCvRuntime, baseline: HTMLCanvasElement, suspect: HTMLCanvasElement): {
  dataUrl: string;
  similarity: number;
} {
  const baselineMat = cv.imread(baseline);
  const suspectMat = cv.imread(suspect);
  const baselineGray = new cv.Mat();
  const suspectGray = new cv.Mat();
  const baselineEdges = new cv.Mat();
  const suspectEdges = new cv.Mat();
  const output = new cv.Mat();
  try {
    cv.cvtColor(baselineMat, baselineGray, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(suspectMat, suspectGray, cv.COLOR_RGBA2GRAY);
    cv.Canny(baselineGray, baselineEdges, 70, 140);
    cv.Canny(suspectGray, suspectEdges, 70, 140);
    cv.absdiff(baselineEdges, suspectEdges, output);
    let same = 0;
    for (let index = 0; index < baselineEdges.data.length; index++) {
      if (baselineEdges.data[index] === suspectEdges.data[index]) same++;
    }
    const mapCanvas = document.createElement('canvas');
    cv.imshow(mapCanvas, output);
    return { dataUrl: mapCanvas.toDataURL('image/png'), similarity: same / baselineEdges.data.length };
  } finally {
    baselineMat.delete();
    suspectMat.delete();
    baselineGray.delete();
    suspectGray.delete();
    baselineEdges.delete();
    suspectEdges.delete();
    output.delete();
  }
}

function meanLaplacianMagnitude(raster: RasterImage): number {
  const gray = grayscale(raster);
  let total = 0;
  let count = 0;
  for (let y = 1; y < raster.height - 1; y++) {
    for (let x = 1; x < raster.width - 1; x++) {
      const index = y * raster.width + x;
      total += Math.abs(
        gray[index - raster.width] +
        gray[index - 1] -
        4 * gray[index] +
        gray[index + 1] +
        gray[index + raster.width],
      );
      count++;
    }
  }
  return count ? total / count : 0;
}

function laplacianDistribution(raster: RasterImage): number[] {
  const gray = grayscale(raster);
  const bins = new Array<number>(32).fill(0);
  let samples = 0;
  for (let y = 1; y < raster.height - 1; y++) {
    for (let x = 1; x < raster.width - 1; x++) {
      const index = y * raster.width + x;
      const residual = Math.abs(
        gray[index - raster.width] +
        gray[index - 1] -
        4 * gray[index] +
        gray[index + 1] +
        gray[index + raster.width],
      );
      bins[Math.min(31, Math.floor(residual / 8))]++;
      samples++;
    }
  }
  return samples ? bins.map((count) => count / samples) : bins;
}

export async function analyzeImageCanvases(
  baselineCanvas: HTMLCanvasElement,
  suspectCanvas: HTMLCanvasElement,
  sensitivityThreshold = 20,
  offset: ManualImageOffset = { x: 0, y: 0 },
): Promise<LocalImageComparison> {
  const cv = await loadOpenCv();
  const baseline = toRaster(baselineCanvas);
  const alignment = findAlignment(cv, baselineCanvas, suspectCanvas, offset);
  const aligned = toRaster(alignment.canvas);
  const metrics = calculateRasterMetrics(baseline, aligned, sensitivityThreshold);
  const regions = extractRegions(cv, metrics, sensitivityThreshold);
  const edges = makeEdgeMap(cv, baselineCanvas, alignment.canvas);
  const copyMoveCandidates = findCopyMoveCandidates(cv, suspectCanvas);
  return {
    metrics,
    alignment: alignment.summary,
    alignedSuspect: alignment.canvas,
    edgeMap: edges.dataUrl,
    edgeSimilarity: edges.similarity,
    baselineNoiseMean: meanLaplacianMagnitude(baseline),
    suspectNoiseMean: meanLaplacianMagnitude(aligned),
    noiseDistribution: {
      baseline: laplacianDistribution(baseline),
      suspect: laplacianDistribution(aligned),
    },
    regions,
    copyMoveCandidates,
  };
}

export function createHeatmapDataUrl(
  width: number,
  height: number,
  differenceMap: Uint8Array,
  intensity: number,
  sensitivityThreshold: number,
): string {
  if (differenceMap.length !== width * height) {
    throw new Error('Difference map dimensions do not match its pixel data.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The browser could not create a heatmap canvas.');
  const output = context.createImageData(width, height);
  const multiplier = Math.max(0, Math.min(3, intensity));

  for (let pixel = 0, offset = 0; pixel < differenceMap.length; pixel++, offset += 4) {
    const difference = Math.min(255, differenceMap[pixel] * multiplier);
    if (difference > 0 && difference >= sensitivityThreshold * 1.8) {
      output.data[offset] = 239;
      output.data[offset + 1] = 68;
      output.data[offset + 2] = 68;
    } else if (difference > 0 && difference >= sensitivityThreshold) {
      output.data[offset] = 250;
      output.data[offset + 1] = 204;
      output.data[offset + 2] = 21;
    } else {
      output.data[offset] = 56;
      output.data[offset + 1] = 189;
      output.data[offset + 2] = 248;
    }
    output.data[offset + 3] = 255;
  }
  context.putImageData(output, 0, 0);
  return canvas.toDataURL('image/png');
}
