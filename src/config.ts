// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT } from './paths.js';

export interface Config {
  socketPath: string;
  hlsDir: string;
  stateDir: string;
  /** SHA-256 of the license text the operator accepted on the device, or null. */
  acceptNdiLicense: string | null;
  devAllowArm: boolean;
  ffmpegPath: string;
  /** Forces one encoder (`libx264`, `h264_vaapi`, ...); null lets the stream preference decide. */
  encoderOverride: string | null;
  /**
   * Directory of the NDI runtime package. Honored only together with
   * `devAllowArm`; otherwise `@grandi/linux-<arch>` is used.
   */
  runtimeDir: string | null;
  /** Location of the plugin terms (NOTICE); null uses the image location. */
  noticePath: string | null;
  /** Most streams running at once; a new id beyond it is refused with 409. */
  maxStreams: number;
  pluginVersion: string;
}

export const DEFAULT_SOCKET_PATH = '/run/mns-capture/plugin.sock';
export const DEFAULT_HLS_DIR = '/var/lib/mns-capture/hls';
export const DEFAULT_STATE_DIR = '/var/lib/mns-capture/state';
export const DEFAULT_MAX_STREAMS = 8;

type Env = Readonly<Record<string, string | undefined>>;

const optional = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    version: string;
  };
  return manifest.version;
}

export function loadConfig(env: Env = process.env): Config {
  return {
    socketPath: optional(env.MNS_CAPTURE_SOCKET) ?? DEFAULT_SOCKET_PATH,
    hlsDir: optional(env.MNS_CAPTURE_HLS_DIR) ?? DEFAULT_HLS_DIR,
    stateDir: optional(env.MNS_CAPTURE_STATE_DIR) ?? DEFAULT_STATE_DIR,
    acceptNdiLicense: optional(env.MNS_CAPTURE_ACCEPT_NDI_LICENSE)?.toLowerCase() ?? null,
    devAllowArm: env.MNS_CAPTURE_DEV_ALLOW_ARM === '1',
    ffmpegPath: optional(env.MNS_CAPTURE_FFMPEG_PATH) ?? 'ffmpeg',
    encoderOverride: optional(env.MNS_CAPTURE_ENCODER),
    runtimeDir: optional(env.MNS_CAPTURE_RUNTIME_DIR),
    noticePath: optional(env.MNS_CAPTURE_NOTICE_FILE),
    maxStreams: positiveInt(env.MNS_CAPTURE_MAX_STREAMS, DEFAULT_MAX_STREAMS),
    pluginVersion: optional(env.APP_VERSION) ?? packageVersion(),
  };
}
