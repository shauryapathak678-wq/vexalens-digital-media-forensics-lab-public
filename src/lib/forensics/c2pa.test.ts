import { describe, it, expect } from 'vitest';
import { inspectC2PAManifest } from './c2pa';

describe('C2PA & Content Credentials Inspector (Module 1E)', () => {
  it('returns hasManifest: false when no C2PA box is present', async () => {
    const rawBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    const result = await inspectC2PAManifest(rawBytes);

    expect(result.hasManifest).toBe(false);
    expect(result.validationStatus).toBe('no_manifest_found');
    // Ensure missing credentials is NOT labelled as proof of forgery
    expect(result.disclaimer).toContain('NOT indicate that media is fake');
  });

  it('detects JUMBF / c2pa binary box in payload', async () => {
    const encoder = new TextEncoder();
    // Simulate JPEG buffer containing a JUMD / c2pa box marker
    const dummyJpeg = new Uint8Array(100);
    dummyJpeg[0] = 0xff;
    dummyJpeg[1] = 0xd8; // JPEG SOI
    dummyJpeg[2] = 0xff;
    dummyJpeg[3] = 0xeb; // APP11 marker
    // Insert 'jumd' ASCII
    dummyJpeg[10] = 0x6a;
    dummyJpeg[11] = 0x75;
    dummyJpeg[12] = 0x6d;
    dummyJpeg[13] = 0x64;

    const result = await inspectC2PAManifest(dummyJpeg);
    expect(result.hasManifest).toBe(true);
    expect(result.validationStatus).toBe('manifest_detected_unverified');
    expect(result.provenanceSummary).toContain('does not validate');
    expect(result.rawBoxesFound.some((b) => b.includes('JUMD'))).toBe(true);
  });

  it('detects MP4 C2PA UUID box in video payload', async () => {
    const buffer = new Uint8Array(64);
    // 'uuid' marker
    buffer[4] = 0x75;
    buffer[5] = 0x75;
    buffer[6] = 0x69;
    buffer[7] = 0x64;
    // C2PA UUID: d8 fe c3 d6 1b 0e 48 3c 92 91 00 00 00 00 00 01
    const c2paUuid = [0xd8, 0xfe, 0xc3, 0xd6, 0x1b, 0x0e, 0x48, 0x3c, 0x92, 0x91, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01];
    c2paUuid.forEach((byte, idx) => {
      buffer[8 + idx] = byte;
    });

    const result = await inspectC2PAManifest(buffer);
    expect(result.hasManifest).toBe(true);
    expect(result.rawBoxesFound.some((b) => b.includes('MP4_C2PA_UUID'))).toBe(true);
  });

  it('correctly extracts digital source type from XMP provenance metadata', async () => {
    const xmpSample = `
      <x:xmpmeta xmlns:x="adobe:ns:meta/">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <rdf:Description c2pa:claim_generator="Adobe Photoshop 2026"
            iptc:digitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia">
          </rdf:Description>
        </rdf:RDF>
      </x:xmpmeta>
    `;
    const result = await inspectC2PAManifest(xmpSample);

    expect(result.hasManifest).toBe(true);
    expect(result.digitalSourceType).toContain('trainedAlgorithmicMedia');
    expect(result.claimGenerator).toBe('Adobe');
    expect(result.assertions.some((a) => a.label === 'c2pa.digital_source_type')).toBe(true);
  });

  it('does not claim that a detected marker is a validated signature', async () => {
    const result = await inspectC2PAManifest('c2pa test manifest');
    expect(result.validationStatus).toBe('manifest_detected_unverified');
    expect(result.disclaimer).toContain('not a signature verification');
    expect(result.disclaimer).toContain('does not independently prove the physical truth');
  });
});
