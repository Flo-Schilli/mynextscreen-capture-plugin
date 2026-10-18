// SPDX-License-Identifier: Apache-2.0
import { ApiError } from '../errors.js';
import { createLogger, type Logger } from '../logger.js';
import type { PipelineConfig, StreamStatus } from '../types.js';

/** The slice of a pipeline the registry drives. */
export interface PipelinePort {
  readonly config: PipelineConfig;
  start(): void;
  stop(): Promise<void>;
  status(): StreamStatus;
}

export type PipelineFactory = (config: PipelineConfig) => PipelinePort;

/**
 * True when two configs differ in a field the video pipeline depends on. An
 * identical config sent again is a no-op, so the agent can re-assert its stream
 * list on every poll without interrupting the picture.
 */
export function configChanged(a: PipelineConfig, b: PipelineConfig): boolean {
  return (
    a.cameraHost !== b.cameraHost ||
    a.ndiSourceName !== b.ndiSourceName ||
    a.bandwidth !== b.bandwidth ||
    a.width !== b.width ||
    a.height !== b.height ||
    a.fps !== b.fps ||
    a.bitrateKbps !== b.bitrateKbps ||
    a.encoderPref !== b.encoderPref
  );
}

/**
 * The running pipelines, keyed by stream id. Operations are serialised so a
 * replace (stop, then start) cannot interleave with another call for the same
 * stream.
 */
export class StreamRegistry {
  private readonly pipelines = new Map<string, PipelinePort>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly createPipeline: PipelineFactory,
    private readonly maxStreams: number = Number.POSITIVE_INFINITY,
    private readonly logger: Logger = createLogger('streams'),
  ) {}

  /**
   * Starts the stream, replaces it when its config changed, leaves it alone
   * otherwise. A new id beyond the cap is refused; replacing an id is always fine.
   */
  put(config: PipelineConfig): Promise<StreamStatus> {
    return this.enqueue(async () => {
      const existing = this.pipelines.get(config.streamId);
      if (existing && !configChanged(existing.config, config)) {
        return existing.status();
      }
      if (!existing && this.pipelines.size >= this.maxStreams) {
        throw new ApiError(
          409,
          'stream_limit',
          `At most ${this.maxStreams} streams can run at once`,
        );
      }
      if (existing) {
        this.pipelines.delete(config.streamId);
        await existing.stop();
        this.logger.info(`Replacing stream ${config.streamId}`);
      }
      const pipeline = this.createPipeline(config);
      this.pipelines.set(config.streamId, pipeline);
      pipeline.start();
      this.logger.info(`Started stream ${config.streamId}`);
      return pipeline.status();
    });
  }

  /** Stops the stream; unknown ids are ignored, so deleting twice is safe. */
  remove(streamId: string): Promise<void> {
    return this.enqueue(async () => {
      const existing = this.pipelines.get(streamId);
      if (!existing) {
        return;
      }
      this.pipelines.delete(streamId);
      await existing.stop();
      this.logger.info(`Stopped stream ${streamId}`);
    });
  }

  list(): StreamStatus[] {
    return [...this.pipelines.values()].map((pipeline) => pipeline.status());
  }

  stopAll(): Promise<void> {
    return this.enqueue(async () => {
      const all = [...this.pipelines.values()];
      this.pipelines.clear();
      await Promise.all(all.map((pipeline) => pipeline.stop()));
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch((error: unknown) => {
      if (error instanceof ApiError) {
        return; // a refusal for the caller, not a fault
      }
      this.logger.error(
        `Stream operation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return result;
  }
}
