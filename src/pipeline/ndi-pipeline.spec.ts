// SPDX-License-Identifier: Apache-2.0
import { jest } from '@jest/globals';
import type { PipelineConfig } from '../types.js';
import {
  NdiPipeline,
  FRAME_STALL_MS,
  newRunId,
  type PipelineDeps,
  type StreamDirectory,
} from './ndi-pipeline.js';
import {
  NdiSourceNotFoundError,
  type NdiFrame,
  type NdiReceiver,
  type NdiReceiverFactory,
} from './ndi-receiver.js';
import { fakeSpawner, type FakeSpawn } from './testing/fake-ffmpeg.js';

const CONFIG: PipelineConfig = {
  streamId: '6f1c2a52-7d3e-4c1a-9f0e-2b8d5a1c9e11',
  cameraHost: '192.168.1.60',
  ndiSourceName: 'CAM (a)',
  bandwidth: 'highest',
  width: 1280,
  height: 720,
  fps: 30,
  bitrateKbps: 3000,
  encoderPref: 'software',
};

const frame = (overrides: Partial<NdiFrame> = {}): NdiFrame => ({
  data: Buffer.from([1]),
  width: 1920,
  height: 1080,
  fps: 30,
  ...overrides,
});

const settle = (_times = 1): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const later =
  <T>(value: T): (() => Promise<T>) =>
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    return value;
  };

describe('NdiPipeline', () => {
  let spawn: FakeSpawn;
  let open: jest.Mock<NdiReceiverFactory['open']>;
  let nextFrame: jest.Mock<NdiReceiver['nextFrame']>;
  let close: jest.Mock<NdiReceiver['close']>;
  let directory: {
    prepare: jest.Mock<StreamDirectory['prepare']>;
    remove: jest.Mock<StreamDirectory['remove']>;
  };
  let pipeline: NdiPipeline;
  let onChange: jest.Mock<() => void>;
  let runIds: string[];
  let receiverName: string;

  function receiver(): NdiReceiver {
    return { sourceName: receiverName, nextFrame, close };
  }

  function build(config = CONFIG): NdiPipeline {
    const deps: PipelineDeps = {
      receivers: { open } as NdiReceiverFactory,
      directory,
      dir: '/tmp/mns-ndi/stream',
      settings: {
        ffmpegPath: 'ffmpeg',
        encoderOverride: null,
        arch: 'x64',
        backoff: { initialMs: 5, maxMs: 20 },
      },
      spawner: spawn.spawner,
      probe: { exists: () => false, hasVideoDevices: () => false },
      onChange,
      runId: () => runIds.shift() ?? 'zzzzzzzz',
    };
    return new NdiPipeline(config, deps);
  }

  beforeEach(() => {
    spawn = fakeSpawner();
    onChange = jest.fn<() => void>();
    runIds = [];
    receiverName = 'CAM (a)';
    close = jest.fn<NdiReceiver['close']>();
    nextFrame = jest.fn<NdiReceiver['nextFrame']>().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return frame();
    });
    open = jest.fn<NdiReceiverFactory['open']>().mockImplementation(async () => receiver());
    directory = {
      prepare: jest.fn<StreamDirectory['prepare']>().mockResolvedValue(undefined),
      remove: jest.fn<StreamDirectory['remove']>().mockResolvedValue(undefined),
    };
  });

  afterEach(async () => {
    await pipeline?.stop();
  });

  it('opens the camera with the contract fields only', async () => {
    pipeline = build();
    pipeline.start();
    await settle();

    expect(open).toHaveBeenCalledWith(
      {
        cameraHost: '192.168.1.60',
        ndiSourceName: 'CAM (a)',
        bandwidth: 'highest',
      },
      expect.any(AbortSignal),
    );
  });

  it('streams frames through FFmpeg into the stream directory', async () => {
    pipeline = build();
    pipeline.start();
    await settle();

    expect(directory.prepare).toHaveBeenCalledWith('/tmp/mns-ndi/stream');
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.children[0].stdin.written.length).toBeGreaterThan(0);
    expect(pipeline.status()).toMatchObject({
      streamId: CONFIG.streamId,
      state: 'streaming',
      sourceName: 'CAM (a)',
      encoder: 'libx264',
      error: null,
    });
  });

  it('never upscales: a 720p source stays 720p for a 1080p preset', async () => {
    nextFrame.mockImplementation(later(frame({ width: 1280, height: 720 })));
    pipeline = build({ ...CONFIG, width: 1920, height: 1080 });
    pipeline.start();
    await settle();

    const args = spawn.calls[0].args;
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=-2:720,fps=30,format=yuv420p');
  });

  it('keeps the source name out of the FFmpeg arguments', async () => {
    pipeline = build();
    pipeline.start();
    await settle();

    expect(spawn.calls[0].args.join(' ')).not.toContain('CAM');
  });

  it('reports fps measured over a window', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      pipeline = build();
      pipeline.start();
      await settle();
      now.mockReturnValue(1_002_000);

      expect(pipeline.status().fps).toBeGreaterThan(0);
    } finally {
      now.mockRestore();
    }
  });

  it('shows an error and retries with backoff when the source is missing', async () => {
    open.mockRejectedValueOnce(new NdiSourceNotFoundError('NDI source not found at 10.1.2.3'));
    pipeline = build();
    pipeline.start();
    await wait(2);

    expect(pipeline.status()).toMatchObject({
      state: 'error',
      error: 'source_not_found',
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(open).toHaveBeenCalledTimes(2);
    expect(pipeline.status().state).toBe('streaming');
    expect(pipeline.status().error).toBeNull();
  });

  it('restarts when FFmpeg dies and reports its last error', async () => {
    pipeline = build();
    pipeline.start();
    await settle();
    spawn.children[0].stderr.write('Unknown encoder\n');
    await settle(2);
    spawn.children[0].finish(1, null);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(spawn.calls.length).toBeGreaterThanOrEqual(2);
    expect(close).toHaveBeenCalled();
  });

  it('restarts when the source changes resolution', async () => {
    nextFrame
      .mockResolvedValueOnce(frame())
      .mockResolvedValueOnce(frame({ width: 1280, height: 720 }))
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return frame({ width: 1280, height: 720 });
      });
    pipeline = build();
    pipeline.start();
    await new Promise((resolve) => setTimeout(resolve, 40));

    const sizes = spawn.calls.map(({ args }) => args[args.indexOf('-s') + 1]);
    expect(sizes[0]).toBe('1920x1080');
    expect(sizes).toContain('1280x720');
  });

  it('treats a long silence as a lost source', async () => {
    let clock = 2_000_000;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      nextFrame.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        clock += FRAME_STALL_MS + 1;
        return null;
      });
      pipeline = build();
      pipeline.start();
      await settle();

      expect(pipeline.status()).toMatchObject({
        state: 'error',
        error: 'no_frames',
      });
    } finally {
      now.mockRestore();
    }
  });

  it('keeps polling through short gaps without frames', async () => {
    nextFrame.mockResolvedValueOnce(null).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return frame();
    });
    pipeline = build();
    pipeline.start();
    await settle();

    expect(pipeline.status().state).toBe('streaming');
  });

  it('stops promptly, closes everything and removes the directory', async () => {
    pipeline = build();
    pipeline.start();
    await settle();

    await pipeline.stop();

    expect(close).toHaveBeenCalled();
    expect(spawn.children[0].stdin.end).toHaveBeenCalled();
    expect(directory.remove).toHaveBeenCalledWith('/tmp/mns-ndi/stream');
  });

  it('stops while waiting between retries', async () => {
    open.mockRejectedValue(new Error('nope'));
    pipeline = build();
    pipeline.start();
    await settle(3);

    await pipeline.stop();
    const opened = open.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(open).toHaveBeenCalledTimes(opened);
  });

  it('never reports free text, only a code', async () => {
    open.mockRejectedValue(new Error('secret detail at 10.0.0.9 ' + 'x'.repeat(500)));
    pipeline = build();
    pipeline.start();
    await wait(2);

    expect(pipeline.status().error).toBe('internal_error');
  });

  it('reports non-Error rejections as an internal error', async () => {
    open.mockRejectedValue('plain text');
    pipeline = build();
    pipeline.start();
    await wait(2);

    expect(pipeline.status().error).toBe('internal_error');
  });

  it('reports a resolution change with its own code', async () => {
    nextFrame
      .mockResolvedValueOnce(frame())
      .mockResolvedValueOnce(frame({ width: 1280, height: 720 }))
      .mockImplementation(later(frame({ width: 1280, height: 720 })));
    pipeline = build();
    pipeline.start();
    await wait(8);

    expect(pipeline.status().error).toBe('resolution_changed');
  });

  it('reports a dead FFmpeg as ffmpeg_exited and keeps its output out of the status', async () => {
    pipeline = build();
    pipeline.start();
    await settle();
    spawn.children[0].stderr.write('Unknown encoder /home/x\n');
    spawn.children[0].finish(1, null);
    await wait(4);

    expect(pipeline.status().error).toBe('ffmpeg_exited');
  });

  it('truncates source name and encoder to the backend limits', async () => {
    receiverName = 'N'.repeat(500);
    pipeline = build();
    pipeline.start();
    await settle();

    expect(pipeline.status().sourceName).toHaveLength(200);
  });

  it('uses a fresh run id for every FFmpeg start', async () => {
    runIds = ['aaaaaaaa', 'bbbbbbbb'];
    open.mockRejectedValueOnce(new Error('first attempt fails'));
    pipeline = build();
    pipeline.start();
    await wait(2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    spawn.children[0].finish(1, null);
    await new Promise((resolve) => setTimeout(resolve, 40));

    const names = spawn.calls.map(
      ({ args }) => args[args.indexOf('-hls_segment_filename') + 1] as string,
    );
    expect(names[0]).toContain('seg_aaaaaaaa_');
    expect(names[1]).toContain('seg_bbbbbbbb_');
  });

  it('notifies on state changes so they can be reported at once', async () => {
    pipeline = build();
    pipeline.start();
    await settle();

    expect(onChange).toHaveBeenCalled();
  });

  it('generates short lowercase alphanumeric run ids', () => {
    expect(newRunId()).toMatch(/^[a-z0-9]{6,8}$/);
    expect(newRunId()).not.toBe(newRunId());
  });
});
