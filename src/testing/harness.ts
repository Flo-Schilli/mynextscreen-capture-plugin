// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../app.js';
import type { Config } from '../config.js';
import { acceptanceHash, sha256Hex } from '../license/runtime-info.js';
import { fakeSpawner, type FakeSpawn } from '../pipeline/testing/fake-ffmpeg.js';
import { fakeNdi, type FakeNdi } from './fake-ndi.js';

export const LICENSE_TEXT = 'NDI SDK License Agreement (test copy)\n';
export const NOTICE_TEXT = 'Plugin terms (test copy)\n';
export const NDI_LICENSE_SHA256 = sha256Hex(LICENSE_TEXT);
export const TERMS_SHA256 = sha256Hex(NOTICE_TEXT);
/** What an acceptance must quote: covers the NDI license text and the plugin terms. */
export const LICENSE_SHA256 = acceptanceHash(NDI_LICENSE_SHA256, TERMS_SHA256);
export const SDK_VERSION = '6.3.2.0';
export const STREAM_ID = '6f1c2a52-7d3e-4c1a-9f0e-2b8d5a1c9e11';

export const VALID_STREAM = {
  cameraHost: '127.0.0.1',
  ndiSourceName: null,
  bandwidth: 'highest',
  width: 1280,
  height: 720,
  fps: 30,
  bitrateKbps: 3000,
  encoderPref: 'software',
} as const;

export interface HarnessOptions {
  arch?: string;
  devAllowArm?: boolean;
  acceptNdiLicense?: string | null;
  withRuntime?: boolean;
  withNotice?: boolean;
  /** Content of `libndi.so.6` in the fake runtime directory; checked against the pin when set. */
  libndi?: string;
  maxStreams?: number;
  /** Text of the plugin terms; defaults to NOTICE_TEXT. */
  notice?: string;
}

export interface Reply {
  status: number;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

export interface Harness {
  app: App;
  config: Config;
  dir: string;
  ndi: FakeNdi;
  ffmpeg: FakeSpawn;
  request(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Reply>;
  rawRequest(
    method: string,
    path: string,
    payload: string | Buffer,
    headers: Record<string, string>,
  ): Promise<Reply>;
  cleanup(): Promise<void>;
}

/** The real app on a temp socket with a fake NDI binding and a fake FFmpeg. */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'mns-cp-'));
  const runtimeDir = join(dir, 'runtime');
  await mkdir(runtimeDir);
  if (options.withRuntime !== false) {
    await writeFile(join(runtimeDir, 'LICENSE'), LICENSE_TEXT);
  }
  if (options.libndi !== undefined) {
    await writeFile(join(runtimeDir, 'libndi.so.6'), options.libndi);
  }
  const noticePath = join(dir, 'NOTICE');
  if (options.withNotice !== false) {
    await writeFile(noticePath, options.notice ?? NOTICE_TEXT);
  }
  const config: Config = {
    socketPath: join(dir, 'run', 'plugin.sock'),
    hlsDir: join(dir, 'hls'),
    stateDir: join(dir, 'state'),
    acceptNdiLicense: options.acceptNdiLicense ?? null,
    devAllowArm: options.devAllowArm ?? false,
    ffmpegPath: 'ffmpeg',
    encoderOverride: null,
    runtimeDir: null,
    noticePath,
    maxStreams: options.maxStreams ?? 8,
    pluginVersion: '0.0.0-test',
  };
  const ndi = fakeNdi();
  const ffmpeg = fakeSpawner();
  const app = await createApp(config, {
    binding: ndi,
    spawner: ffmpeg.spawner,
    probe: { exists: () => false, hasVideoDevices: () => false },
    arch: options.arch ?? 'x64',
    platform: 'linux',
    runtimeDir,
    verifyRuntime: options.libndi !== undefined,
  });
  await app.start();

  const rawRequest: Harness['rawRequest'] = (method, path, payload, headers) =>
    new Promise((resolve, reject) => {
      const req = request({ socketPath: config.socketPath, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            body: text ? (JSON.parse(text) as unknown) : undefined,
            headers: res.headers,
          });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });

  return {
    app,
    config,
    dir,
    ndi,
    ffmpeg,
    rawRequest,
    request: (method, path, body, headers = {}) =>
      body === undefined
        ? rawRequest(method, path, '', headers)
        : rawRequest(method, path, JSON.stringify(body), {
            'content-type': 'application/json',
            ...headers,
          }),
    cleanup: async () => {
      await app.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
