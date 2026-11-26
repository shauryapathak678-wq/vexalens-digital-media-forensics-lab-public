import { describe, expect, it } from 'vitest';
import {
  detectPngTrailingData,
  recoverFstgFile,
} from './steganographyFileExtractor';

const MAGIC = new TextEncoder().encode('FSTG1');
const SALT = new TextEncoder().encode('fstg-salt');

async function passwordStream(password: string, length: number): Promise<Uint8Array> {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const key = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: SALT, iterations: 100_000, hash: 'SHA-256' },
    passwordKey,
    256,
  ));
  const output = new Uint8Array(length);
  const counterBytes = new Uint8Array(8);
  const counterView = new DataView(counterBytes.buffer);
  for (let offset = 0, counter = 0; offset < length; counter += 1) {
    counterView.setBigUint64(0, BigInt(counter), false);
    const input = new Uint8Array(key.length + counterBytes.length);
    input.set(key);
    input.set(counterBytes, key.length);
    const block = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    const count = Math.min(block.length, length - offset);
    output.set(block.subarray(0, count), offset);
    offset += count;
  }
  return output;
}

async function makeFstgImage(password?: string): Promise<ImageData> {
  const original = new TextEncoder().encode('%PDF-1.4\nSample hidden report\n%%EOF');
  const compressedStream = new Blob([original]).stream().pipeThrough(new CompressionStream('deflate'));
  let payload = new Uint8Array(await new Response(compressedStream).arrayBuffer());
  const flags = password ? 3 : 1;
  if (password) {
    const keyStream = await passwordStream(password, payload.length);
    payload = payload.map((byte, index) => byte ^ keyStream[index]);
  }

  const name = new TextEncoder().encode('report.pdf');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', original));
  const header = new Uint8Array(56);
  header.set(MAGIC, 0);
  header[5] = flags;
  const view = new DataView(header.buffer);
  view.setUint16(6, name.length, false);
  view.setBigUint64(8, BigInt(original.length), false);
  view.setBigUint64(16, BigInt(payload.length), false);
  header.set(digest, 24);
  const fullPayload = new Uint8Array(header.length + name.length + payload.length);
  fullPayload.set(header);
  fullPayload.set(name, header.length);
  fullPayload.set(payload, header.length + name.length);

  const pixelCount = Math.ceil((fullPayload.length * 8) / 3);
  const data = new Uint8ClampedArray(pixelCount * 4);
  for (let bitIndex = 0; bitIndex < fullPayload.length * 8; bitIndex += 1) {
    const pixelIndex = Math.floor(bitIndex / 3);
    const channelIndex = bitIndex % 3;
    const value = (fullPayload[Math.floor(bitIndex / 8)] >> (7 - (bitIndex % 8))) & 1;
    data[pixelIndex * 4 + channelIndex] = value;
    data[pixelIndex * 4 + 3] = 255;
  }
  return { width: pixelCount, height: 1, data } as ImageData;
}

describe('uploaded FSTG1 hidden-file format', () => {
  it('recovers, names, and verifies a compressed hidden PDF', async () => {
    const result = await recoverFstgFile(await makeFstgImage());
    expect(result).toMatchObject({
      found: true,
      fileName: 'report.pdf',
      passwordProtected: false,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      recoveredFile: expect.any(Blob),
    });
    expect(result.recoveredFile?.type).toBe('application/pdf');
    expect(new TextDecoder().decode(await result.recoveredFile?.arrayBuffer())).toContain('%PDF-1.4');
  });

  it('detects protected content, accepts the password, and rejects a wrong password', async () => {
    const image = await makeFstgImage('lab123');
    const locked = await recoverFstgFile(image);
    expect(locked).toMatchObject({ found: true, passwordProtected: true, fileName: 'report.pdf' });
    await expect(recoverFstgFile(image, 'wrong-password')).rejects.toThrow(/password|SHA-256/i);

    const unlocked = await recoverFstgFile(image, 'lab123');
    expect(unlocked.recoveredFile?.type).toBe('application/pdf');
    expect(unlocked.sha256).toBe(locked.sha256);
  });

  it('detects bytes appended after the PNG IEND marker', () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0,
      1, 2, 3,
    ]);
    expect(detectPngTrailingData(png)).toMatchObject({
      appendedBytes: 3,
      verdict: 'Needs review',
    });
  });
});
