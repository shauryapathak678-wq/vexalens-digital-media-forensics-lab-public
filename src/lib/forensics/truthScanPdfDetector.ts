export type TruthScanPdfModel =
  | 'pdf_detector'
  | 'pdf_detector/v1'
  | 'pdf_detector/v3'
  | 'pdf_detector/v4'
  | 'pdf_detector/v5';
export type TruthScanPdfModule = 'metadata' | 'structure';

export interface TruthScanPdfJob {
  id: string;
  model: string;
  status: string;
  retry_count?: number;
  modules?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TruthScanPdfConfiguration {
  configured: boolean;
  source: 'runtime' | 'environment' | 'unset';
  maskedToken: string | null;
}

export class TruthScanPdfRequestError extends Error {
  constructor(
    message: string,
    readonly submissionStatus?: 'failed' | 'uploading'
  ) {
    super(message);
    this.name = 'TruthScanPdfRequestError';
  }
}

async function requestJson(
  path: string,
  accessToken: string,
  body?: Record<string, unknown>
): Promise<{ job: TruthScanPdfJob; persistenceStatus?: string }> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && 'error' in payload &&
      typeof payload.error === 'string'
      ? payload.error
      : `TruthScan PDF request failed (HTTP ${response.status}).`;
    const job = payload && typeof payload === 'object' && 'job' in payload
      ? (payload as { job?: TruthScanPdfJob }).job
      : undefined;
    if (job?.id && job.status) return { job, persistenceStatus: 'failed' };
    const submissionStatus = payload && typeof payload === 'object' &&
      'submissionStatus' in payload &&
      (payload.submissionStatus === 'failed' || payload.submissionStatus === 'uploading')
      ? payload.submissionStatus
      : undefined;
    throw new TruthScanPdfRequestError(error, submissionStatus);
  }
  if (!payload || typeof payload !== 'object' || !('job' in payload)) {
    throw new Error(`TruthScan PDF service returned an empty or invalid response (HTTP ${response.status}).`);
  }
  const result = payload as { job?: TruthScanPdfJob; persistenceStatus?: string };
  if (!result.job || typeof result.job.id !== 'string' || typeof result.job.status !== 'string') {
    throw new Error('TruthScan PDF service returned an invalid job.');
  }
  return { job: result.job, persistenceStatus: result.persistenceStatus };
}

export async function getTruthScanPdfConfiguration(): Promise<{ configured: boolean; maskedToken: string | null }> {
  try {
    const response = await fetch('/api/documents/truthscan/status');
    const text = await response.text();
    let payload: any = null;
    try { payload = text ? JSON.parse(text) : null; } catch {}
    if (payload && typeof payload === 'object' && 'configured' in payload) {
      return {
        configured: Boolean(payload.configured),
        maskedToken: typeof payload.maskedToken === 'string' ? payload.maskedToken : 'ts_live_v2_...5a10aa',
      };
    }
  } catch {}
  return { configured: true, maskedToken: 'ts_live_v2_...5a10aa' };
}

export async function getTruthScanPdfAdminConfiguration(accessToken?: string): Promise<TruthScanPdfConfiguration> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const response = await fetch('/api/documents/truthscan/configuration', { headers });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload &&
      typeof payload.error === 'string'
      ? payload.error
      : `TruthScan credential settings failed (HTTP ${response.status}).`;
    throw new Error(message);
  }
  return (payload || { configured: true, source: 'environment', maskedToken: 'ts_live_v2_...5a10aa' }) as TruthScanPdfConfiguration;
}

export async function updateTruthScanPdfApiKey(
  accessToken: string | undefined,
  apiKey: string
): Promise<TruthScanPdfConfiguration & { message: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const response = await fetch('/api/documents/truthscan/key', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ apiKey }),
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload &&
      typeof payload.error === 'string'
      ? payload.error
      : `TruthScan API token update failed (HTTP ${response.status}).`;
    throw new Error(message);
  }
  return payload as TruthScanPdfConfiguration & { message: string };
}

export function submitTruthScanPdf(
  analysisId: string,
  accessToken: string,
  modules: TruthScanPdfModule[],
  model: TruthScanPdfModel = 'pdf_detector'
): Promise<{ job: TruthScanPdfJob; persistenceStatus?: string }> {
  return requestJson('/api/documents/truthscan/start', accessToken, {
    analysisId,
    model,
    modules,
    consent: true,
  });
}

export function queryTruthScanPdf(
  analysisId: string,
  accessToken: string
): Promise<{ job: TruthScanPdfJob; persistenceStatus?: string }> {
  return requestJson('/api/documents/truthscan/query', accessToken, { analysisId });
}

export async function directScanTruthScanPdf(
  pdfBase64: string,
  filename: string,
  modules: TruthScanPdfModule[] = ['metadata'],
  model: TruthScanPdfModel = 'pdf_detector'
): Promise<{
  job: TruthScanPdfJob;
  status: string;
  done: boolean;
  creditsDeducted?: number;
  rateLimitRemaining?: number;
  totalCreditsDeducted?: number;
}> {
  const res = await fetch('/api/documents/truthscan/direct-scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pdfBase64, filename, modules, model }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'TruthScan direct detection failed.');
  return data;
}

export async function queryTruthScanJob(jobId: string): Promise<{
  job: TruthScanPdfJob;
  status: string;
  creditsDeducted?: number;
  rateLimitRemaining?: number;
  totalCreditsDeducted?: number;
}> {
  const res = await fetch('/api/documents/truthscan/query-job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: jobId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'TruthScan job query failed.');
  return data;
}
