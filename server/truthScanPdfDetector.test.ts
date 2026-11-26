import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  queryTruthScanPdf,
  submitTruthScanPdf,
  truthScanPdfCreditsDeducted,
} from './truthScanPdfDetector';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TruthScan PDF detector workflow', () => {
  it('requests a presigned URL, uploads privately, and submits the selected detector modules', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'success',
        presigned_url: 'https://nyc3.digitaloceanspaces.com/bucket/report.pdf?signature=secret',
        file_path: 'report.pdf',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'pdf-job-1',
        model: 'pdf_detector/v5',
        status: 'pending',
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await submitTruthScanPdf(
      Buffer.from('%PDF-1.7'),
      'report.pdf',
      'server-secret',
      'pdf_detector/v5',
      ['metadata']
    );

    expect(result).toMatchObject({ id: 'pdf-job-1', status: 'pending' });
    expect(fetchMock).toHaveBeenNthCalledWith(1,
      'https://detect-pdf.truthscan.com/get-presigned-url?file_name=report.pdf&expiration=3600',
      expect.objectContaining({ headers: { apikey: 'server-secret', accept: 'application/json' } })
    );
    const uploadCall = fetchMock.mock.calls[1];
    expect(uploadCall[0]).toBeInstanceOf(URL);
    expect((uploadCall[0] as URL).href).toBe('https://nyc3.digitaloceanspaces.com/bucket/report.pdf?signature=secret');
    expect(uploadCall[1]).toEqual(expect.objectContaining({
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf', 'x-amz-acl': 'private' },
    }));
    const detectRequest = fetchMock.mock.calls[2][1] as RequestInit;
    expect(JSON.parse(String(detectRequest.body))).toEqual({
      url: 'https://bucket.nyc3.digitaloceanspaces.com/report.pdf',
      key: 'server-secret',
      model: 'pdf_detector/v5',
      modules: ['metadata'],
    });
  });

  it('rejects upload URLs outside DigitalOcean Spaces before uploading evidence', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      status: 'success',
      presigned_url: 'https://attacker.example/upload?signature=secret',
      file_path: 'report.pdf',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(submitTruthScanPdf(
      Buffer.from('%PDF-1.7'),
      'report.pdf',
      'server-secret',
      'pdf_detector',
      []
    )).rejects.toThrow(/invalid or unsupported upload URL/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retrieves a job result without including the API key and reads reported credit usage', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'pdf-job-1',
      model: 'pdf_detector',
      status: 'done',
      modules: {
        metadata: { source_details: { credits_deducted: 1000 } },
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const job = await queryTruthScanPdf('pdf-job-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://detect-pdf.truthscan.com/query',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ id: 'pdf-job-1' }) })
    );
    expect(truthScanPdfCreditsDeducted(job)).toBe(1000);
  });

  it('marks a lost detection response as uncertain to prevent duplicate paid submissions', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'success',
        presigned_url: 'https://nyc3.digitaloceanspaces.com/bucket/report.pdf?signature=secret',
        file_path: 'report.pdf',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockRejectedValueOnce(new Error('network timeout'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(submitTruthScanPdf(
      Buffer.from('%PDF-1.7'),
      'report.pdf',
      'server-secret',
      'pdf_detector',
      []
    )).rejects.toMatchObject({
      submissionStatus: 'uploading',
      message: 'network timeout',
    });
  });
});
