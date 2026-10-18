// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { encoderArgs, type EncoderName } from './ndi-encoder.js';

const RUN_ID_PATTERN = /^[a-z0-9]{6,8}$/;

export interface FfmpegArgsInput {
  /** Geometry and rate of the incoming NDI frames. */
  sourceWidth: number;
  sourceHeight: number;
  sourceFps: number;
  /** Targets from the stream config; the source caps them, never the other way round. */
  targetHeight: number;
  targetFps: number;
  bitrateKbps: number;
  encoder: EncoderName;
  outDir: string;
  /**
   * Short id of this FFmpeg run, put into every segment name. A restart then
   * never overwrites a segment that the server's previous playlist still
   * lists. Must match `[a-z0-9]+`.
   */
  runId: string;
}

/** Output height: the configured one, never above the source and always even. */
export function targetHeightFor(configHeight: number, sourceHeight: number): number {
  const capped = Math.min(configHeight, sourceHeight);
  return Math.max(2, capped - (capped % 2));
}

/** Output frame rate: the configured one, never above the source. */
export function targetFpsFor(configFps: number, sourceFps: number): number {
  return Math.max(1, Math.min(configFps, Math.round(sourceFps)));
}

/**
 * Full FFmpeg argument list: raw UYVY on stdin to Short-HLS (1 s segments, 4 in
 * the playlist, a keyframe every second). The list is fixed apart from numbers
 * and the output directory, and nothing from the camera (source names, hosts)
 * ever lands in it. The input is limited to `pipe`/`file`, so FFmpeg opens no
 * network protocol.
 */
export function buildFfmpegArgs(input: FfmpegArgsInput): string[] {
  if (!RUN_ID_PATTERN.test(input.runId)) {
    throw new Error('Invalid run id');
  }
  const enc = encoderArgs(input.encoder, input.bitrateKbps);
  const fps = input.targetFps;
  const filters = [`scale=-2:${input.targetHeight}`, `fps=${fps}`, ...enc.filters];
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostats',
    ...enc.inputArgs,
    '-protocol_whitelist',
    'pipe,file',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'uyvy422',
    '-s',
    `${input.sourceWidth}x${input.sourceHeight}`,
    '-r',
    String(Number(input.sourceFps.toFixed(3))),
    '-i',
    'pipe:0',
    '-an',
    '-vf',
    filters.join(','),
    ...enc.codecArgs,
    '-g',
    String(fps),
    '-keyint_min',
    String(fps),
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
    join(input.outDir, `seg_${input.runId}_%05d.ts`),
    join(input.outDir, 'index.m3u8'),
  ];
}
