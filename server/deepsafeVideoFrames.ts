export type DeepSafeVideoFrameMimeType = 'image/jpeg' | 'image/png';

export interface DecodedDeepSafeVideoFrame {
  bytes: Buffer;
  mimeType: DeepSafeVideoFrameMimeType;
}

export function decodeDeepSafeVideoFrameDataUrl(
  value: unknown,
  maxBytes: number,
): DecodedDeepSafeVideoFrame {
  if (typeof value !== 'string') {
    throw new Error('A valid JPEG or PNG video frame is required.');
  }

  const commaIndex = value.indexOf(',');
  const isDataUrl = commaIndex >= 0;
  const header = isDataUrl ? value.slice(0, commaIndex) : '';
  if (isDataUrl && !/^data:image\/[a-z0-9.+-]+(?:;[^,;]+)*;base64$/i.test(header)) {
    throw new Error('A valid JPEG or PNG video frame is required.');
  }

  const encoded = (isDataUrl ? value.slice(commaIndex + 1) : value).replace(/\s/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw new Error('A valid JPEG or PNG video frame is required.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new Error('A valid JPEG or PNG video frame is required.');
  }
  if (bytes.length === 0 || bytes.length > maxBytes) {
    throw new Error('The selected video frame is empty or exceeds the frame size limit.');
  }

  const isJpeg = bytes.length >= 3 &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!isJpeg && !isPng) {
    throw new Error('The selected video frame data is not a JPEG or PNG image.');
  }

  return { bytes, mimeType: isJpeg ? 'image/jpeg' : 'image/png' };
}
