/**
 * Perceptual hashing for near-duplicate detection.
 *
 * A perceptual hash summarizes how an image LOOKS, so two images that were
 * resized, re-encoded, or lightly edited can still produce close hashes even
 * when their SHA-256 byte digests differ. It is a triage aid only: a close
 * perceptual hash does NOT prove two files share an origin, and a different
 * SHA-256 does NOT prove manipulation.
 */

const HASH_GRID = 8; // 8x8 = 64 bits

function toGrayscale(pixels: Uint8ClampedArray, width: number, height: number): Float64Array {
  const gray = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return gray;
}

/**
 * Average-hash (aHash): downscale to an 8x8 luminance grid, compare each cell
 * to the grid mean, and emit 64 bits as a hex string.
 */
export function computePerceptualHashFromPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number
): string {
  if (width <= 0 || height <= 0 || pixels.length < width * height * 4) {
    return '';
  }

  const gray = toGrayscale(pixels, width, height);
  const cells = new Float64Array(HASH_GRID * HASH_GRID);

  for (let gy = 0; gy < HASH_GRID; gy++) {
    for (let gx = 0; gx < HASH_GRID; gx++) {
      const x0 = Math.floor((gx * width) / HASH_GRID);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / HASH_GRID));
      const y0 = Math.floor((gy * height) / HASH_GRID);
      const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / HASH_GRID));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        for (let x = x0; x < x1 && x < width; x++) {
          sum += gray[y * width + x];
          count++;
        }
      }
      cells[gy * HASH_GRID + gx] = count > 0 ? sum / count : 0;
    }
  }

  const mean = cells.reduce((total, value) => total + value, 0) / cells.length;
  let hex = '';
  for (let i = 0; i < cells.length; i += 4) {
    let nibble = 0;
    for (let bit = 0; bit < 4; bit++) {
      if (cells[i + bit] > mean) nibble |= 1 << (3 - bit);
    }
    hex += nibble.toString(16);
  }
  return hex;
}

/** Draw an already-loaded image into an 8x8 canvas and hash its pixels. */
export function computePerceptualHashFromImage(image: HTMLImageElement): string {
  if (typeof document === 'undefined') return '';
  const canvas = document.createElement('canvas');
  canvas.width = HASH_GRID;
  canvas.height = HASH_GRID;
  const context = canvas.getContext('2d');
  if (!context) return '';
  try {
    context.drawImage(image, 0, 0, HASH_GRID, HASH_GRID);
    const data = context.getImageData(0, 0, HASH_GRID, HASH_GRID);
    return computePerceptualHashFromPixels(data.data, HASH_GRID, HASH_GRID);
  } catch {
    return '';
  }
}

/** Number of differing bits between two equal-length perceptual hashes. */
export function hammingDistance(hashA: string, hashB: string): number {
  if (!hashA || !hashB || hashA.length !== hashB.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let i = 0; i < hashA.length; i++) {
    const a = parseInt(hashA[i], 16);
    const b = parseInt(hashB[i], 16);
    if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
    let xor = a ^ b;
    while (xor) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

/**
 * Classify two perceptual hashes as near-duplicates. The default threshold of
 * 10 differing bits out of 64 is a conservative triage setting.
 */
export function isNearDuplicate(hashA: string, hashB: string, threshold = 10): boolean {
  const distance = hammingDistance(hashA, hashB);
  return Number.isFinite(distance) && distance <= threshold;
}
