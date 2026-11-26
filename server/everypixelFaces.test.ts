import { describe, expect, it, vi } from 'vitest';
import { estimateFacesWithEverypixel } from './everypixelFaces';

const everypixelResponse = {
  status: 'ok',
  faces: [{
    age: 20.553737561567686,
    score: 0.9999862909317017,
    bbox: [488.1020906694572, 147.58440036790006, 824.1707326180912, 581.0635042573758],
    class: 'Age - Young Adult',
  }],
};

describe('Everypixel Faces API', () => {
  it('sends image uploads as authenticated multipart data and normalizes faces', async () => {
    const fetchMock = vi.fn(async () => Response.json(everypixelResponse));

    const result = await estimateFacesWithEverypixel(
      'client-id',
      'client-secret',
      {
        buffer: Buffer.from('image bytes'),
        fileName: 'portrait.jpg',
        contentType: 'image/jpeg',
      },
      fetchMock as unknown as typeof fetch,
    );

    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.everypixel.com/v1/faces');
    expect(options.method).toBe('POST');
    expect(new Headers(options.headers).get('authorization'))
      .toBe(`Basic ${Buffer.from('client-id:client-secret').toString('base64')}`);
    expect((options.body as FormData).get('data')).toBeInstanceOf(Blob);
    expect(result).toEqual({ ...everypixelResponse, provider: 'everypixel' });
  });

  it('calls the URL endpoint with an encoded image URL using GET', async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: 'ok', faces: [] }));
    const imageUrl = 'https://labs.everypixel.com/static/i/estest_sample3.jpg';

    await estimateFacesWithEverypixel(
      'client-id',
      'client-secret',
      { url: imageUrl },
      fetchMock as unknown as typeof fetch,
    );

    const [requestUrl, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsedUrl = new URL(requestUrl);
    expect(parsedUrl.origin + parsedUrl.pathname).toBe('https://api.everypixel.com/v1/faces');
    expect(parsedUrl.searchParams.get('url')).toBe(imageUrl);
    expect(options.method).toBe('GET');
    expect(options.body).toBeUndefined();
  });

  it('rejects non-HTTPS source URLs and reports API errors', async () => {
    await expect(estimateFacesWithEverypixel(
      'client-id',
      'client-secret',
      { url: 'http://example.com/image.jpg' },
      vi.fn() as unknown as typeof fetch,
    )).rejects.toThrow('Everypixel image URLs must use HTTPS.');

    const fetchMock = vi.fn(async () => Response.json(
      { status: 'error', message: 'Invalid credentials' },
      { status: 401 },
    ));
    await expect(estimateFacesWithEverypixel(
      'client-id',
      'wrong-secret',
      { buffer: Buffer.from('image bytes'), fileName: 'image.jpg', contentType: 'image/jpeg' },
      fetchMock as unknown as typeof fetch,
    )).rejects.toThrow('Invalid credentials');
  });
});
