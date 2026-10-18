// SPDX-License-Identifier: Apache-2.0
// NDI receive -> FFmpeg -> Short-HLS spike: a standalone feasibility and benchmark script for the
// capture pipeline (development tool, not part of the image).
//
// Finds an NDI source, receives UYVY frames, feeds them through a bounded queue into FFmpeg
// (stdin, rawvideo) and writes 1-second HLS segments locally. Prints periodic stats and a
// summary JSON with throughput, drops and CPU load per preset/encoder.
//
// Env:
//   NDI_SOURCE  substring of the NDI source name (default TEST-CAM)
//   PRESET      preview | 720p30 (default) | 1080p30
//   ENCODER     libx264 (default) | h264_v4l2m2m | h264_vaapi
//   DURATION_S  run time in seconds (default 20)
//   OUT_DIR     HLS output directory (default ./hls-out)
//   VAAPI_DEVICE render node for h264_vaapi (default /dev/dri/renderD128)
//
// A resolution change mid-stream aborts the run (exit code 3): restarting FFmpeg would reset
// the HLS sequence and mix segment sizes, which a feasibility spike should surface, not hide.
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const QUEUE_DEPTH = 3;
const FIND_TIMEOUT_MS = 15_000;
const FRAME_TIMEOUT_MS = 1_000;
const STATS_INTERVAL_MS = 2_000;
const FFMPEG_EXIT_TIMEOUT_MS = 5_000;
const QUEUE_FLUSH_TIMEOUT_MS = 2_000;
const BYTES_PER_PIXEL_UYVY = 2;

/** Preset name -> NDI bandwidth key and output geometry (null = keep source size). */
export const PRESETS = Object.freeze({
  preview: { bandwidth: 'Lowest', width: null, height: null, fps: 30, bitrateK: 1000 },
  '720p30': { bandwidth: 'Highest', width: 1280, height: 720, fps: 30, bitrateK: 3000 },
  '1080p30': { bandwidth: 'Highest', width: 1920, height: 1080, fps: 30, bitrateK: 6000 },
});

export const ENCODERS = Object.freeze(['libx264', 'h264_v4l2m2m', 'h264_vaapi']);

export function resolvePreset(name) {
  const preset = PRESETS[name];
  if (!preset) {
    throw new Error(`unknown PRESET "${name}", expected one of ${Object.keys(PRESETS).join(', ')}`);
  }
  return preset;
}

/**
 * Encoder-specific pieces of the FFmpeg command line.
 * - inputArgs: global options placed before `-i` (e.g. VAAPI device)
 * - filters: appended to the scale/fps filter chain (pixel format / hw upload)
 * - codecArgs: `-c:v` and rate control
 */
export function selectEncoder(encoder, { bitrateK, vaapiDevice = '/dev/dri/renderD128' }) {
  const maxrate = `${bitrateK}k`;
  const bufsize = `${bitrateK * 2}k`;
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
          bufsize,
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
        inputArgs: ['-vaapi_device', vaapiDevice],
        filters: ['format=nv12', 'hwupload'],
        codecArgs: ['-c:v', 'h264_vaapi', '-b:v', maxrate, '-maxrate', maxrate],
      };
    default:
      throw new Error(`unknown ENCODER "${encoder}", expected one of ${ENCODERS.join(', ')}`);
  }
}

/**
 * Full FFmpeg argument list for raw UYVY on stdin -> Short-HLS (1 s segments, 4 in playlist,
 * keyframe every second). `width`/`height`/`srcFps` describe the incoming NDI frames.
 * The input is restricted to `pipe`/`file`, so FFmpeg never opens network or other protocols.
 */
export function buildFfmpegArgs({ width, height, srcFps, encoder, outDir, preset, vaapiDevice }) {
  const p = typeof preset === 'string' ? resolvePreset(preset) : preset;
  const enc = selectEncoder(encoder, { bitrateK: p.bitrateK, vaapiDevice });
  const outFps = p.fps;
  const filters = [];
  if (p.width && p.height) filters.push(`scale=${p.width}:${p.height}`);
  filters.push(`fps=${outFps}`, ...enc.filters);
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostats',
    '-progress',
    'pipe:2',
    '-stats_period',
    '1',
    ...enc.inputArgs,
    '-protocol_whitelist',
    'pipe,file',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'uyvy422',
    '-s',
    `${width}x${height}`,
    '-r',
    String(srcFps),
    '-i',
    'pipe:0',
    '-an',
    '-vf',
    filters.join(','),
    ...enc.codecArgs,
    '-g',
    String(outFps),
    '-keyint_min',
    String(outFps),
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
    join(outDir, 'seg_%05d.ts'),
    join(outDir, 'index.m3u8'),
  ];
}

/** FIFO with fixed capacity; pushing into a full queue drops the oldest entry. */
export class BoundedQueue {
  #items = [];
  #capacity;
  dropped = 0;

  constructor(capacity) {
    this.#capacity = capacity;
  }

  push(item) {
    if (this.#items.length >= this.#capacity) {
      this.#items.shift();
      this.dropped += 1;
    }
    this.#items.push(item);
  }

  shift() {
    return this.#items.shift();
  }

  get length() {
    return this.#items.length;
  }
}

/** Returns tightly packed UYVY data; copies row by row when the NDI stride has padding. */
export function packFrame({ data, xres, yres, lineStrideBytes }) {
  const rowBytes = xres * BYTES_PER_PIXEL_UYVY;
  if (lineStrideBytes === rowBytes) return data;
  const packed = Buffer.allocUnsafe(rowBytes * yres);
  for (let y = 0; y < yres; y += 1) {
    data.copy(packed, y * rowBytes, y * lineStrideBytes, y * lineStrideBytes + rowBytes);
  }
  return packed;
}

/** Parses one `-progress` line ("key=value"); returns null for anything else. */
export function parseProgressLine(line) {
  const match = /^([a-z0-9_]+)=(.*)$/.exec(line.trim());
  return match ? { key: match[1], value: match[2].trim() } : null;
}

/** Total segments produced = media sequence of the first listed segment + listed segments. */
export function countSegments(playlist) {
  const seq = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(playlist);
  const listed = playlist.split('\n').filter((l) => l.trim().endsWith('.ts')).length;
  return (seq ? Number(seq[1]) : 0) + listed;
}

/** utime+stime of a process in clock ticks, from /proc/<pid>/stat (null if unavailable). */
export function readProcCpuTicks(pid, readFile = readFileSync) {
  try {
    const stat = readFile(`/proc/${pid}/stat`, 'utf8');
    // Field 2 (comm) may contain spaces; split after the closing paren.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(fields[11]) + Number(fields[12]); // fields 14 (utime) and 15 (stime)
  } catch {
    return null;
  }
}

function clockTicksPerSecond() {
  try {
    return Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100;
  } catch {
    return 100;
  }
}

function log(message) {
  console.log(`[spike] ${new Date().toISOString()} ${message}`);
}

function readConfig(env) {
  const durationS = Number(env.DURATION_S ?? 20);
  if (!Number.isFinite(durationS) || durationS <= 0) {
    throw new Error(`invalid DURATION_S=${env.DURATION_S}`);
  }
  const presetName = env.PRESET ?? '720p30';
  const encoder = env.ENCODER ?? 'libx264';
  resolvePreset(presetName);
  selectEncoder(encoder, { bitrateK: 1 }); // validate early
  return {
    sourceFilter: env.NDI_SOURCE ?? 'TEST-CAM',
    presetName,
    encoder,
    durationS,
    outDir: resolve(env.OUT_DIR ?? 'hls-out'),
    vaapiDevice: env.VAAPI_DEVICE ?? '/dev/dri/renderD128',
  };
}

async function findSource(grandi, filter) {
  const extraIPs = process.env.NDI_EXTRA_IPS;
  const finder = await grandi.find({ showLocalSources: true, ...(extraIPs ? { extraIPs } : {}) });
  const deadline = Date.now() + FIND_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      await finder.wait(500);
      const match = finder.sources().find((s) => s.name.includes(filter));
      if (match) return match;
    }
    const seen = finder.sources().map((s) => s.name);
    throw new Error(
      `no NDI source matching "${filter}" within ${FIND_TIMEOUT_MS / 1000}s; ` +
        `found: ${seen.length ? seen.join(', ') : 'none'}`,
    );
  } finally {
    finder.destroy();
  }
}

/** Owns the FFmpeg child: bounded queue in front of stdin, drain handling, progress parsing. */
class FfmpegSink {
  queue = new BoundedQueue(QUEUE_DEPTH);
  speed = null;
  cpuTicks = null;
  unflushed = 0;
  #child;
  #waitingForDrain = false;
  #exited;

  constructor(args) {
    this.#child = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.#exited = new Promise((resolveExit) => {
      this.#child.on('exit', (code, signal) => resolveExit({ code, signal }));
      this.#child.on('error', (err) => {
        log(`ffmpeg failed to start: ${err.message}`);
        resolveExit({ code: -1, signal: null });
      });
    });
    this.#child.stdin.on('error', (err) => log(`ffmpeg stdin error: ${err.message}`));
    this.#child.stdin.on('drain', () => {
      this.#waitingForDrain = false;
      this.#flush();
    });
    let partial = '';
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (chunk) => {
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) this.#onStderrLine(line);
    });
  }

  get pid() {
    return this.#child.pid;
  }

  get exited() {
    return this.#exited;
  }

  get isRunning() {
    return this.#child.exitCode === null && this.#child.signalCode === null;
  }

  enqueue(frame) {
    this.queue.push(frame);
    this.#flush();
  }

  #flush() {
    while (!this.#waitingForDrain && this.queue.length > 0 && this.isRunning) {
      if (!this.#child.stdin.write(this.queue.shift())) this.#waitingForDrain = true;
    }
  }

  #onStderrLine(line) {
    const kv = parseProgressLine(line);
    if (kv) {
      if (kv.key === 'speed' && kv.value !== 'N/A') this.speed = kv.value;
      return;
    }
    if (line.trim()) log(`ffmpeg: ${line.trim()}`);
  }

  /**
   * Writes the frames still queued, honouring backpressure, for at most `timeoutMs`.
   * Returns the number of frames that could not be written.
   */
  async #drainQueue(timeoutMs) {
    const signal = AbortSignal.timeout(timeoutMs);
    while (this.queue.length > 0 && this.isRunning && !signal.aborted) {
      if (!this.#waitingForDrain) {
        this.#flush();
        continue;
      }
      try {
        await once(this.#child.stdin, 'drain', { signal });
      } catch {
        break; // timeout or stdin error; whatever is left is reported as unflushed
      }
    }
    return this.queue.length;
  }

  /**
   * Flushes the queue, samples CPU, closes stdin so FFmpeg finalizes the playlist and kills it
   * if it hangs.
   */
  async stop() {
    this.unflushed = await this.#drainQueue(QUEUE_FLUSH_TIMEOUT_MS);
    this.cpuTicks = readProcCpuTicks(this.pid);
    this.#child.stdin.end();
    const timer = setTimeout(() => this.#child.kill('SIGKILL'), FFMPEG_EXIT_TIMEOUT_MS);
    const result = await this.#exited;
    clearTimeout(timer);
    return result;
  }
}

async function run(grandi, cfg) {
  const preset = resolvePreset(cfg.presetName);
  rmSync(cfg.outDir, { recursive: true, force: true });
  mkdirSync(cfg.outDir, { recursive: true });

  log(`looking for NDI source matching "${cfg.sourceFilter}"`);
  const source = await findSource(grandi, cfg.sourceFilter);
  log(`found "${source.name}" (${source.urlAddress ?? 'no url'})`);

  const receiver = await grandi.receive({
    source,
    colorFormat: grandi.ColorFormat.UYVY_BGRA,
    bandwidth: grandi.Bandwidth[preset.bandwidth],
    allowVideoFields: false,
  });

  const stats = { received: 0, nonUyvy: 0, timeouts: 0, intervalReceived: 0 };
  let sink = null;
  let geometry = null;
  let abortReason = null;
  let stopRequested = false;
  const startedAt = process.hrtime.bigint();
  const cpuStart = process.cpuUsage();

  const requestStop = () => {
    stopRequested = true;
  };
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);
  const durationTimer = setTimeout(requestStop, cfg.durationS * 1000);

  const statsTimer = setInterval(() => {
    const fps = stats.intervalReceived / (STATS_INTERVAL_MS / 1000);
    stats.intervalReceived = 0;
    log(
      `rx ${fps.toFixed(1)} fps | dropped ${sink?.queue.dropped ?? 0} | ` +
        `queue ${sink?.queue.length ?? 0}/${QUEUE_DEPTH} | ffmpeg speed ${sink?.speed ?? 'n/a'}`,
    );
  }, STATS_INTERVAL_MS);

  let ffmpegExit = null;
  try {
    while (!stopRequested) {
      let frame;
      try {
        frame = await receiver.video(FRAME_TIMEOUT_MS);
      } catch {
        stats.timeouts += 1;
        continue;
      }
      if (frame.fourCC !== grandi.FourCC.UYVY) {
        stats.nonUyvy += 1;
        continue;
      }
      const srcFps = frame.frameRateN / frame.frameRateD;
      if (!geometry) {
        geometry = { width: frame.xres, height: frame.yres, srcFps };
        const args = buildFfmpegArgs({ ...geometry, ...cfg, preset });
        log(`source ${frame.xres}x${frame.yres}@${srcFps.toFixed(2)} -> ffmpeg ${args.join(' ')}`);
        sink = new FfmpegSink(args);
      } else if (frame.xres !== geometry.width || frame.yres !== geometry.height) {
        abortReason = `resolution changed ${geometry.width}x${geometry.height} -> ${frame.xres}x${frame.yres}`;
        break;
      }
      if (!sink.isRunning) {
        abortReason = 'ffmpeg exited during the run';
        break;
      }
      stats.received += 1;
      stats.intervalReceived += 1;
      sink.enqueue(packFrame(frame));
    }
  } catch (err) {
    abortReason = `receive loop failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    clearTimeout(durationTimer);
    clearInterval(statsTimer);
    process.off('SIGINT', requestStop);
    process.off('SIGTERM', requestStop);
    try {
      receiver.destroy();
    } finally {
      // Always stop FFmpeg, also when the loop or receiver.destroy() threw.
      if (sink) ffmpegExit = await sink.stop();
    }
  }

  const wallS = Number(process.hrtime.bigint() - startedAt) / 1e9;
  const cpu = process.cpuUsage(cpuStart);
  const ticksPerS = clockTicksPerSecond();
  const playlistPath = join(cfg.outDir, 'index.m3u8');
  let segments = 0;
  try {
    segments = countSegments(readFileSync(playlistPath, 'utf8'));
  } catch {
    log(`no playlist at ${playlistPath}`);
  }

  const summary = {
    preset: cfg.presetName,
    encoder: cfg.encoder,
    source: source.name,
    sourceGeometry: geometry,
    durationS: Number(wallS.toFixed(2)),
    framesReceived: stats.received,
    framesDropped: sink?.queue.dropped ?? 0,
    framesUnflushed: sink?.unflushed ?? 0,
    receiveTimeouts: stats.timeouts,
    nonUyvyFrames: stats.nonUyvy,
    avgFps: Number((stats.received / wallS).toFixed(2)),
    segmentsProduced: segments,
    segmentsOnDisk: readdirSync(cfg.outDir).filter((f) => f.endsWith('.ts')).length,
    nodeCpuPctOfCore: Number(((100 * (cpu.user + cpu.system)) / 1e6 / wallS).toFixed(1)),
    ffmpegCpuPctOfCore:
      sink?.cpuTicks == null
        ? null
        : Number(((100 * sink.cpuTicks) / ticksPerS / wallS).toFixed(1)),
    ffmpegExit,
    abortReason,
    outDir: cfg.outDir,
  };
  console.log(JSON.stringify(summary, null, 2));
  return abortReason ? 3 : 0;
}

async function main() {
  const cfg = readConfig(process.env);
  // Imported lazily so the pure helpers above stay testable without the native NDI binding.
  // Resolves via normal node_modules lookup (capture plugin image: /app/node_modules/grandi).
  const { default: grandi } = await import('grandi');
  if (!grandi.isSupportedCPU()) throw new Error('NDI is not supported on this CPU/platform');
  grandi.initialize();
  try {
    return await run(grandi, cfg);
  } finally {
    grandi.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[spike] fatal: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
