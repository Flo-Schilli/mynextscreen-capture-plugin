// SPDX-License-Identifier: Apache-2.0
// NDI test source ("fake camera") for developing the NDI live-stream path without hardware.
//
// Pipeline: FFmpeg lavfi testsrc2 + wall-clock overlay (HH:MM:SS.mmm) -> raw UYVY frames on
// stdout -> grandi sender. The overlay makes glass-to-glass latency measurable: compare the
// clock burned into the picture with the wall clock next to the screen.
//
// Env: NDI_NAME (default TEST-CAM), WIDTH/HEIGHT/FPS (default 1280x720@30).
import { spawn } from 'node:child_process';
import grandi from 'grandi';

const NDI_NAME = process.env.NDI_NAME ?? 'TEST-CAM';
const WIDTH = readPositiveInt('WIDTH', 1280);
const HEIGHT = readPositiveInt('HEIGHT', 720);
const FPS = readPositiveInt('FPS', 30);
const FRAME_BYTES = WIDTH * HEIGHT * 2; // UYVY 4:2:2 = 2 bytes per pixel
const FONT_FILE = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf';

function readPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`[sender] invalid ${name}=${raw}, expected a positive integer`);
    process.exit(2);
  }
  return value;
}

function log(message) {
  console.log(`[sender] ${new Date().toISOString()} ${message}`);
}

/**
 * Seconds since local midnight. Used as offset for drawtext `pts:hms`, so the overlay shows
 * local wall-clock time with milliseconds that stay consistent with the seconds (`-re` keeps
 * pts in lockstep with real time).
 */
function secondsSinceLocalMidnight(now = new Date()) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return (now.getTime() - midnight.getTime()) / 1000;
}

function buildFfmpegArgs() {
  const clockOffset = secondsSinceLocalMidnight().toFixed(3);
  const drawtext = [
    `drawtext=fontfile=${FONT_FILE}`,
    `text='%{pts\\:hms\\:${clockOffset}}'`,
    'fontsize=96',
    'fontcolor=white',
    'box=1',
    'boxcolor=black@0.7',
    'x=40',
    'y=40',
  ].join(':');
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-re',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}`,
    '-vf',
    drawtext,
    '-pix_fmt',
    'uyvy422',
    '-f',
    'rawvideo',
    'pipe:1',
  ];
}

async function main() {
  if (!grandi.isSupportedCPU()) {
    throw new Error('NDI is not supported on this CPU/platform');
  }
  grandi.initialize();
  const sender = await grandi.send({ name: NDI_NAME, clockVideo: true });
  log(`NDI sender "${NDI_NAME}" up (${grandi.version()}), ${WIDTH}x${HEIGHT}@${FPS}`);

  const ffmpeg = spawn('ffmpeg', buildFfmpegArgs(), { stdio: ['ignore', 'pipe', 'inherit'] });
  let shuttingDown = false;
  let framesSent = 0;

  const shutdown = (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down after ${framesSent} frames`);
    if (ffmpeg.exitCode === null) ffmpeg.kill('SIGTERM');
    sender.destroy();
    grandi.destroy();
    process.exit(code);
  };

  ffmpeg.on('error', (err) => {
    log(`ffmpeg failed to start: ${err.message}`);
    shutdown(1);
  });
  ffmpeg.on('exit', (code, signal) => {
    if (shuttingDown) return;
    log(`ffmpeg exited unexpectedly (code=${code}, signal=${signal})`);
    shutdown(1);
  });
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  // Reassemble fixed-size frames from the byte stream. Sending is serialized: with
  // clockVideo the SDK paces video() to the frame rate, so stdout is paused meanwhile and
  // pipe backpressure throttles FFmpeg instead of buffering frames in memory.
  let pending = Buffer.alloc(0);
  ffmpeg.stdout.on('data', async (chunk) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    if (pending.length < FRAME_BYTES) return;
    ffmpeg.stdout.pause();
    try {
      while (pending.length >= FRAME_BYTES && !shuttingDown) {
        const data = Buffer.from(pending.subarray(0, FRAME_BYTES));
        pending = pending.subarray(FRAME_BYTES);
        await sender.video({
          type: 'video',
          xres: WIDTH,
          yres: HEIGHT,
          frameRateN: FPS * 1000,
          frameRateD: 1000,
          pictureAspectRatio: WIDTH / HEIGHT,
          frameFormatType: grandi.FrameType.Progressive,
          fourCC: grandi.FourCC.UYVY,
          lineStrideBytes: WIDTH * 2,
          data,
          timecode: grandi.TIMECODE_SYNTHESIZE,
        });
        framesSent += 1;
        if (framesSent % (FPS * 10) === 0) {
          log(`${framesSent} frames sent, ${sender.connections()} receiver(s) connected`);
        }
      }
    } catch (err) {
      log(`sending frame failed: ${err instanceof Error ? err.message : String(err)}`);
      shutdown(1);
      return;
    }
    ffmpeg.stdout.resume();
  });
}

main().catch((err) => {
  console.error(`[sender] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
