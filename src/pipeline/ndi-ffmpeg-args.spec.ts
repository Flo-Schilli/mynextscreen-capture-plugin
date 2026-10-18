// SPDX-License-Identifier: Apache-2.0
import { buildFfmpegArgs, targetFpsFor, targetHeightFor } from './ndi-ffmpeg-args.js';

describe('buildFfmpegArgs', () => {
  it('produces exactly the expected libx264 command line', () => {
    const args = buildFfmpegArgs({
      sourceWidth: 1280,
      sourceHeight: 720,
      sourceFps: 30,
      targetHeight: 720,
      targetFps: 30,
      bitrateKbps: 3000,
      encoder: 'libx264',
      outDir: '/tmp/mns-ndi/stream',
      runId: 'a1b2c3d4',
    });

    expect(args).toEqual([
      '-hide_banner',
      '-loglevel',
      'warning',
      '-nostats',
      '-protocol_whitelist',
      'pipe,file',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'uyvy422',
      '-s',
      '1280x720',
      '-r',
      '30',
      '-i',
      'pipe:0',
      '-an',
      '-vf',
      'scale=-2:720,fps=30,format=yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-tune',
      'zerolatency',
      '-crf',
      '23',
      '-maxrate',
      '3000k',
      '-bufsize',
      '6000k',
      '-g',
      '30',
      '-keyint_min',
      '30',
      '-sc_threshold',
      '0',
      '-f',
      'hls',
      '-hls_time',
      '1',
      '-hls_list_size',
      '4',
      '-hls_flags',
      'delete_segments+independent_segments',
      '-hls_segment_filename',
      '/tmp/mns-ndi/stream/seg_a1b2c3d4_%05d.ts',
      '/tmp/mns-ndi/stream/index.m3u8',
    ]);
  });

  it('puts the vaapi device before the input and uploads in the filter chain', () => {
    const args = buildFfmpegArgs({
      sourceWidth: 1920,
      sourceHeight: 1080,
      sourceFps: 29.97003,
      targetHeight: 1080,
      targetFps: 30,
      bitrateKbps: 6000,
      encoder: 'h264_vaapi',
      outDir: '/d',
      runId: 'a1b2c3d4',
    });

    expect(args.indexOf('-vaapi_device')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=-2:1080,fps=30,format=nv12,hwupload');
    expect(args[args.indexOf('-r') + 1]).toBe('29.97');
  });
});

describe('buildFfmpegArgs run id', () => {
  const input = {
    sourceWidth: 1280,
    sourceHeight: 720,
    sourceFps: 30,
    targetHeight: 720,
    targetFps: 30,
    bitrateKbps: 3000,
    encoder: 'libx264' as const,
    outDir: '/d',
  };

  it('names segments after the run, so two runs never share a name', () => {
    const name = (runId: string): string => {
      const args = buildFfmpegArgs({ ...input, runId });
      return args[args.indexOf('-hls_segment_filename') + 1];
    };

    expect(name('aaaaaaaa')).toBe('/d/seg_aaaaaaaa_%05d.ts');
    expect(name('bbbbbb')).not.toBe(name('aaaaaaaa'));
  });

  it.each(['', 'abc', 'ABCDEFGH', 'abc/def1', 'abcdefghi', '../../x1'])(
    'rejects run id %p',
    (runId) => {
      expect(() => buildFfmpegArgs({ ...input, runId })).toThrow('Invalid run id');
    },
  );
});

describe('targetHeightFor', () => {
  it.each([
    [720, 1080, 720],
    [1080, 720, 720],
    [720, 720, 720],
    [360, 1080, 360],
    [1080, 481, 480],
    [1, 1, 2],
  ])('config %i with source %i gives %i', (config, source, expected) => {
    expect(targetHeightFor(config, source)).toBe(expected);
  });
});

describe('targetFpsFor', () => {
  it.each([
    [30, 60, 30],
    [30, 25, 25],
    [30, 29.97, 30],
    [30, 0.2, 1],
  ])('config %i with source %f gives %i', (config, source, expected) => {
    expect(targetFpsFor(config, source)).toBe(expected);
  });
});
