// SPDX-License-Identifier: Apache-2.0
// Unit tests for the pure helpers of spike.mjs. Run: node --test tools/ndi-spike/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BoundedQueue,
  buildFfmpegArgs,
  countSegments,
  packFrame,
  parseProgressLine,
  readProcCpuTicks,
  resolvePreset,
  selectEncoder,
} from './spike.mjs';

const BASE = { width: 1280, height: 720, srcFps: 30, outDir: '/tmp/hls' };

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

test('720p30 with libx264 produces Short-HLS args with 1 s GOP', () => {
  const args = buildFfmpegArgs({ ...BASE, encoder: 'libx264', preset: '720p30' });
  assert.equal(argValue(args, '-f'), 'rawvideo');
  assert.equal(argValue(args, '-pix_fmt'), 'uyvy422');
  assert.equal(argValue(args, '-s'), '1280x720');
  assert.equal(argValue(args, '-r'), '30');
  assert.equal(argValue(args, '-i'), 'pipe:0');
  assert.ok(args.includes('-an'));
  assert.equal(argValue(args, '-vf'), 'scale=1280:720,fps=30,format=yuv420p');
  assert.equal(argValue(args, '-c:v'), 'libx264');
  assert.equal(argValue(args, '-preset'), 'veryfast');
  assert.equal(argValue(args, '-tune'), 'zerolatency');
  assert.equal(argValue(args, '-g'), '30');
  assert.equal(argValue(args, '-keyint_min'), '30');
  assert.equal(argValue(args, '-sc_threshold'), '0');
  assert.equal(argValue(args, '-hls_time'), '1');
  assert.equal(argValue(args, '-hls_list_size'), '4');
  assert.equal(argValue(args, '-hls_flags'), 'delete_segments+independent_segments');
  assert.equal(args.at(-1), '/tmp/hls/index.m3u8');
});

test('libx264 720p30 argv is exactly the expected command line', () => {
  const args = buildFfmpegArgs({ ...BASE, encoder: 'libx264', preset: '720p30' });
  assert.deepEqual(args, [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostats',
    '-progress',
    'pipe:2',
    '-stats_period',
    '1',
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
    'scale=1280:720,fps=30,format=yuv420p',
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
    '/tmp/hls/seg_%05d.ts',
    '/tmp/hls/index.m3u8',
  ]);
});

test('1080p30 scales to 1920x1080 and uses source geometry for input', () => {
  const args = buildFfmpegArgs({ ...BASE, srcFps: 59.94, encoder: 'libx264', preset: '1080p30' });
  assert.equal(argValue(args, '-r'), '59.94');
  assert.equal(argValue(args, '-vf'), 'scale=1920:1080,fps=30,format=yuv420p');
});

test('preview keeps the source size (no scale filter)', () => {
  const args = buildFfmpegArgs({
    ...BASE,
    width: 640,
    height: 360,
    encoder: 'libx264',
    preset: 'preview',
  });
  assert.equal(argValue(args, '-s'), '640x360');
  assert.equal(argValue(args, '-vf'), 'fps=30,format=yuv420p');
});

test('h264_vaapi adds device before input and hwupload to the filter chain', () => {
  const args = buildFfmpegArgs({
    ...BASE,
    encoder: 'h264_vaapi',
    preset: '720p30',
    vaapiDevice: '/dev/dri/renderD129',
  });
  assert.ok(args.indexOf('-vaapi_device') < args.indexOf('-i'));
  assert.equal(argValue(args, '-vaapi_device'), '/dev/dri/renderD129');
  assert.equal(argValue(args, '-vf'), 'scale=1280:720,fps=30,format=nv12,hwupload');
  assert.equal(argValue(args, '-c:v'), 'h264_vaapi');
});

test('h264_v4l2m2m uses yuv420p and a bitrate target', () => {
  const enc = selectEncoder('h264_v4l2m2m', { bitrateK: 3000 });
  assert.deepEqual(enc.inputArgs, []);
  assert.deepEqual(enc.filters, ['format=yuv420p']);
  assert.deepEqual(enc.codecArgs, ['-c:v', 'h264_v4l2m2m', '-b:v', '3000k']);
});

test('unknown encoder and preset are rejected', () => {
  assert.throws(() => selectEncoder('h265_magic', { bitrateK: 1 }), /unknown ENCODER/);
  assert.throws(() => resolvePreset('4k60'), /unknown PRESET/);
});

test('BoundedQueue drops the oldest item when full', () => {
  const q = new BoundedQueue(3);
  [1, 2, 3, 4, 5].forEach((n) => q.push(n));
  assert.equal(q.length, 3);
  assert.equal(q.dropped, 2);
  assert.deepEqual([q.shift(), q.shift(), q.shift()], [3, 4, 5]);
  assert.equal(q.shift(), undefined);
});

test('packFrame returns the original buffer when there is no stride padding', () => {
  const data = Buffer.alloc(2 * 2 * 2);
  assert.equal(packFrame({ data, xres: 2, yres: 2, lineStrideBytes: 4 }), data);
});

test('packFrame strips stride padding row by row', () => {
  // 2x2 UYVY = 4 bytes/row, stride 6 -> 2 padding bytes (0xff) per row
  const data = Buffer.from([1, 2, 3, 4, 0xff, 0xff, 5, 6, 7, 8, 0xff, 0xff]);
  const packed = packFrame({ data, xres: 2, yres: 2, lineStrideBytes: 6 });
  assert.deepEqual([...packed], [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('parseProgressLine extracts key/value pairs and ignores log lines', () => {
  assert.deepEqual(parseProgressLine('speed=1.01x'), { key: 'speed', value: '1.01x' });
  assert.deepEqual(parseProgressLine('fps=30.00\r'), { key: 'fps', value: '30.00' });
  assert.deepEqual(parseProgressLine('stream_0_0_q=23.0'), { key: 'stream_0_0_q', value: '23.0' });
  assert.equal(parseProgressLine('[hls @ 0x55] Opening seg_00001.ts for writing'), null);
});

test('countSegments adds media sequence and listed segments', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-MEDIA-SEQUENCE:17',
    '#EXTINF:1.000000,',
    'seg_00017.ts',
    '#EXTINF:1.000000,',
    'seg_00018.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');
  assert.equal(countSegments(playlist), 19);
  assert.equal(countSegments('#EXTM3U\n'), 0);
});

test('readProcCpuTicks sums utime and stime and tolerates spaces in comm', () => {
  const stat = '42 (ff mpeg) S 1 42 42 0 -1 4194304 100 0 0 0 250 50 0 0 20 0 1 0';
  assert.equal(
    readProcCpuTicks(42, () => stat),
    300,
  );
  assert.equal(
    readProcCpuTicks(42, () => {
      throw new Error('ENOENT');
    }),
    null,
  );
});
