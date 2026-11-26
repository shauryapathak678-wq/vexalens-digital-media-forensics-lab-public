/**
 * Cryptographic SHA-256 Forensics Utilities
 * Complies with NIST FIPS 180-4 standard
 */
import { sha256 } from '@noble/hashes/sha2';
import SparkMD5 from 'spark-md5';

const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

export interface EvidenceHashProgress {
  processedBytes: number;
  totalBytes: number;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function calculateEvidenceHashes(
  data: Blob,
  onProgress?: (progress: EvidenceHashProgress) => void,
): Promise<{ sha256: string; md5: string }> {
  const sha256Hash = sha256.create();
  const md5Hash = new SparkMD5.ArrayBuffer();
  let processedBytes = 0;

  while (processedBytes < data.size) {
    const chunk = await data.slice(processedBytes, processedBytes + HASH_CHUNK_BYTES).arrayBuffer();
    sha256Hash.update(new Uint8Array(chunk));
    md5Hash.append(chunk);
    processedBytes += chunk.byteLength;
    onProgress?.({ processedBytes, totalBytes: data.size });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  if (data.size === 0) onProgress?.({ processedBytes: 0, totalBytes: 0 });
  return {
    sha256: bytesToHex(sha256Hash.digest()),
    md5: md5Hash.end(),
  };
}

export async function calculateSHA256(data: ArrayBuffer | Uint8Array | Blob): Promise<string> {
  let buffer: ArrayBuffer;
  if (data instanceof Blob) {
    buffer = await data.arrayBuffer();
  } else if (data instanceof Uint8Array) {
    buffer = data.buffer as ArrayBuffer;
  } else {
    buffer = data;
  }

  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function verifyHashesMatch(hashA: string, hashB: string): boolean {
  if (!hashA || !hashB) return false;
  return hashA.trim().toLowerCase() === hashB.trim().toLowerCase();
}

export function formatShortHash(hash: string, start = 8, end = 8): string {
  if (!hash || hash.length < 20) return hash || '';
  return `${hash.slice(0, start)}...${hash.slice(-end)}`;
}

export function isValidSHA256(hash: string): boolean {
  return /^[a-f0-9]{64}$/i.test(hash.trim());
}
