// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto';
import { createLogger, type Logger } from '../logger.js';
import {
  NDI_STATUS_MAX_ENCODER,
  NDI_STATUS_MAX_SOURCE_NAME,
  type NdiErrorCode,
  type NdiStreamStateValue,
  type PipelineConfig,
  type StreamStatus,
} from '../types.js';
import {
  selectEncoder,
  systemDeviceProbe,
  type DeviceProbe,
  type EncoderName,
} from './ndi-encoder.js';
import { buildFfmpegArgs, targetFpsFor, targetHeightFor } from './ndi-ffmpeg-args.js';
import { NdiTranscoder, systemFfmpegSpawner, type FfmpegSpawner } from './ndi-transcoder.js';
import {
  NdiSourceNotFoundError,
  type NdiFrame,
  type NdiReceiver,
  type NdiReceiverFactory,
} from './ndi-receiver.js';

const FRAME_TIMEOUT_MS = 1_000;
/** Without a single frame for this long the source counts as gone. */
export const FRAME_STALL_MS = 10_000;
const FPS_SAMPLE_MS = 1_000;
/** A run this long counts as healthy and resets the retry backoff. */
const HEALTHY_RUN_MS = 10_000;

/** A failure with a reportable code; the message is for the local log only. */
class NdiPipelineError extends Error {
  constructor(
    readonly code: NdiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NdiPipelineError';
  }
}

function errorCodeOf(error: unknown): NdiErrorCode {
  if (error instanceof NdiPipelineError) {
    return error.code;
  }
  return error instanceof NdiSourceNotFoundError ? 'source_not_found' : 'internal_error';
}

/** Short random id of one FFmpeg run, part of every segment name it writes. */
export const newRunId = (): string => randomBytes(4).toString('hex');

const truncate = (value: string | null, max: number): string | null =>
  value !== null && value.length > max ? value.slice(0, max) : value;

export const DEFAULT_BACKOFF = { initialMs: 1_000, maxMs: 30_000 } as const;

/** The working directory of a stream: created clean, removed on teardown. */
export interface StreamDirectory {
  prepare(dir: string): Promise<void>;
  remove(dir: string): Promise<void>;
}

export interface PipelineSettings {
  ffmpegPath: string;
  encoderOverride: string | null;
  arch: string;
  backoff: { initialMs: number; maxMs: number };
}

export interface PipelineDeps {
  receivers: NdiReceiverFactory;
  directory: StreamDirectory;
  dir: string;
  settings: PipelineSettings;
  spawner?: FfmpegSpawner;
  probe?: DeviceProbe;
  /** Called after the state or error changed. */
  onChange?: () => void;
  logger?: Logger;
  /** Id of one FFmpeg run; injectable for tests. */
  runId?: () => string;
}

/**
 * One NDI camera on its way to disk: receive, transcode, write Short-HLS into
 * the stream directory. The loop restarts itself with backoff whenever the
 * source is missing or a stage dies, so a camera that is switched on later, or
 * an FFmpeg that crashes, heals without anyone touching the plugin.
 */
export class NdiPipeline {
  private readonly logger: Logger;
  private state: NdiStreamStateValue = 'connecting';
  private sourceName: string | null = null;
  private encoder: EncoderName | null = null;
  private error: NdiErrorCode | null = null;
  private fps: number | null = null;
  private droppedBefore = 0;
  private transcoder: NdiTranscoder | null = null;
  private framesReceived = 0;
  private fpsSample = { at: Date.now(), frames: 0 };
  private stopRequested = false;
  private readonly abort = new AbortController();
  private wake: (() => void) | null = null;
  private loop: Promise<void> = Promise.resolve();

  constructor(
    readonly config: PipelineConfig,
    private readonly deps: PipelineDeps,
  ) {
    this.logger = deps.logger ?? createLogger('pipeline');
  }

  start(): void {
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.abort.abort();
    this.wake?.();
    await this.loop;
  }

  status(): StreamStatus {
    this.sampleFps();
    return {
      streamId: this.config.streamId,
      state: this.state,
      sourceName: truncate(this.sourceName, NDI_STATUS_MAX_SOURCE_NAME),
      encoder: truncate(this.encoder, NDI_STATUS_MAX_ENCODER),
      fps: this.fps,
      framesDropped: this.droppedBefore + (this.transcoder?.framesDropped ?? 0),
      error: this.error,
    };
  }

  private async run(): Promise<void> {
    let delay = this.deps.settings.backoff.initialMs;
    while (!this.stopRequested) {
      const startedAt = Date.now();
      this.setConnecting();
      try {
        await this.attempt();
      } catch (error) {
        if (!this.stopRequested) {
          this.fail(error);
        }
      } finally {
        await this.teardown();
      }
      if (this.stopRequested) {
        break;
      }
      delay =
        Date.now() - startedAt >= HEALTHY_RUN_MS
          ? this.deps.settings.backoff.initialMs
          : Math.min(delay * 2, this.deps.settings.backoff.maxMs);
      await this.pause(delay);
    }
    await this.deps.directory.remove(this.deps.dir).catch(() => undefined);
  }

  private async attempt(): Promise<void> {
    const receiver = await this.deps.receivers.open(
      {
        cameraHost: this.config.cameraHost,
        ndiSourceName: this.config.ndiSourceName,
        bandwidth: this.config.bandwidth,
      },
      this.abort.signal,
    );
    this.sourceName = receiver.sourceName;
    try {
      await this.receiveLoop(receiver);
    } finally {
      receiver.close();
    }
  }

  private async receiveLoop(receiver: NdiReceiver): Promise<void> {
    let geometry: { width: number; height: number } | null = null;
    let lastFrameAt = Date.now();
    while (!this.stopRequested) {
      const frame = await receiver.nextFrame(FRAME_TIMEOUT_MS);
      if (!frame) {
        if (Date.now() - lastFrameAt > FRAME_STALL_MS) {
          throw new NdiPipelineError('no_frames', 'No video frames received');
        }
        continue;
      }
      lastFrameAt = Date.now();
      if (!geometry) {
        geometry = { width: frame.width, height: frame.height };
        await this.startEncoding(frame);
      } else if (frame.width !== geometry.width || frame.height !== geometry.height) {
        throw new NdiPipelineError('resolution_changed', 'Source resolution changed');
      }
      const transcoder = this.transcoder;
      if (!transcoder?.isRunning) {
        throw new NdiPipelineError(
          'ffmpeg_exited',
          (await transcoder?.exited)?.lastError ?? 'Encoder stopped',
        );
      }
      this.framesReceived += 1;
      transcoder.enqueue(frame.data);
    }
  }

  private async startEncoding(first: NdiFrame): Promise<void> {
    const { config } = this;
    const { settings } = this.deps;
    const encoder = selectEncoder(
      config.encoderPref,
      settings.arch,
      settings.encoderOverride,
      this.deps.probe ?? systemDeviceProbe,
    );
    const args = buildFfmpegArgs({
      sourceWidth: first.width,
      sourceHeight: first.height,
      sourceFps: first.fps,
      targetHeight: targetHeightFor(config.height, first.height),
      targetFps: targetFpsFor(config.fps, first.fps),
      bitrateKbps: config.bitrateKbps,
      encoder,
      outDir: this.deps.dir,
      runId: (this.deps.runId ?? newRunId)(),
    });
    await this.deps.directory.prepare(this.deps.dir);
    this.encoder = encoder;
    this.transcoder = new NdiTranscoder(
      this.deps.spawner ?? systemFfmpegSpawner,
      settings.ffmpegPath,
      args,
    );
    this.state = 'streaming';
    this.error = null;
    this.deps.onChange?.();
    this.fpsSample = { at: Date.now(), frames: this.framesReceived };
  }

  private async teardown(): Promise<void> {
    const transcoder = this.transcoder;
    this.transcoder = null;
    if (transcoder) {
      this.droppedBefore += transcoder.framesDropped;
      await transcoder.stop();
    }
    this.fps = null;
  }

  private setConnecting(): void {
    // A pending error stays visible until a retry actually gets frames flowing.
    if (!this.error && this.state !== 'connecting') {
      this.state = 'connecting';
      this.deps.onChange?.();
    }
    this.sourceName = null;
    this.encoder = null;
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.error = errorCodeOf(error);
    this.state = 'error';
    this.logger.warn(`Stream ${this.config.streamId}: ${this.error}: ${message}`);
    this.deps.onChange?.();
  }

  private sampleFps(): void {
    const now = Date.now();
    const elapsed = now - this.fpsSample.at;
    if (this.state !== 'streaming' || elapsed < FPS_SAMPLE_MS) {
      return;
    }
    this.fps = Number(
      ((this.framesReceived - this.fpsSample.frames) / (elapsed / 1000)).toFixed(1),
    );
    this.fpsSample = { at: now, frames: this.framesReceived };
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      this.wake = done;
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}
