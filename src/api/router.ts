// SPDX-License-Identifier: Apache-2.0
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { ApiError } from '../errors.js';
import { createLogger, type Logger } from '../logger.js';
import { isStreamId } from '../pipeline/stream-id.js';
import type { ControlApi } from '../service.js';
import { parseLicenseRef, parseStreamConfig } from './validation.js';

/** Largest accepted request body. The biggest legitimate body is a stream config of ~400 bytes. */
export const MAX_BODY_BYTES = 16 * 1024;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
} as const;

interface RouteContext {
  api: ControlApi;
  req: IncomingMessage;
  streamId: string | null;
}

interface RouteResult {
  status: number;
  body?: unknown;
}

type Handler = (context: RouteContext) => Promise<RouteResult> | RouteResult;

interface Route {
  /** Path pattern; `:streamId` captures a UUID. */
  path: string;
  methods: Readonly<Record<string, Handler>>;
}

const ok = (body: unknown): RouteResult => ({ status: 200, body });

/** The complete route table; `openapi.json` documents exactly these. */
export const ROUTES: readonly Route[] = [
  { path: '/v1/status', methods: { GET: ({ api }) => ok(api.status()) } },
  {
    path: '/v1/license',
    methods: {
      PUT: async ({ api, req }) =>
        ok(await api.acceptLicense(parseLicenseRef(await readJson(req)))),
      DELETE: async ({ api }) => ok(await api.revokeLicense()),
    },
  },
  { path: '/v1/license/text', methods: { GET: ({ api }) => ok(api.licenseText()) } },
  { path: '/v1/streams', methods: { GET: ({ api }) => ok({ streams: api.listStreams() }) } },
  {
    path: '/v1/streams/:streamId',
    methods: {
      PUT: async ({ api, req, streamId }) =>
        ok(await api.putStream(requireId(streamId), parseStreamConfig(await readJson(req)))),
      DELETE: async ({ api, streamId }) => {
        await api.deleteStream(requireId(streamId));
        return { status: 204 };
      },
    },
  },
];

function requireId(streamId: string | null): string {
  if (streamId === null) {
    throw new ApiError(400, 'invalid_stream_id', 'streamId must be a UUID');
  }
  return streamId;
}

/** Matches a path to a route. A malformed stream id still matches, so it answers 400, not 404. */
function matchRoute(pathname: string): { route: Route; streamId: string | null } | null {
  for (const route of ROUTES) {
    if (route.path === pathname) {
      return { route, streamId: null };
    }
  }
  const prefix = '/v1/streams/';
  if (pathname.startsWith(prefix) && pathname.length > prefix.length) {
    const candidate = pathname.slice(prefix.length);
    const route = ROUTES.find((entry) => entry.path === '/v1/streams/:streamId');
    if (route && !candidate.includes('/')) {
      return { route, streamId: isStreamId(candidate) ? candidate.toLowerCase() : null };
    }
  }
  return null;
}

function isJsonContentType(header: string | undefined): boolean {
  return header?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/** Reads and parses a JSON body, enforcing content type and size. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!isJsonContentType(req.headers['content-type'])) {
    throw new ApiError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) {
    throw new ApiError(413, 'payload_too_large', `Body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new ApiError(413, 'payload_too_large', `Body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_json', 'Body is not valid JSON');
  }
}

function send(res: ServerResponse, status: number, body?: unknown, extra = {}): void {
  if (body === undefined) {
    res.writeHead(status, { 'cache-control': 'no-store', ...extra });
    res.end();
    return;
  }
  res.writeHead(status, { ...JSON_HEADERS, ...extra });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, error: ApiError, extra = {}): void {
  send(res, error.status, { error: { code: error.code, message: error.message } }, extra);
}

/** The HTTP request listener for the control API. Only the documented routes answer. */
export function createRequestHandler(
  api: ControlApi,
  logger: Logger = createLogger('api'),
): RequestListener {
  return (req, res) => {
    void handle(api, logger, req, res);
  };
}

async function handle(
  api: ControlApi,
  logger: Logger,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const matched = matchRoute(pathname);
    if (!matched) {
      throw new ApiError(404, 'not_found', 'Unknown route');
    }
    const handler = matched.route.methods[req.method ?? ''];
    if (!handler) {
      const allow = Object.keys(matched.route.methods).join(', ');
      sendError(res, new ApiError(405, 'method_not_allowed', `Use ${allow}`), { allow });
      return;
    }
    const result = await handler({ api, req, streamId: matched.streamId });
    send(res, result.status, result.body);
  } catch (error) {
    if (error instanceof ApiError) {
      // Close after a rejected body so an oversized upload is not read to the end.
      sendError(res, error, error.status === 413 ? { connection: 'close' } : {});
      return;
    }
    logger.error(
      `Unhandled error on ${req.method} ${req.url}: ${error instanceof Error ? error.message : String(error)}`,
    );
    sendError(res, new ApiError(500, 'internal_error', 'Internal error'));
  }
}
