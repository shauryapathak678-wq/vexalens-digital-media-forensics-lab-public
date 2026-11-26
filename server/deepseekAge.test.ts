import { describe, expect, it, vi } from 'vitest';
import { estimateAgeWithDeepSeek } from './deepseekAge';

describe('DeepSeek image age estimation', () => {
  it('sends an image data URL and Bearer Modal token', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      choices: [{ message: { content: '{"faces":[{"age":27.4,"confidence":99}],"summary":"One adult face is visible."}' } }],
    }));

    const result = await estimateAgeWithDeepSeek(
      'token-id',
      'token-secret',
      Buffer.from('image bytes'),
      'image/jpeg',
      fetchMock as unknown as typeof fetch,
    );

    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/v1/chat/completions');
    expect(new Headers(options.headers).get('authorization')).toBe('Bearer token-id.token-secret');
    const body = JSON.parse(String(options.body));
    const userContent = body.messages[1].content;
    expect(userContent[0].type).toBe('text');
    expect(userContent[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(result.faces[0]).toMatchObject({ age: 27.4, score: 0.99 });
    expect(result.message).toBe('One adult face is visible.');
  });

  it('redacts and classifies invalid Modal webhook credentials', async () => {
    await expect(estimateAgeWithDeepSeek(
      'token-id',
      'token-secret',
      Buffer.from('image bytes'),
      'image/jpeg',
      vi.fn(async () => Response.json(
        { error: 'Webhook token secret validation failure: token-id' },
        { status: 401 },
      )) as unknown as typeof fetch,
    )).rejects.toThrow(/invalid or have been rotated/);
  });

  it('handles no detected faces', async () => {
    const result = await estimateAgeWithDeepSeek(
      'token-id',
      'token-secret',
      Buffer.from('image bytes'),
      'image/png',
      vi.fn(async () => Response.json({ choices: [{ message: { content: '{"faces":[],"summary":"No clearly visible human face was detected."}' } }] })) as unknown as typeof fetch,
    );
    expect(result.faces).toEqual([]);
  });
});
