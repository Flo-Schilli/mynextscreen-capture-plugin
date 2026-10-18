// SPDX-License-Identifier: Apache-2.0
import { jest } from '@jest/globals';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from './app.js';
import {
  createHarness,
  LICENSE_SHA256,
  NDI_LICENSE_SHA256,
  SDK_VERSION,
  STREAM_ID,
  VALID_STREAM,
  type Harness,
} from './testing/harness.js';
import { assertResponseMatches } from './testing/openapi-contract.js';

/** A second app on the files of the first one: a restart with changed files. */
async function createAppOnSameDirs(h: Harness) {
  const app = await createApp(h.config, {
    binding: h.ndi,
    arch: 'x64',
    platform: 'linux',
    runtimeDir: join(h.dir, 'runtime'),
  });
  await app.start();
  return { app, status: app.service.status() };
}

describe('app', () => {
  let h: Harness | null = null;

  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  async function statusOf(harness: Harness): Promise<Record<string, unknown>> {
    const reply = await harness.request('GET', '/v1/status');
    assertResponseMatches('GET', '/v1/status', reply.status, reply.body);
    return reply.body as Record<string, unknown>;
  }

  it('loads the NDI runtime at start when the environment holds the license hash', async () => {
    h = await createHarness({ acceptNdiLicense: LICENSE_SHA256 });

    expect(await statusOf(h)).toMatchObject({ state: 'ready', acceptance: { via: 'env' } });
    expect(h.ndi.load).toHaveBeenCalledTimes(1);
  });

  it('ignores a license hash in the environment that does not match', async () => {
    h = await createHarness({ acceptNdiLicense: 'f'.repeat(64) });

    expect(await statusOf(h)).toMatchObject({ state: 'license_required' });
    expect(h.ndi.load).not.toHaveBeenCalled();
  });

  it('persists an API acceptance in the state directory', async () => {
    h = await createHarness();

    await h.request('PUT', '/v1/license', {
      sdkVersion: SDK_VERSION,
      licenseSha256: LICENSE_SHA256,
    });

    expect(await readdir(h.config.stateDir)).toEqual(['license-acceptance.json']);
  });

  it('clears leftovers in the HLS directory at start', async () => {
    h = await createHarness();
    await mkdir(join(h.config.hlsDir, 'stale'), { recursive: true });
    await writeFile(join(h.config.hlsDir, 'stale', 'seg.ts'), 'x');

    await h.app.stop();
    await h.app.start();

    expect(await readdir(h.config.hlsDir)).toEqual([]);
  });

  it('is incompatible on arm64 without the dev override, and refuses streams', async () => {
    h = await createHarness({ arch: 'arm64', acceptNdiLicense: LICENSE_SHA256 });

    expect(await statusOf(h)).toMatchObject({
      state: 'incompatible',
      errorCode: 'unsupported_platform',
    });
    const reply = await h.request('PUT', `/v1/streams/${STREAM_ID}`, VALID_STREAM);
    assertResponseMatches('PUT', `/v1/streams/${STREAM_ID}`, reply.status, reply.body);
    expect(reply).toMatchObject({ status: 409, body: { error: { code: 'incompatible' } } });
    expect(h.ndi.load).not.toHaveBeenCalled();
  });

  it('runs on arm64 with MNS_CAPTURE_DEV_ALLOW_ARM', async () => {
    h = await createHarness({ arch: 'arm64', devAllowArm: true, acceptNdiLicense: LICENSE_SHA256 });

    expect(await statusOf(h)).toMatchObject({ state: 'ready', arch: 'arm64' });
  });

  it('reports runtime_missing when the license text is not in the image', async () => {
    h = await createHarness({ withRuntime: false });

    expect(await statusOf(h)).toMatchObject({
      state: 'error',
      errorCode: 'runtime_missing',
      sdkVersion: null,
      license: null,
    });
    const text = await h.request('GET', '/v1/license/text');
    assertResponseMatches('GET', '/v1/license/text', text.status, text.body);
    expect(text.status).toBe(409);
  });

  it('reports runtime_missing when the plugin terms are missing: they are part of the acceptance', async () => {
    h = await createHarness({ withNotice: false });

    expect(await statusOf(h)).toMatchObject({ state: 'error', errorCode: 'runtime_missing' });
    expect((await h.request('GET', '/v1/license/text')).status).toBe(409);
  });

  it('returns to license_required after the plugin terms changed', async () => {
    h = await createHarness();
    await h.request('PUT', '/v1/license', {
      sdkVersion: SDK_VERSION,
      licenseSha256: LICENSE_SHA256,
    });
    await h.app.stop();
    await writeFile(h.config.noticePath as string, 'Changed plugin terms\n');

    const again = await createAppOnSameDirs(h);

    expect(again.status.state).toBe('license_required');
    expect(again.status.license?.licenseSha256).not.toBe(LICENSE_SHA256);
    expect(again.status.license?.ndiLicenseSha256).toBe(NDI_LICENSE_SHA256);
    await again.app.stop();
  });

  it('reports runtime_mismatch and runs no pipelines when libndi.so.6 is not the pinned build', async () => {
    h = await createHarness({ libndi: 'not the pinned library', acceptNdiLicense: LICENSE_SHA256 });

    expect(await statusOf(h)).toMatchObject({ state: 'error', errorCode: 'runtime_mismatch' });
    expect(h.ndi.load).not.toHaveBeenCalled();
    const put = await h.request('PUT', `/v1/streams/${STREAM_ID}`, VALID_STREAM);
    expect(put).toMatchObject({ status: 409, body: { error: { code: 'plugin_error' } } });
    const accept = await h.request('PUT', '/v1/license', {
      sdkVersion: SDK_VERSION,
      licenseSha256: LICENSE_SHA256,
    });
    expect(accept.status).toBe(409);
  });

  it('ignores MNS_CAPTURE_RUNTIME_DIR without the dev flag', async () => {
    h = await createHarness();
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const app = await createApp(
      {
        ...h.config,
        socketPath: join(h.dir, 'other.sock'),
        runtimeDir: h.dir,
        hlsDir: join(h.dir, 'h2'),
        stateDir: join(h.dir, 's2'),
      },
      { binding: h.ndi, arch: 'x64', platform: 'linux', logger },
    );

    expect(app.service.status().license?.ndiLicenseSha256).not.toBe(NDI_LICENSE_SHA256);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ignored'));
  });

  it('honors MNS_CAPTURE_RUNTIME_DIR together with the dev flag, unverified', async () => {
    h = await createHarness();
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const app = await createApp(
      {
        ...h.config,
        socketPath: join(h.dir, 'other.sock'),
        runtimeDir: join(h.dir, 'runtime'),
        devAllowArm: true,
        hlsDir: join(h.dir, 'h2'),
        stateDir: join(h.dir, 's2'),
      },
      { binding: h.ndi, arch: 'x64', platform: 'linux', logger },
    );

    expect(app.service.status().license?.ndiLicenseSha256).toBe(NDI_LICENSE_SHA256);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('development override'));
  });
});
