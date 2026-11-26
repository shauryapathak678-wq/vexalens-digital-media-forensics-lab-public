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

export class TruthScanPdfSubmissionError extends Error {
  constructor(
    message: string,
    readonly submissionStatus: 'failed' | 'uploading'
  ) {
    super(message);
    this.name = 'TruthScanPdfSubmissionError';
  }
}

const API_ORIGIN = 'https://detect-pdf.truthscan.com';
const ALLOWED_MODELS = new Set<TruthScanPdfModel>([
  'pdf_detector',
  'pdf_detector/v1',
  'pdf_detector/v3',
  'pdf_detector/v4',
  'pdf_detector/v5',
]);

async function responseJson(response: Response, apiKey?: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    value = null;
  }
  if (!response.ok) {
    const body = value && typeof value === 'object'
      ? value as Record<string, unknown>
      : {};
    const detail = [body.error, body.message, body.detail]
      .find((item): item is string => typeof item === 'string' && item.trim().length > 0);
    const message = (detail || text.trim() || `TruthScan PDF request failed (HTTP ${response.status}).`)
      .replaceAll(apiKey || '\u0000', '[redacted]')
      .slice(0, 500);
    throw new Error(message);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('TruthScan PDF service returned an empty or invalid JSON response.');
  }
  return value as Record<string, unknown>;
}

function isAllowedObjectStorageUrl(value: URL): boolean {
  return value.protocol === 'https:' &&
    (value.hostname === 'digitaloceanspaces.com' || value.hostname.endsWith('.digitaloceanspaces.com')) &&
    (!value.port || value.port === '443') &&
    !value.username &&
    !value.password;
}

function getObjectStorageUrl(uploadUrl: URL, filePath: string): string {
  const hostParts = uploadUrl.hostname.split('.');
  let hostname = uploadUrl.hostname;
  if (hostParts.length === 3 && hostParts[1] === 'digitaloceanspaces' &&
      hostParts[2] === 'com') {
    const bucket = uploadUrl.pathname.split('/').filter(Boolean)[0];
    if (!bucket || !/^[a-z\d][a-z\d.-]*[a-z\d]$/i.test(bucket)) {
      throw new Error('TruthScan PDF service returned an invalid object-storage bucket path.');
    }
    hostname = `${bucket}.${uploadUrl.hostname}`;
  }
  const path = filePath.split('/').map(encodeURIComponent).join('/');
  return new URL(path, `https://${hostname}/`).toString();
}

export function truthScanPdfCreditsDeducted(job: TruthScanPdfJob): number | null {
  const modules = job.modules;
  const metadata = modules?.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const sourceDetails = (metadata as Record<string, unknown>).source_details;
  if (!sourceDetails || typeof sourceDetails !== 'object') return null;
  const credits = (sourceDetails as Record<string, unknown>).credits_deducted;
  return typeof credits === 'number' && Number.isFinite(credits) && credits >= 0 ? credits : null;
}

export async function submitTruthScanPdf(
  bytes: Buffer,
  filename: string,
  apiKey: string,
  model: TruthScanPdfModel,
  modules: TruthScanPdfModule[]
): Promise<TruthScanPdfJob> {
  if (!ALLOWED_MODELS.has(model)) throw new Error('Unsupported TruthScan PDF detector model.');
  if (!Array.isArray(modules) || modules.some((module) => module !== 'metadata' && module !== 'structure')) {
    throw new Error('TruthScan PDF modules must be metadata and/or structure.');
  }
  if (new Set(modules).size !== modules.length) throw new Error('Duplicate TruthScan PDF modules are not allowed.');
  if (!apiKey.trim()) throw new Error('TruthScan PDF API key is not configured on the server.');
  if (!/\.pdf$/i.test(filename)) throw new Error('TruthScan PDF analysis accepts PDF files only.');

  const query = new URLSearchParams({ file_name: filename, expiration: '3600' });
  const presignResponse = await fetch(`${API_ORIGIN}/get-presigned-url?${query}`, {
    headers: { apikey: apiKey, accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  const presign = await responseJson(presignResponse, apiKey);
  if (presign.status !== 'success' || typeof presign.presigned_url !== 'string' ||
      typeof presign.file_path !== 'string' || !presign.file_path.trim()) {
    throw new Error('TruthScan PDF service returned an invalid presigned upload response.');
  }

  const uploadUrl = new URL(presign.presigned_url);
  if (!isAllowedObjectStorageUrl(uploadUrl) || uploadUrl.search.length === 0) {
    throw new Error('TruthScan PDF service returned an invalid or unsupported upload URL.');
  }
  const filePathParts = presign.file_path.split('/');
  if (/^[a-z][a-z\d+.-]*:/i.test(presign.file_path) ||
      presign.file_path.startsWith('/') ||
      presign.file_path.includes('\\') ||
      /[?#\u0000-\u001f\u007f]/.test(presign.file_path) ||
      filePathParts.some((part) => part === '.' || part === '..')) {
    throw new Error('TruthScan PDF service returned an invalid object file path.');
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/pdf', 'x-amz-acl': 'private' },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(60_000),
  });
  if (!uploadResponse.ok) {
    const responseText = (await uploadResponse.text()).slice(0, 300);
    throw new Error(responseText || `TruthScan PDF upload failed (HTTP ${uploadResponse.status}).`);
  }

  const request: Record<string, unknown> = {
    url: getObjectStorageUrl(uploadUrl, presign.file_path),
    key: apiKey,
    model,
  };
  if (modules.length) request.modules = modules;

  let detectResponse: Response;
  try {
    detectResponse = await fetch(`${API_ORIGIN}/detect-pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new TruthScanPdfSubmissionError(
      error instanceof Error ? error.message : 'TruthScan PDF submission status is unknown.',
      'uploading'
    );
  }

  let job: TruthScanPdfJob;
  try {
    job = await responseJson(detectResponse, apiKey) as TruthScanPdfJob;
    if (typeof job.id !== 'string' || !job.id || typeof job.status !== 'string') {
      throw new Error('TruthScan PDF service returned an invalid detection job.');
    }
  } catch (error) {
    throw new TruthScanPdfSubmissionError(
      error instanceof Error ? error.message : 'TruthScan PDF submission status is unknown.',
      detectResponse.ok ? 'uploading' : 'failed'
    );
  }
  return job;
}

export async function queryTruthScanPdf(jobId: string): Promise<TruthScanPdfJob> {
  const response = await fetch(`${API_ORIGIN}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ id: jobId }),
    signal: AbortSignal.timeout(30_000),
  });
  const job = await responseJson(response) as TruthScanPdfJob;
  if (typeof job.id !== 'string' || !job.id || typeof job.status !== 'string') {
    throw new Error('TruthScan PDF service returned an invalid query response.');
  }
  return job;
}
