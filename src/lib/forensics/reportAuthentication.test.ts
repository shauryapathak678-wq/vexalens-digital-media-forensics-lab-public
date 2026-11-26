import { afterEach, describe, expect, it, vi } from 'vitest';
import { signReport } from './reportAuthentication';

const request = {
  reportNumber: 'REPORT-1',
  caseNumber: 'CASE-1',
  reportHash: 'a'.repeat(64),
  examinerName: 'Test Examiner',
  examinerBadge: 'A-1',
  agency: 'Test Lab',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('report signing responses', () => {
  it('returns the signed record from a successful JSON response', async () => {
    const record = {
      version: 'VEXA-REPORT-1',
      ...request,
      issuedAt: '2026-10-17T00:00:00.000Z',
      keyId: 'VEXA-HMAC-LOCAL',
      signature: 'b'.repeat(64),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ record }), { status: 200 })
    ));

    await expect(signReport(request)).resolves.toEqual(record);
  });

  it('explains how to recover when the signing endpoint returns an empty response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await expect(signReport(request)).rejects.toThrow(
      'returned an empty response (HTTP 503). Start or restart the VexaLens server with "npm run dev"'
    );
  });

  it('identifies a static preview response as an incorrect signing endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('<!doctype html><title>Vite preview</title>', { status: 200 })
    ));

    await expect(signReport(request)).rejects.toThrow(
      'Make sure this app is running through the VexaLens server ("npm run dev"), not a static preview.'
    );
  });
});
