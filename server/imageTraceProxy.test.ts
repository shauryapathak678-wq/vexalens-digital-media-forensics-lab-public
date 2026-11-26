import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { registerImageTraceProxy } from './imageTraceProxy';

describe('Image Trace API proxy', () => {
  let upstreamServer: http.Server | undefined;
  let appServer: ReturnType<ReturnType<typeof express>['listen']> | undefined;

  afterEach(async () => {
    upstreamServer?.closeAllConnections();
    appServer?.closeAllConnections();
    await Promise.all(
      [upstreamServer, appServer].filter(Boolean).map(
        (server) => new Promise<void>((resolve, reject) => {
          server?.close((error) => error ? reject(error) : resolve());
        }),
      ),
    );
    upstreamServer = undefined;
    appServer = undefined;
  });

  it('forwards multipart search uploads and streams SSE responses', async () => {
    let receivedPath = '';
    let receivedMethod = '';
    let receivedContentType = '';
    let receivedBody = '';
    upstreamServer = http.createServer((request, response) => {
      receivedPath = request.url || '';
      receivedMethod = request.method || '';
      receivedContentType = request.headers['content-type'] || '';
      if (request.method === 'GET') {
        response.writeHead(405, { 'Content-Type': 'application/json' });
        response.end('{"detail":"Method Not Allowed"}');
        return;
      }
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { receivedBody += chunk; });
      request.on('end', () => {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        response.write('data: {"type":"start"}\n\n');
        setTimeout(() => response.end('data: {"type":"complete"}\n\n'), 20);
      });
    });
    await new Promise<void>((resolve) => upstreamServer?.listen(0, '127.0.0.1', resolve));
    const upstreamAddress = upstreamServer.address() as AddressInfo;

    const app = express();
    app.use(express.json({ limit: '60mb' }));
    app.use(express.urlencoded({ extended: true, limit: '60mb' }));
    registerImageTraceProxy(app, upstreamAddress.port);
    appServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => appServer?.once('listening', resolve));
    const appAddress = appServer.address() as AddressInfo;

    const form = new FormData();
    form.append('image', new Blob(['test-image']), 'image-trace-search.jpg');
    const response = await fetch(`http://127.0.0.1:${appAddress.port}/api/trace/stream?case_id=case-1`, {
      method: 'POST',
      headers: { Accept: 'text/event-stream' },
      body: form,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    await expect(response.text()).resolves.toContain('"type":"complete"');
    expect(receivedPath).toBe('/api/trace/stream?case_id=case-1');
    expect(receivedMethod).toBe('POST');
    expect(receivedContentType).toContain('multipart/form-data');
    expect(receivedBody).toContain('image-trace-search.jpg');

    const methodCheck = await fetch(`http://127.0.0.1:${appAddress.port}/api/trace/stream`, {
      signal: AbortSignal.timeout(1000),
    });
    expect(methodCheck.status).toBe(405);

    const invalidMediaType = await fetch(`http://127.0.0.1:${appAddress.port}/api/trace/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(invalidMediaType.status).toBe(415);
  });
});
