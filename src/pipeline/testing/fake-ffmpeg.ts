// SPDX-License-Identifier: Apache-2.0
import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { FfmpegChild, FfmpegSpawner } from '../ndi-transcoder.js';

class FakeStdin extends EventEmitter {
  readonly written: Buffer[] = [];
  /** What the next writes return; true when the list is empty. */
  results: boolean[] = [];

  write(chunk: Buffer): boolean {
    this.written.push(chunk);
    return this.results.shift() ?? true;
  }

  end = jest.fn();
}

/** A stand-in FFmpeg process: records stdin writes and lets a spec drive exit and stderr. */
export class FakeFfmpeg extends EventEmitter {
  readonly stdin = new FakeStdin();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  /** Whether closing stdin makes the process exit, as the real one does. */
  exitOnStdinEnd = true;
  readonly kill = jest.fn((signal?: NodeJS.Signals) => {
    this.finish(null, signal ?? 'SIGTERM');
    return true;
  });

  constructor() {
    super();
    this.stdin.end.mockImplementation(() => {
      if (this.exitOnStdinEnd) {
        this.finish(0, null);
      }
    });
  }

  finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode === null && this.signalCode === null) {
      this.exitCode = code;
      this.signalCode = signal;
      this.emit('exit', code, signal);
    }
  }
}

export interface FakeSpawn {
  spawner: FfmpegSpawner;
  children: FakeFfmpeg[];
  calls: Array<{ path: string; args: string[] }>;
}

export function fakeSpawner(): FakeSpawn {
  const children: FakeFfmpeg[] = [];
  const calls: Array<{ path: string; args: string[] }> = [];
  return {
    children,
    calls,
    spawner: (path, args) => {
      calls.push({ path, args });
      const child = new FakeFfmpeg();
      children.push(child);
      return child as unknown as FfmpegChild;
    },
  };
}
