// SPDX-License-Identifier: Apache-2.0
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses the documented defaults', () => {
    const config = loadConfig({});

    expect(config).toMatchObject({
      socketPath: '/run/mns-capture/plugin.sock',
      hlsDir: '/var/lib/mns-capture/hls',
      stateDir: '/var/lib/mns-capture/state',
      acceptNdiLicense: null,
      devAllowArm: false,
      ffmpegPath: 'ffmpeg',
      encoderOverride: null,
      maxStreams: 8,
    });
    expect(config.pluginVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('reads the environment', () => {
    const config = loadConfig({
      MNS_CAPTURE_SOCKET: '/tmp/s.sock',
      MNS_CAPTURE_HLS_DIR: '/tmp/hls',
      MNS_CAPTURE_STATE_DIR: '/tmp/state',
      MNS_CAPTURE_ACCEPT_NDI_LICENSE: ` ${'AB'.repeat(32)} `,
      MNS_CAPTURE_DEV_ALLOW_ARM: '1',
      MNS_CAPTURE_FFMPEG_PATH: '/opt/ffmpeg',
      MNS_CAPTURE_ENCODER: 'libx264',
      MNS_CAPTURE_RUNTIME_DIR: '/rt',
      MNS_CAPTURE_NOTICE_FILE: '/n',
      MNS_CAPTURE_MAX_STREAMS: '3',
      APP_VERSION: '1.2.3+sha.abc',
    });

    expect(config).toEqual({
      socketPath: '/tmp/s.sock',
      hlsDir: '/tmp/hls',
      stateDir: '/tmp/state',
      acceptNdiLicense: 'ab'.repeat(32),
      devAllowArm: true,
      ffmpegPath: '/opt/ffmpeg',
      encoderOverride: 'libx264',
      runtimeDir: '/rt',
      noticePath: '/n',
      maxStreams: 3,
      pluginVersion: '1.2.3+sha.abc',
    });
  });

  it.each(['0', '-1', 'many', '2.5', ''])('falls back to 8 streams for %p', (value) => {
    expect(loadConfig({ MNS_CAPTURE_MAX_STREAMS: value }).maxStreams).toBe(8);
  });

  it('treats blank values as unset and only "1" as the dev flag', () => {
    const config = loadConfig({
      MNS_CAPTURE_SOCKET: '  ',
      MNS_CAPTURE_ACCEPT_NDI_LICENSE: '',
      MNS_CAPTURE_DEV_ALLOW_ARM: 'true',
    });

    expect(config.socketPath).toBe('/run/mns-capture/plugin.sock');
    expect(config.acceptNdiLicense).toBeNull();
    expect(config.devAllowArm).toBe(false);
  });
});
