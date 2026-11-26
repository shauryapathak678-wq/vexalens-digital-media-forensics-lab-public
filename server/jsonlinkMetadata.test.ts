import { describe, expect, it, vi } from 'vitest';
import { fetchJsonLinkPageMetadata, validateJsonLinkSourceUrl } from './jsonlinkMetadata';

describe('JSONLink webpage metadata integration', () => {
  it('accepts only public HTTPS webpage URLs without credentials or IP literals', () => {
    expect(validateJsonLinkSourceUrl('https://example.com/article')).toBeInstanceOf(URL);
    expect(validateJsonLinkSourceUrl('http://example.com')).toBeNull();
    expect(validateJsonLinkSourceUrl('https://localhost')).toBeNull();
    expect(validateJsonLinkSourceUrl('https://192.168.1.2')).toBeNull();
    expect(validateJsonLinkSourceUrl('https://user:pass@example.com')).toBeNull();
  });

  it('requests webpage metadata with the server key and normalizes the JSONLink response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      title: 'Page title',
      description: 'Page description',
      images: ['https://cdn.example.com/image.jpg', 'javascript:alert(1)'],
      sitename: 'Example',
      favicon: 'https://example.com/favicon.ico',
      url: 'https://example.com/article',
      duration: 120,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const metadata = await fetchJsonLinkPageMetadata(
      new URL('https://example.com/article'),
      'private-server-key',
      fetchMock
    );
    const requestUrl = new URL(fetchMock.mock.calls[0][0] as URL);

    expect(requestUrl.origin + requestUrl.pathname).toBe('https://jsonlink.io/api/extract');
    expect(requestUrl.searchParams.get('url')).toBe('https://example.com/article');
    expect(requestUrl.searchParams.get('api_key')).toBe('private-server-key');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { Accept: 'application/json' },
      redirect: 'error',
    });
    expect(metadata).toMatchObject({
      title: 'Page title',
      description: 'Page description',
      siteName: 'Example',
      favicon: 'https://example.com/favicon.ico',
      images: ['https://cdn.example.com/image.jpg'],
      domain: 'example.com',
      url: 'https://example.com/article',
      duration: 120,
    });
  });

  it('surfaces provider errors and rejects invalid content types', async () => {
    const sourceUrl = new URL('https://example.com');
    await expect(fetchJsonLinkPageMetadata(sourceUrl, 'key', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid API key' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    ))).rejects.toThrow('JSONLink: Invalid API key');

    await expect(fetchJsonLinkPageMetadata(sourceUrl, 'key', vi.fn().mockResolvedValue(
      new Response('<html>not json</html>', { headers: { 'content-type': 'text/html' } })
    ))).rejects.toThrow('non-JSON response');
  });
});
