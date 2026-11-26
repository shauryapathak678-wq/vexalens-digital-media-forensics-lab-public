import http from 'node:http';
import express, { type Express, type Request, type Response } from 'express';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const IMAGE_TRACE_ROUTES = [
  '/api/trace',
  '/api/trace/stream',
  '/api/scan',
  '/api/cases',
  '/api/cases/:recordId',
  '/api/cases/:recordId/report',
  '/api/verify-log',
];

const IMAGE_TRACE_UPLOAD_ROUTES = new Set(['/api/trace', '/api/trace/stream', '/api/scan']);

function proxyToFastApi(request: Request, response: Response, port: number, body?: Buffer): void {
  const headers: http.OutgoingHttpHeaders = { ...request.headers, host: `127.0.0.1:${port}` };
  for (const header of HOP_BY_HOP_HEADERS) delete headers[header];

  const upstreamRequest = http.request(
    {
      hostname: '127.0.0.1',
      port,
      method: request.method,
      path: request.originalUrl,
      headers,
    },
    (upstreamResponse) => {
      response.status(upstreamResponse.statusCode || 502);
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
          response.setHeader(name, value);
        }
      }
      upstreamResponse.pipe(response);
    },
  );

  upstreamRequest.on('error', (error: Error) => {
    if (request.aborted || response.destroyed) return;
    console.error('[Image Trace] Local API proxy failed:', error.message);
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    response.status(503).json({
      error: 'The local Image Trace backend is unavailable. Start the local backend and try again.',
    });
  });

  request.on('aborted', () => upstreamRequest.destroy());
  response.on('close', () => {
    if (!response.writableEnded) upstreamRequest.destroy();
  });
  upstreamRequest.end(body);
}

export function registerImageTraceProxy(app: Express, port = 8000): void {
  const parseMultipartBody = express.raw({ type: () => true, limit: '16mb' });
  app.all(IMAGE_TRACE_ROUTES, (request: Request, response: Response, next) => {
    if (request.method === 'POST' && IMAGE_TRACE_UPLOAD_ROUTES.has(request.path)) {
      const contentType = (request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'multipart/form-data') {
        response.status(415).json({ detail: 'Image Trace uploads must use multipart/form-data.' });
        return;
      }

      parseMultipartBody(request, response, (error: unknown) => {
        if (error) {
          next(error);
          return;
        }
        proxyToFastApi(
          request,
          response,
          port,
          Buffer.isBuffer(request.body) ? request.body : undefined,
        );
      });
      return;
    }

    proxyToFastApi(request, response, port);
  });
}
