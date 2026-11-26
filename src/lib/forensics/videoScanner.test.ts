import { describe, it, expect } from 'vitest';
import { validateVideoBitstream } from './videoScanner';

describe('Video Deepfake Scanner & Media Intake (Module 2)', () => {
  it('correctly validates MP4 container with ftyp signature box', () => {
    const mp4Bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x20, // size
      0x66, 0x74, 0x79, 0x70, // 'ftyp'
      0x69, 0x73, 0x6f, 0x6d, // 'isom'
      0x00, 0x00, 0x02, 0x00,
    ]);

    const validation = validateVideoBitstream(mp4Bytes, 'surveillance_feed.mp4');
    expect(validation.valid).toBe(true);
    expect(validation.format).toContain('MP4');
  });

  it('correctly validates WebM container with EBML header', () => {
    const webmBytes = new Uint8Array([
      0x1a, 0x45, 0xdf, 0xa3, // EBML ID
      0x01, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x1f,
      0x42, 0x86, 0x81, 0x01,
    ]);

    const validation = validateVideoBitstream(webmBytes, 'recorded_session.webm');
    expect(validation.valid).toBe(true);
    expect(validation.format).toContain('WebM');
  });

  it('correctly rejects truncated or corrupted bitstream buffer', () => {
    const corruptBytes = new Uint8Array([0x00, 0x01, 0x02]);
    const validation = validateVideoBitstream(corruptBytes, 'damaged.mp4');
    expect(validation.valid).toBe(false);
    expect(validation.error).toContain('truncated or empty');
  });

  it('correctly rejects unrecognized non-video file signatures', () => {
    const exeBytes = new Uint8Array([
      0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00,
      0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00,
    ]);
    const validation = validateVideoBitstream(exeBytes, 'malicious_payload.exe');
    expect(validation.valid).toBe(false);
    expect(validation.error).toContain('Unrecognized video file signature');
  });
});
