// SPDX-License-Identifier: Apache-2.0
import { jest } from '@jest/globals';
import { NdiTranscoder, QUEUE_DEPTH, systemFfmpegSpawner } from './ndi-transcoder.js';
import { fakeSpawner, type FakeFfmpeg } from './testing/fake-ffmpeg.js';

const frame = (n: number): Buffer => Buffer.from([n]);
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('NdiTranscoder', () => {
  let child: FakeFfmpeg;
  let transcoder: NdiTranscoder;

  beforeEach(() => {
    const fake = fakeSpawner();
    transcoder = new NdiTranscoder(fake.spawner, '/usr/bin/ffmpeg', ['-i', 'pipe:0']);
    child = fake.children[0];
  });

  it('writes frames straight through while stdin keeps up', () => {
    transcoder.enqueue(frame(1));
    transcoder.enqueue(frame(2));

    expect(child.stdin.written.map((b) => b[0])).toEqual([1, 2]);
    expect(transcoder.framesDropped).toBe(0);
  });

  it('holds frames back under backpressure and drops the oldest beyond the depth', () => {
    child.stdin.results = [false];
    transcoder.enqueue(frame(1)); // accepted but reports backpressure
    for (let n = 2; n <= QUEUE_DEPTH + 3; n += 1) {
      transcoder.enqueue(frame(n));
    }

    expect(child.stdin.written).toHaveLength(1);
    expect(transcoder.framesDropped).toBe(2);

    child.stdin.emit('drain');

    expect(child.stdin.written.map((b) => b[0])).toEqual([1, 4, 5, 6]);
  });

  it('does not write once the process has exited', async () => {
    child.finish(1, null);
    await transcoder.exited;

    transcoder.enqueue(frame(1));

    expect(transcoder.isRunning).toBe(false);
    expect(child.stdin.written).toHaveLength(0);
  });

  it('keeps the last stderr line, shortened, as the exit error', async () => {
    child.stderr.write('first\npartial');
    child.stderr.write(` line ${'x'.repeat(300)}\n`);
    await tick();
    child.finish(1, null);

    const exit = await transcoder.exited;

    expect(exit.code).toBe(1);
    expect(exit.lastError).toMatch(/^partial line x+\.\.\.$/);
    expect(exit.lastError?.length).toBeLessThan(210);
  });

  it('reports a failed start', async () => {
    child.emit('error', new Error('spawn ENOENT'));

    const exit = await transcoder.exited;

    expect(exit.lastError).toContain('spawn ENOENT');
  });

  it('ignores stdin errors and a second exit', async () => {
    child.stdin.emit('error', new Error('EPIPE'));
    child.finish(0, null);
    child.emit('exit', 5, null);

    expect((await transcoder.exited).code).toBe(0);
  });

  it('flushes queued frames and closes stdin on stop', async () => {
    child.stdin.results = [false];
    transcoder.enqueue(frame(1));
    transcoder.enqueue(frame(2));
    setImmediate(() => child.stdin.emit('drain'));

    const exit = await transcoder.stop();

    expect(child.stdin.written.map((b) => b[0])).toEqual([1, 2]);
    expect(child.stdin.end).toHaveBeenCalled();
    expect(exit.code).toBe(0);
  });

  it('gives up flushing when stdin never drains', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      child.stdin.results = [false];
      transcoder.enqueue(frame(1));
      transcoder.enqueue(frame(2));

      const stopping = transcoder.stop();
      await jest.advanceTimersByTimeAsync(2_500);

      expect((await stopping).code).toBe(0);
      expect(child.stdin.written).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('kills a process that ignores the closed stdin', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      child.exitOnStdinEnd = false;

      const stopping = transcoder.stop();
      await jest.advanceTimersByTimeAsync(5_100);

      expect((await stopping).signal).toBe('SIGKILL');
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops cleanly when the process is already gone', async () => {
    child.finish(1, null);

    const exit = await transcoder.stop();

    expect(exit.code).toBe(1);
    expect(child.stdin.end).not.toHaveBeenCalled();
  });
});

describe('systemFfmpegSpawner', () => {
  it('reports a missing binary through the error event instead of throwing', async () => {
    const child = systemFfmpegSpawner('/nonexistent/ffmpeg-binary', []);

    const error = await new Promise<Error>((resolve) => child.on('error', resolve));

    expect(error.message).toContain('ENOENT');
  });
});
