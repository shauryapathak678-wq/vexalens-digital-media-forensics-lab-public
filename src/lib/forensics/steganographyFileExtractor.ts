const FIXED_HEADER_BYTES = 56;
const MAGIC = [0x46, 0x53, 0x54, 0x47, 0x31];
const FLAG_ZLIB = 1;
const FLAG_XOR = 2;
const MAX_HIDDEN_FILE_BYTES = 100 * 1024 * 1024;
const PASSWORD_SALT = new TextEncoder().encode('fstg-salt');

export interface HiddenFileRecovery {
  found: boolean;
  fileName?: string;
  originalSize?: number;
  storedSize?: number;
  passwordProtected?: boolean;
  sha256?: string;
  capacityUsedPercent?: number;
  recoveredFile?: Blob;
  error?: string;
}

export interface PngDetection {
  appendedBytes: number;
  verdict: 'Clean' | 'Needs review' | 'High risk';
  reasons: string[];
}

function readRgbLsbBytes(imageData: ImageData, byteOffset: number, byteCount: number): Uint8Array {
  const capacityBits = imageData.width * imageData.height * 3;
  const startBit = byteOffset * 8;
  const endBit = startBit + byteCount * 8;
  if (!Number.isSafeInteger(endBit) || endBit > capacityBits) {
    throw new Error('The image is too small or the hidden file data is incomplete.');
  }

  const output = new Uint8Array(byteCount);
  for (let outputIndex = 0; outputIndex < byteCount; outputIndex += 1) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      const rgbIndex = (byteOffset + outputIndex) * 8 + bit;
      const pixelIndex = Math.floor(rgbIndex / 3);
      const channelIndex = rgbIndex % 3;
      const rgbaIndex = pixelIndex * 4 + channelIndex;
      value = (value << 1) | (imageData.data[rgbaIndex] & 1);
    }
    output[outputIndex] = value;
  }
  return output;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function createPasswordKeystream(password: string, length: number): Promise<Uint8Array> {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const key = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: PASSWORD_SALT, iterations: 100_000, hash: 'SHA-256' },
    passwordKey,
    256,
  ));
  const stream = new Uint8Array(length);
  const counterBytes = new Uint8Array(8);
  const counterView = new DataView(counterBytes.buffer);
  let written = 0;
  let counter = 0;

  while (written < length) {
    counterView.setBigUint64(0, BigInt(counter), false);
    const blockInput = new Uint8Array(key.length + counterBytes.length);
    blockInput.set(key);
    blockInput.set(counterBytes, key.length);
    const block = new Uint8Array(await crypto.subtle.digest('SHA-256', blockInput));
    const amount = Math.min(block.length, length - written);
    stream.set(block.subarray(0, amount), written);
    written += amount;
    counter += 1;
  }

  return stream;
}

function safeFileName(name: string): string {
  const baseName = name.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return baseName || 'recovered-file.bin';
}

async function decompressPayload(payload: Uint8Array, expectedSize: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser does not support offline zlib decompression.');
  }
  const input = new Uint8Array(payload.length);
  input.set(payload);
  const stream = new Blob([input.buffer]).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalSize += value.length;
    if (totalSize > expectedSize) {
      await reader.cancel();
      throw new Error('The decompressed file is larger than the size declared in its header.');
    }
    chunks.push(value);
  }
  const output = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export async function recoverFstgFile(
  imageData: ImageData,
  password = '',
): Promise<HiddenFileRecovery> {
  const capacityBytes = Math.floor((imageData.width * imageData.height * 3) / 8);
  if (capacityBytes < FIXED_HEADER_BYTES) return { found: false };

  const header = readRgbLsbBytes(imageData, 0, FIXED_HEADER_BYTES);
  if (!MAGIC.every((value, index) => header[index] === value)) {
    return { found: false };
  }

  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const flags = header[5];
  const nameLength = headerView.getUint16(6, false);
  const originalSizeBig = headerView.getBigUint64(8, false);
  const storedSizeBig = headerView.getBigUint64(16, false);
  const expectedHash = header.slice(24, 56);

  if ((flags & ~(FLAG_ZLIB | FLAG_XOR)) !== 0 || nameLength === 0 || nameLength > 255) {
    throw new Error('The hidden-file marker is present, but its header is invalid.');
  }
  if (
    originalSizeBig <= 0n ||
    originalSizeBig > BigInt(MAX_HIDDEN_FILE_BYTES) ||
    storedSizeBig > BigInt(MAX_HIDDEN_FILE_BYTES)
  ) {
    throw new Error('The hidden file size is outside the 100 MiB recovery limit.');
  }

  const originalSize = Number(originalSizeBig);
  const storedSize = Number(storedSizeBig);
  const payloadOffset = FIXED_HEADER_BYTES + nameLength;
  if (payloadOffset + storedSize > capacityBytes) {
    throw new Error('The image contains an FSTG1 marker, but the declared payload is truncated.');
  }

  const fileName = safeFileName(
    new TextDecoder().decode(readRgbLsbBytes(imageData, FIXED_HEADER_BYTES, nameLength)),
  );
  const capacityUsedPercent = Number(
    (((payloadOffset + storedSize) / capacityBytes) * 100).toFixed(1),
  );
  const sha256 = bytesToHex(expectedHash);
  const passwordProtected = (flags & FLAG_XOR) !== 0;

  if (passwordProtected && !password) {
    return {
      found: true,
      fileName,
      originalSize,
      storedSize,
      passwordProtected,
      sha256,
      capacityUsedPercent,
    };
  }

  let payload = readRgbLsbBytes(imageData, payloadOffset, storedSize);
  if (passwordProtected) {
    const keystream = await createPasswordKeystream(password, payload.length);
    payload = payload.map((byte, index) => byte ^ keystream[index]);
  }

  let recoveredBytes = (flags & FLAG_ZLIB) !== 0
    ? await decompressPayload(payload, originalSize).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith('The decompressed file is larger')) {
        throw error;
      }
      throw new Error('Could not decompress the hidden file. Check the password or confirm the image is unchanged.');
    })
    : payload;

  if (recoveredBytes.length !== originalSize) {
    throw new Error('The recovered file size does not match the header. Check the password or image integrity.');
  }

  const hashInput = new Uint8Array(recoveredBytes.length);
  hashInput.set(recoveredBytes);
  const actualHash = new Uint8Array(await crypto.subtle.digest('SHA-256', hashInput.buffer));
  if (!actualHash.every((byte, index) => byte === expectedHash[index])) {
    throw new Error('SHA-256 verification failed. The password may be incorrect or the image may have changed.');
  }

  const isPdf = recoveredBytes.length >= 4 &&
    recoveredBytes[0] === 0x25 &&
    recoveredBytes[1] === 0x50 &&
    recoveredBytes[2] === 0x44 &&
    recoveredBytes[3] === 0x46;
  const fileBytes = new Uint8Array(recoveredBytes.length);
  fileBytes.set(recoveredBytes);
  const recoveredFile = new Blob(
    [fileBytes.buffer],
    { type: isPdf ? 'application/pdf' : 'application/octet-stream' },
  );
  recoveredBytes = new Uint8Array(0);

  return {
    found: true,
    fileName,
    originalSize,
    storedSize,
    passwordProtected,
    sha256,
    capacityUsedPercent,
    recoveredFile,
  };
}

export function detectPngTrailingData(bytes: Uint8Array): PngDetection {
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const isPng = pngSignature.every((value, index) => bytes[index] === value);
  const reasons: string[] = [];
  let appendedBytes = 0;

  if (isPng) {
    for (let index = bytes.length - 8; index >= 8; index -= 1) {
      if (
        bytes[index] === 0x49 &&
        bytes[index + 1] === 0x45 &&
        bytes[index + 2] === 0x4e &&
        bytes[index + 3] === 0x44
      ) {
        appendedBytes = Math.max(0, bytes.length - (index + 8));
        break;
      }
    }
  }

  if (appendedBytes > 0) {
    reasons.push(`${appendedBytes.toLocaleString()} extra bytes were found after the PNG IEND end marker.`);
  }

  return {
    appendedBytes,
    verdict: appendedBytes > 0 ? 'Needs review' : 'Clean',
    reasons,
  };
}
