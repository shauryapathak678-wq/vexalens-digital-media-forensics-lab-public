import { describe, expect, it } from 'vitest';
import SparkMD5 from 'spark-md5';
import { calculateEvidenceHashes, calculateSHA256 } from './crypto';

describe('evidence hashes', () => {
  it('calculates SHA-256 and MD5 from the same original bytes', async () => {
    const hashes = await calculateEvidenceHashes(new Blob(['abc']));

    expect(hashes.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashes.md5).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('hashes large files in chunks and reports progress without changing the digests', async () => {
    const bytes = new Uint8Array(4 * 1024 * 1024 + 7).fill(0x61);
    const referenceBuffer = new ArrayBuffer(bytes.length);
    new Uint8Array(referenceBuffer).set(bytes);
    const progress: number[] = [];

    const hashes = await calculateEvidenceHashes(new Blob([bytes]), (update) => {
      progress.push(update.processedBytes);
    });

    expect(hashes.sha256).toBe(await calculateSHA256(bytes));
    expect(hashes.md5).toBe(SparkMD5.ArrayBuffer.hash(referenceBuffer));
    expect(progress).toEqual([4 * 1024 * 1024, 4 * 1024 * 1024 + 7]);
  });
});
