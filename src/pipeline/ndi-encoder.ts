// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync } from 'node:fs';
import type { NdiEncoderPreferenceValue } from '../types.js';

export type EncoderName = 'libx264' | 'h264_v4l2m2m' | 'h264_vaapi';

export const VAAPI_DEVICE = '/dev/dri/renderD128';

const ENCODER_NAMES: readonly EncoderName[] = ['libx264', 'h264_v4l2m2m', 'h264_vaapi'];

/** What the host offers in `/dev`, injectable so selection is testable. */
export interface DeviceProbe {
  exists(path: string): boolean;
  /** True when at least one `/dev/video*` node exists. */
  hasVideoDevices(): boolean;
}

export const systemDeviceProbe: DeviceProbe = {
  exists: (path) => existsSync(path),
  hasVideoDevices: () => {
    try {
      return readdirSync('/dev').some((entry) => entry.startsWith('video'));
    } catch {
      return false;
    }
  },
};

function isEncoderName(value: string): value is EncoderName {
  return (ENCODER_NAMES as readonly string[]).includes(value);
}

/**
 * `h264_v4l2m2m` (Raspberry Pi) is not a supported production path: the plugin
 * is published for x86-64 general-purpose Linux only. The code stays for
 * internal development tests on arm64 and is reachable only when
 * `MNS_CAPTURE_DEV_ALLOW_ARM=1` lets the plugin run there at all.
 */
function hardwareEncoder(arch: string, probe: DeviceProbe): EncoderName | null {
  if (arch === 'arm64' && probe.hasVideoDevices()) {
    return 'h264_v4l2m2m';
  }
  if (arch === 'x64' && probe.exists(VAAPI_DEVICE)) {
    return 'h264_vaapi';
  }
  return null;
}

/**
 * Picks the H.264 encoder: the environment override wins, then the stream's
 * preference. `auto` and `hardware` take the hardware encoder of the platform
 * when its device exists and fall back to software, so a stream never fails
 * just because the box has no usable GPU.
 */
export function selectEncoder(
  preference: NdiEncoderPreferenceValue,
  arch: string,
  override: string | null,
  probe: DeviceProbe,
): EncoderName {
  if (override && isEncoderName(override)) {
    return override;
  }
  if (preference === 'software') {
    return 'libx264';
  }
  return hardwareEncoder(arch, probe) ?? 'libx264';
}

export interface EncoderArgs {
  /** Global options placed before `-i`. */
  inputArgs: string[];
  /** Appended to the scale/fps filter chain. */
  filters: string[];
  codecArgs: string[];
}

export function encoderArgs(encoder: EncoderName, bitrateKbps: number): EncoderArgs {
  const maxrate = `${bitrateKbps}k`;
  switch (encoder) {
    case 'libx264':
      return {
        inputArgs: [],
        filters: ['format=yuv420p'],
        codecArgs: [
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-tune',
          'zerolatency',
          '-crf',
          '23',
          '-maxrate',
          maxrate,
          '-bufsize',
          `${bitrateKbps * 2}k`,
        ],
      };
    case 'h264_v4l2m2m':
      return {
        inputArgs: [],
        filters: ['format=yuv420p'],
        codecArgs: ['-c:v', 'h264_v4l2m2m', '-b:v', maxrate],
      };
    case 'h264_vaapi':
      return {
        inputArgs: ['-vaapi_device', VAAPI_DEVICE],
        filters: ['format=nv12', 'hwupload'],
        codecArgs: ['-c:v', 'h264_vaapi', '-b:v', maxrate, '-maxrate', maxrate],
      };
  }
}

/** Encoders usable on this host, software first. Reported by `GET /v1/status`. */
export function availableEncoders(arch: string, probe: DeviceProbe): EncoderName[] {
  const hardware = hardwareEncoder(arch, probe);
  return hardware ? ['libx264', hardware] : ['libx264'];
}
