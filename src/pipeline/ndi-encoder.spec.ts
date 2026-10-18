// SPDX-License-Identifier: Apache-2.0
import {
  availableEncoders,
  encoderArgs,
  selectEncoder,
  VAAPI_DEVICE,
  type DeviceProbe,
} from './ndi-encoder.js';

function probe(devices: { video?: boolean; render?: boolean }): DeviceProbe {
  return {
    exists: (path) => path === VAAPI_DEVICE && devices.render === true,
    hasVideoDevices: () => devices.video === true,
  };
}

describe('selectEncoder', () => {
  const none = probe({});
  const pi = probe({ video: true });
  const gpu = probe({ render: true });

  it.each([
    ['auto', 'arm64', null, pi, 'h264_v4l2m2m'],
    ['auto', 'x64', null, gpu, 'h264_vaapi'],
    ['auto', 'arm64', null, none, 'libx264'],
    ['auto', 'x64', null, none, 'libx264'],
    ['auto', 'x64', null, pi, 'libx264'],
    ['auto', 'arm64', null, gpu, 'libx264'],
    ['auto', 'riscv64', null, gpu, 'libx264'],
    ['hardware', 'arm64', null, pi, 'h264_v4l2m2m'],
    ['hardware', 'x64', null, gpu, 'h264_vaapi'],
    ['hardware', 'x64', null, none, 'libx264'],
    ['software', 'arm64', null, pi, 'libx264'],
    ['software', 'x64', null, gpu, 'libx264'],
    ['software', 'x64', 'h264_vaapi', none, 'h264_vaapi'],
    ['auto', 'x64', 'libx264', gpu, 'libx264'],
    ['auto', 'arm64', 'h264_vaapi', pi, 'h264_vaapi'],
    ['auto', 'x64', 'nonsense', gpu, 'h264_vaapi'],
    ['software', 'x64', 'nonsense', gpu, 'libx264'],
  ] as const)('%s on %s with override %s picks %s', (pref, arch, override, devices, expected) => {
    expect(selectEncoder(pref, arch, override, devices)).toBe(expected);
  });
});

describe('encoderArgs', () => {
  it('caps libx264 at the configured bitrate', () => {
    expect(encoderArgs('libx264', 3000).codecArgs).toEqual(
      expect.arrayContaining([
        '-preset',
        'veryfast',
        '-tune',
        'zerolatency',
        '-maxrate',
        '3000k',
        '-bufsize',
        '6000k',
      ]),
    );
  });

  it('uses the bitrate for the v4l2 encoder', () => {
    expect(encoderArgs('h264_v4l2m2m', 800)).toEqual({
      inputArgs: [],
      filters: ['format=yuv420p'],
      codecArgs: ['-c:v', 'h264_v4l2m2m', '-b:v', '800k'],
    });
  });

  it('uploads frames to the GPU for vaapi', () => {
    expect(encoderArgs('h264_vaapi', 6000)).toEqual({
      inputArgs: ['-vaapi_device', VAAPI_DEVICE],
      filters: ['format=nv12', 'hwupload'],
      codecArgs: ['-c:v', 'h264_vaapi', '-b:v', '6000k', '-maxrate', '6000k'],
    });
  });
});

describe('availableEncoders', () => {
  it('lists software first and the platform hardware encoder when its device exists', () => {
    expect(availableEncoders('x64', probe({ render: true }))).toEqual(['libx264', 'h264_vaapi']);
    expect(availableEncoders('x64', probe({}))).toEqual(['libx264']);
    expect(availableEncoders('arm64', probe({ video: true }))).toEqual(['libx264', 'h264_v4l2m2m']);
  });
});
