// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { BoundedQueue } from './bounded-queue.js';

/** Frames waiting in front of FFmpeg's stdin; deeper only adds latency. */
export const QUEUE_DEPTH = 3;
const QUEUE_FLUSH_TIMEOUT_MS = 2_000;
const FFMPEG_EXIT_TIMEOUT_MS = 5_000;
const MAX_ERROR_LENGTH = 200;

/** The slice of a child process the transcoder needs. */
export interface FfmpegChild {
  stdin: Writable;
  stderr: Readable;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Starts FFmpeg; the seam that keeps specs from spawning a process. */
export type FfmpegSpawner = (path: string, args: string[]) => FfmpegChild;

export const systemFfmpegSpawner: FfmpegSpawner = (path, args) =>
  spawn(path, args, { stdio: ['pipe', 'ignore', 'pipe'] }) as unknown as FfmpegChild;

export interface TranscoderExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Last line FFmpeg wrote to stderr, shortened; null when it wrote none. */
  lastError: string | null;
}

/**
 * One FFmpeg child fed with raw frames. A bounded queue sits in front of stdin:
 * when FFmpeg falls behind, the oldest frame is dropped instead of letting
 * memory grow, and stdin backpressure pauses writing until it drains.
 */
export class NdiTranscoder {
  private readonly queue = new BoundedQueue<Buffer>(QUEUE_DEPTH);
  private readonly child: FfmpegChild;
  private readonly exitPromise: Promise<TranscoderExit>;
  private waitingForDrain = false;
  private lastError: string | null = null;
  private partialLine = '';

  constructor(spawner: FfmpegSpawner, ffmpegPath: string, args: string[]) {
    this.child = spawner(ffmpegPath, args);
    this.exitPromise = new Promise((resolve) => {
      let settled = false;
      const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (!settled) {
          settled = true;
          resolve({ code, signal, lastError: this.lastError });
        }
      };
      this.child.on('exit', settle);
      this.child.on('error', (error) => {
        this.lastError = shorten(`ffmpeg failed to start: ${error.message}`);
        settle(null, null);
      });
    });
    // A closed pipe surfaces through the exit event; the write error adds nothing.
    this.child.stdin.on('error', () => undefined);
    this.child.stdin.on('drain', () => {
      this.waitingForDrain = false;
      this.flush();
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => this.onStderr(chunk));
  }

  get exited(): Promise<TranscoderExit> {
    return this.exitPromise;
  }

  get isRunning(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  get framesDropped(): number {
    return this.queue.dropped;
  }

  enqueue(frame: Buffer): void {
    this.queue.push(frame);
    this.flush();
  }

  /**
   * Writes what is still queued for a bounded time, closes stdin so FFmpeg
   * finalises the playlist, and kills it if it hangs.
   */
  async stop(): Promise<TranscoderExit> {
    await this.drainQueue();
    if (this.isRunning) {
      this.child.stdin.end();
    }
    const timer = setTimeout(() => this.child.kill('SIGKILL'), FFMPEG_EXIT_TIMEOUT_MS);
    try {
      return await this.exitPromise;
    } finally {
      clearTimeout(timer);
    }
  }

  private flush(): void {
    while (!this.waitingForDrain && this.queue.length > 0 && this.isRunning) {
      const frame = this.queue.shift();
      if (frame && !this.child.stdin.write(frame)) {
        this.waitingForDrain = true;
      }
    }
  }

  private async drainQueue(): Promise<void> {
    const signal = AbortSignal.timeout(QUEUE_FLUSH_TIMEOUT_MS);
    while (this.queue.length > 0 && this.isRunning && !signal.aborted) {
      if (!this.waitingForDrain) {
        this.flush();
        continue;
      }
      try {
        await once(this.child.stdin, 'drain', { signal });
      } catch {
        return; // timeout or stdin error; the rest is abandoned
      }
    }
  }

  private onStderr(chunk: string): void {
    const lines = (this.partialLine + chunk).split('\n');
    this.partialLine = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) {
        this.lastError = shorten(line.trim());
      }
    }
  }
}

function shorten(text: string): string {
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}...` : text;
}
