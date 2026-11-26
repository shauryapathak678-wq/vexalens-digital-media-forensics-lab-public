import { isIP } from 'net';

export interface JsonLinkPageMetadata {
  title?: string;
  description?: string;
  images: string[];
  siteName?: string;
  favicon?: string;
  domain: string;
  url: string;
  duration?: number;
}

export function validateJsonLinkSourceUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hostname === 'localhost' ||
      url.hostname.endsWith('.localhost') ||
      url.hostname.endsWith('.local') ||
      url.hostname.endsWith('.internal')
    ) return null;

    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchJsonLinkPageMetadata(
  sourceUrl: URL,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<JsonLinkPageMetadata> {
  const endpoint = new URL('https://jsonlink.io/api/extract');
  endpoint.searchParams.set('url', sourceUrl.toString());
  endpoint.searchParams.set('api_key', apiKey);
  const response = await fetchImpl(endpoint, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`JSONLink returned HTTP ${response.status}.`);
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error('JSONLink returned a non-JSON response.');
  }
  const responseText = await response.text();
  if (responseText.length > 1024 * 1024) {
    throw new Error('JSONLink response exceeded the 1 MiB response limit.');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error('JSONLink returned invalid JSON.');
  }
  if (!isRecord(payload)) throw new Error('JSONLink response was not an object.');
  const providerError = typeof payload.error === 'string'
    ? payload.error
    : isRecord(payload.error) && typeof payload.error.message === 'string'
      ? payload.error.message
      : '';
  if (providerError.trim()) {
    throw new Error(`JSONLink: ${providerError.slice(0, 300)}`);
  }

  const images = Array.isArray(payload.images)
    ? payload.images
      .map(safeHttpUrl)
      .filter((entry): entry is string => entry !== undefined)
      .slice(0, 100)
    : [];
  const optionalText = (key: string, maxLength: number): string | undefined => {
    const value = payload[key];
    return typeof value === 'string' ? value.slice(0, maxLength) : undefined;
  };
  const duration = typeof payload.duration === 'number' && Number.isFinite(payload.duration)
    ? payload.duration
    : undefined;

  return {
    ...(optionalText('title', 1000) ? { title: optionalText('title', 1000) } : {}),
    ...(optionalText('description', 4000) ? { description: optionalText('description', 4000) } : {}),
    images,
    ...(optionalText('sitename', 500) ? { siteName: optionalText('sitename', 500) } : {}),
    ...(safeHttpUrl(payload.favicon) ? { favicon: safeHttpUrl(payload.favicon) } : {}),
    domain: sourceUrl.hostname,
    url: sourceUrl.toString(),
    ...(duration === undefined ? {} : { duration }),
  };
}
