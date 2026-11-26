import { describe, expect, it } from 'vitest';
import { decodeDeepSafeVideoFrameDataUrl } from './deepsafeVideoFrames';

describe('DeepSafe sampled video-frame decoding', () => {
  it('accepts JPEG base64 with omitted padding', () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02]);
    const dataUrl = `data:image/jpeg;base64,${bytes.toString('base64').replace(/=+$/, '')}`;

    expect(decodeDeepSafeVideoFrameDataUrl(dataUrl, 1024)).toEqual({
      bytes,
      mimeType: 'image/jpeg',
    });
  });

  it('detects PNG frame bytes and accepts browser data URL parameters', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;

    expect(decodeDeepSafeVideoFrameDataUrl(dataUrl, 1024).mimeType).toBe('image/png');
    expect(decodeDeepSafeVideoFrameDataUrl(
      `data:image/jpg;charset=utf-8;base64,${bytes.toString('base64')}`,
      1024,
    ).mimeType).toBe('image/png');
  });

  it('rejects invalid base64 and oversized frames', () => {
    expect(() => decodeDeepSafeVideoFrameDataUrl('data:image/jpeg;base64,not base64', 1024))
      .toThrow('valid JPEG or PNG');
    expect(() => decodeDeepSafeVideoFrameDataUrl(
      `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0x01]).toString('base64')}`,
      3,
    )).toThrow('exceeds the frame size limit');
    expect(() => decodeDeepSafeVideoFrameDataUrl(
      `data:image/jpeg;base64,${Buffer.from('not image').toString('base64')}`,
      1024,
    )).toThrow('not a JPEG or PNG image');
  });
});
