// SPDX-License-Identifier: Apache-2.0
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createHarness,
  LICENSE_SHA256,
  LICENSE_TEXT,
  NDI_LICENSE_SHA256,
  NOTICE_TEXT,
  TERMS_SHA256,
  SDK_VERSION,
  STREAM_ID,
  VALID_STREAM,
  type Harness,
  type Reply,
} from '../testing/harness.js';
import { assertResponseMatches, requestBodyIsValid } from '../testing/openapi-contract.js';
import { ROUTES, MAX_BODY_BYTES } from './router.js';

const ACCEPT = { sdkVersion: SDK_VERSION, licenseSha256: LICENSE_SHA256 };
const settle = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('control API', () => {
  let h: Harness;

  /** Every reply is checked against openapi.json before the spec looks at it. */
  async function call(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Reply> {
    const reply = await h.request(method, path, body, headers);
    assertResponseMatches(method, path, reply.status, reply.body);
    return reply;
  }

  const accept = (): Promise<Reply> => call('PUT', '/v1/license', ACCEPT);

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  describe('GET /v1/status', () => {
    it('reports license_required and does not load the NDI runtime', async () => {
      const { status, body } = await call('GET', '/v1/status');

      expect(status).toBe(200);
      expect(body).toEqual({
        apiVersion: '1',
        pluginVersion: '0.0.0-test',
        state: 'license_required',
        errorCode: null,
        sdkVersion: SDK_VERSION,
        license: {
          ...ACCEPT,
          ndiLicenseSha256: NDI_LICENSE_SHA256,
          termsSha256: TERMS_SHA256,
        },
        acceptance: null,
        arch: 'x64',
        encoders: ['libx264'],
      });
      expect(h.ndi.load).not.toHaveBeenCalled();
    });

    it('is served with no-store and JSON headers', async () => {
      const { headers } = await call('GET', '/v1/status');

      expect(headers['content-type']).toBe('application/json; charset=utf-8');
      expect(headers['cache-control']).toBe('no-store');
    });
  });

  describe('license', () => {
    it('serves the shipped text and the plugin terms', async () => {
      const { status, body } = await call('GET', '/v1/license/text');

      expect(status).toBe(200);
      expect(body).toEqual({
        ...ACCEPT,
        ndiLicenseSha256: NDI_LICENSE_SHA256,
        termsSha256: TERMS_SHA256,
        licenseText: LICENSE_TEXT,
        pluginTerms: NOTICE_TEXT,
      });
    });

    it('accepts the exact hash, loads the runtime and becomes ready', async () => {
      const { status, body } = await accept();

      expect(status).toBe(200);
      expect(body).toMatchObject({
        state: 'ready',
        acceptance: { ...ACCEPT, via: 'api' },
      });
      expect(h.ndi.load).toHaveBeenCalledTimes(1);
    });

    it('refuses a hash that does not match the shipped text', async () => {
      const wrong = { ...ACCEPT, licenseSha256: 'a'.repeat(64) };

      const { status, body } = await call('PUT', '/v1/license', wrong);

      expect(status).toBe(409);
      expect(body).toMatchObject({ error: { code: 'license_mismatch' } });
      expect(h.ndi.load).not.toHaveBeenCalled();
    });

    it('refuses the hash of the NDI license text alone: the plugin terms are part of it', async () => {
      const { status, body } = await call('PUT', '/v1/license', {
        ...ACCEPT,
        licenseSha256: NDI_LICENSE_SHA256,
      });

      expect(status).toBe(409);
      expect(body).toMatchObject({ error: { code: 'license_mismatch' } });
    });

    it('refuses another sdkVersion', async () => {
      const { status } = await call('PUT', '/v1/license', { ...ACCEPT, sdkVersion: '6.0.0.0' });

      expect(status).toBe(409);
    });

    it('revokes: stops streams and returns to license_required', async () => {
      await accept();
      await call('PUT', `/v1/streams/${STREAM_ID}`, VALID_STREAM);

      const { status, body } = await call('DELETE', '/v1/license');

      expect(status).toBe(200);
      expect(body).toMatchObject({ state: 'license_required', acceptance: null });
      expect((await call('GET', '/v1/streams')).body).toEqual({ streams: [] });
    });

    it('reports state error when the NDI runtime fails to load', async () => {
      h.ndi.load.mockRejectedValueOnce(new Error('no libndi'));

      const { status, body } = await accept();

      expect(status).toBe(200);
      expect(body).toMatchObject({ state: 'error', errorCode: 'ndi_load_failed' });
    });
  });

  describe('streams', () => {
    it('refuses to start a stream before the license is accepted', async () => {
      const { status, body } = await call('PUT', `/v1/streams/${STREAM_ID}`, VALID_STREAM);

      expect(status).toBe(409);
      expect(body).toMatchObject({ error: { code: 'license_required' } });
      expect(h.ffmpeg.calls).toHaveLength(0);
    });

    it('starts a stream, reports it and writes into <hlsDir>/<streamId>', async () => {
      await accept();

      const put = await call('PUT', `/v1/streams/${STREAM_ID}`, VALID_STREAM);
      await settle();
      const list = await call('GET', '/v1/streams');

      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({ streamId: STREAM_ID, state: 'connecting' });
      expect(list.body).toMatchObject({
        streams: [
          { streamId: STREAM_ID, state: 'streaming', sourceName: 'CAM', encoder: 'libx264' },
        ],
      });
      expect((await stat(join(h.config.hlsDir, STREAM_ID))).isDirectory()).toBe(true);
      expect(h.ffmpeg.calls[0].args).toContain(join(h.config.hlsDir, STREAM_ID, 'index.m3u8'));
    });

    it('refuses a new stream beyond the cap with 409 stream_limit', async () => {
      await h.cleanup();
      h = await createHarness({ maxStreams: 1 });
      await accept();
      await call('PUT', `/v1/streams/${STREAM_ID}`, VALID_STREAM);

      const refused = await call(
        'PUT',
        '/v1/streams/7f1c2a52-7d3e-4c1a-9f0e-2b8d5a1c9e12',
        VALID_STREAM,
      );
      const replaced = await call('PUT', `/v1/streams/${STREAM_ID}`, { ...VALID_STREAM, fps: 25 });

      expect(refused).toMatchObject({ status: 409, body: { error: { code: 'stream_limit' } } });
      expect(replaced.status).toBe(200);
    });

    it('treats an upper-case stream id as the same stream', async () => {
      await accept();

      await call('PUT', `/v1/streams/${STREAM_ID.toUpperCase()}`, VALID_STREAM);
      await call('PUT', `/v1/streams/${STREAM_ID}`, VALID_STREAM);

      expect(
        ((await call('GET', '/v1/streams')).body as { streams: unknown[] }).streams,
      ).toHaveLength(1);
    });

    it('is idempotent for an unchanged config and replaces on a change', async () => {
      await accept();
      await call('PUT', `/v1/streams/${STREAM_ID}`, VALID_STREAM);
      await settle();
      await call('PUT', `/v1/streams/${STREAM_ID}`, VALID_STREAM);
      await settle();
      expect(h.ffmpeg.calls).toHaveLength(1);

      await call('PUT', `/v1/streams/${STREAM_ID}`, { ...VALID_STREAM, fps: 25 });
      await settle();

      expect(h.ffmpeg.calls).toHaveLength(2);
    });

    it('stops a stream on DELETE, also when called twice', async () => {
      await accept();
      await call('PUT', `/v1/streams/${STREAM_ID}`, VALID_STREAM);
      await settle();

      const first = await call('DELETE', `/v1/streams/${STREAM_ID}`);
      const second = await call('DELETE', `/v1/streams/${STREAM_ID}`);

      expect(first.status).toBe(204);
      expect(second.status).toBe(204);
      expect((await call('GET', '/v1/streams')).body).toEqual({ streams: [] });
      await expect(stat(join(h.config.hlsDir, STREAM_ID))).rejects.toThrow();
    });

    it('answers 400 for a stream id that is not a UUID', async () => {
      await accept();

      const put = await call('PUT', '/v1/streams/not-a-uuid', VALID_STREAM);
      const del = await call('DELETE', '/v1/streams/..%2Fetc');

      expect(put).toMatchObject({ status: 400, body: { error: { code: 'invalid_stream_id' } } });
      expect(del.status).toBe(400);
    });
  });

  describe('request validation matches the contract', () => {
    const invalidStreams: Array<[string, unknown]> = [
      ['unknown field', { ...VALID_STREAM, ptz: null }],
      ['missing field', { ...VALID_STREAM, fps: undefined }],
      ['hostname as camera host', { ...VALID_STREAM, cameraHost: 'camera.local' }],
      ['bad bandwidth', { ...VALID_STREAM, bandwidth: 'medium' }],
      ['fps as string', { ...VALID_STREAM, fps: '30' }],
      ['fps fraction', { ...VALID_STREAM, fps: 29.97 }],
      ['fps too high', { ...VALID_STREAM, fps: 500 }],
      ['empty source name', { ...VALID_STREAM, ndiSourceName: '' }],
      ['bad encoder preference', { ...VALID_STREAM, encoderPref: 'gpu' }],
      ['bitrate too low', { ...VALID_STREAM, bitrateKbps: 1 }],
    ];

    it.each(invalidStreams)('rejects a stream config with %s', async (_name, body) => {
      await accept();
      const streamPath = `/v1/streams/${STREAM_ID}`;
      const payload = JSON.parse(JSON.stringify(body)) as unknown;

      const reply = await call('PUT', streamPath, body);

      expect(reply.status).toBe(400);
      expect(reply.body).toMatchObject({ error: { code: 'invalid_request' } });
      // Names the schema as invalid only where the schema can express it (hostnames are a code check).
      if (_name !== 'hostname as camera host') {
        expect(requestBodyIsValid('PUT', streamPath, payload)).toBe(false);
      }
    });

    it('accepts the sample stream config in both code and schema', async () => {
      expect(requestBodyIsValid('PUT', `/v1/streams/${STREAM_ID}`, VALID_STREAM)).toBe(true);
      expect(requestBodyIsValid('PUT', '/v1/license', ACCEPT)).toBe(true);
    });

    it.each<[string, unknown]>([
      ['unknown field', { ...ACCEPT, extra: true }],
      ['missing hash', { sdkVersion: SDK_VERSION }],
      ['upper-case hash', { ...ACCEPT, licenseSha256: LICENSE_SHA256.toUpperCase() }],
      ['short hash', { ...ACCEPT, licenseSha256: 'abc' }],
      ['boolean instead of hash', { ...ACCEPT, licenseSha256: true }],
      ['bad version', { ...ACCEPT, sdkVersion: 'latest' }],
    ])('rejects a license body with %s', async (_name, body) => {
      const reply = await call('PUT', '/v1/license', body);

      expect(reply.status).toBe(400);
      expect(requestBodyIsValid('PUT', '/v1/license', body)).toBe(false);
    });

    it('rejects non-object bodies', async () => {
      for (const body of [[], 'text', 42, null]) {
        expect((await call('PUT', '/v1/license', body)).status).toBe(400);
      }
    });
  });

  describe('transport errors', () => {
    it('answers 400 for malformed JSON', async () => {
      const reply = await h.rawRequest('PUT', '/v1/license', '{nope', {
        'content-type': 'application/json',
      });

      expect(reply).toMatchObject({ status: 400, body: { error: { code: 'invalid_json' } } });
    });

    it('answers 415 for another content type', async () => {
      const reply = await call('PUT', '/v1/license', undefined, { 'content-type': 'text/plain' });

      expect(reply.status).toBe(415);
    });

    it('answers 413 for an oversized body', async () => {
      const big = JSON.stringify({ ...ACCEPT, pad: 'x'.repeat(MAX_BODY_BYTES) });

      const reply = await h.rawRequest('PUT', '/v1/license', big, {
        'content-type': 'application/json',
      });

      expect(reply).toMatchObject({ status: 413, body: { error: { code: 'payload_too_large' } } });
    });

    it('answers 413 for a chunked body that grows past the limit', async () => {
      const big = Buffer.from(JSON.stringify({ ...ACCEPT, pad: 'x'.repeat(MAX_BODY_BYTES) }));

      const reply = await h.rawRequest('PUT', '/v1/license', big, {
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
      });

      expect(reply.status).toBe(413);
    });

    it('answers 404 for an unknown route and 405 with Allow for a wrong method', async () => {
      const unknown = await call('GET', '/v2/status');
      const nested = await call('GET', `/v1/streams/${STREAM_ID}/extra`);
      const wrong = await call('POST', '/v1/status');

      expect(unknown).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
      expect(nested.status).toBe(404);
      expect(wrong.status).toBe(405);
      expect(wrong.headers.allow).toBe('GET');
      expect(wrong.body).toMatchObject({ error: { code: 'method_not_allowed' } });
    });

    it('ignores a query string', async () => {
      expect((await call('GET', '/v1/status?x=1')).status).toBe(200);
    });
  });

  it('documents exactly the routes the router serves', async () => {
    const { openApiDocument } = await import('../testing/openapi-contract.js');
    const served = ROUTES.flatMap((route) =>
      Object.keys(route.methods).map(
        (method) => `${method} ${route.path.replace(':streamId', '{streamId}')}`,
      ),
    );
    const documented = Object.entries(openApiDocument.paths).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((key) => ['get', 'put', 'delete', 'post', 'patch'].includes(key))
        .map((method) => `${method.toUpperCase()} ${path}`),
    );

    expect(documented.sort()).toEqual(served.sort());
  });
});
