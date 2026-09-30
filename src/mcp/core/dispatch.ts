import http from 'http';
import { Socket } from 'net';
import type { Express } from 'express';
import { createServer } from '../../server';
import { getDb } from '../../core/db';

/**
 * In-process transport into the apaleo API.
 *
 * The MCP tools call the real Express application - every route, validator and
 * business rule the HTTP API runs - but without a TCP hop, a socket, or JSON
 * being serialised and reparsed across a loopback connection. A tool call is a
 * function call that happens to travel through the router.
 *
 * Going through the app rather than importing the domain layer directly is
 * deliberate: it means an MCP tool and an HTTP client cannot diverge in what
 * they validate, what they permit, or what they return.
 */

let app: Express | null = null;

function application(): Express {
  if (!app) {
    getDb();
    app = createServer();
  }
  return app;
}

export interface ApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  /** Bearer token to present. Omitted when the server allows anonymous access. */
  token?: string;
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | number | undefined>;
}

/** Build a query string, expanding arrays into repeated parameters. */
export function toQuery(params: Record<string, unknown> | undefined): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null || item === '') continue;
        search.append(key, String(item));
      }
    } else {
      search.append(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/**
 * Run one request through the application.
 *
 * `IncomingMessage` and `ServerResponse` are real Node objects so express sees
 * exactly what it would over the wire; only the socket is stubbed, and the
 * response body is captured by intercepting `write`/`end` rather than by
 * parsing raw HTTP off a fake socket.
 */
export function dispatch<T = any>(request: ApiRequest): Promise<ApiResponse<T>> {
  return new Promise((resolve, reject) => {
    const payload = request.body === undefined ? undefined : Buffer.from(JSON.stringify(request.body));

    const socket = new Socket();
    const req = new http.IncomingMessage(socket);
    req.method = request.method;
    req.url = request.path + toQuery(request.query);
    req.headers = {
      host: 'mcp.local',
      accept: 'application/json',
      ...(payload
        ? { 'content-type': 'application/json', 'content-length': String(payload.length) }
        : {}),
      ...(request.token ? { authorization: `Bearer ${request.token}` } : {}),
    };
    req.httpVersion = '1.1';
    req.httpVersionMajor = 1;
    req.httpVersionMinor = 1;

    const res = new http.ServerResponse(req);
    // Never let the response object reach for a socket it does not have.
    res.assignSocket(socket as never);

    const chunks: Buffer[] = [];
    let settled = false;

    const capture = (chunk: unknown, encoding?: unknown): void => {
      if (chunk === undefined || chunk === null) return;
      if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      else if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk, (typeof encoding === 'string' ? encoding : 'utf8') as BufferEncoding));
      }
    };

    res.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
      capture(chunk, encoding);
      if (typeof encoding === 'function') (encoding as () => void)();
      else if (typeof callback === 'function') (callback as () => void)();
      return true;
    }) as typeof res.write;

    res.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown) => {
      if (typeof chunk !== 'function') capture(chunk, encoding);
      finish();
      for (const maybe of [chunk, encoding, callback]) {
        if (typeof maybe === 'function') (maybe as () => void)();
      }
      return res;
    }) as typeof res.end;

    function finish(): void {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      const contentType = String(res.getHeader('content-type') ?? '');
      let body: unknown = text;
      if (text && contentType.includes('json')) {
        try {
          body = JSON.parse(text);
        } catch {
          /* leave as text: the caller reports it verbatim */
        }
      } else if (!text) {
        body = undefined;
      }
      resolve({ status: res.statusCode, body: body as T, headers: res.getHeaders() });
    }

    // Express reads the body off the request stream.
    process.nextTick(() => {
      try {
        application()(req as never, res as never);
        if (payload) req.push(payload);
        req.push(null);
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    });
  });
}
