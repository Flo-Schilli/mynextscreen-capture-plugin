// SPDX-License-Identifier: Apache-2.0
import { jest } from '@jest/globals';
import type { PipelineConfig, StreamStatus } from '../types.js';
import { StreamRegistry, type PipelinePort } from './stream-registry.js';

const CONFIG: PipelineConfig = {
  streamId: '6f1c2a52-7d3e-4c1a-9f0e-2b8d5a1c9e11',
  cameraHost: '192.168.1.60',
  ndiSourceName: null,
  bandwidth: 'highest',
  width: 1280,
  height: 720,
  fps: 30,
  bitrateKbps: 3000,
  encoderPref: 'auto',
};

class FakePipeline implements PipelinePort {
  readonly start = jest.fn();
  readonly stop = jest.fn(async () => undefined);
  constructor(readonly config: PipelineConfig) {}
  status(): StreamStatus {
    return {
      streamId: this.config.streamId,
      state: 'connecting',
      sourceName: null,
      encoder: null,
      fps: null,
      framesDropped: 0,
      error: null,
    };
  }
}

describe('StreamRegistry', () => {
  let created: FakePipeline[];
  let registry: StreamRegistry;

  beforeEach(() => {
    created = [];
    registry = new StreamRegistry((config) => {
      const pipeline = new FakePipeline(config);
      created.push(pipeline);
      return pipeline;
    });
  });

  it('starts a new stream and lists it', async () => {
    const status = await registry.put(CONFIG);

    expect(status.streamId).toBe(CONFIG.streamId);
    expect(created).toHaveLength(1);
    expect(created[0].start).toHaveBeenCalledTimes(1);
    expect(registry.list()).toHaveLength(1);
  });

  it('leaves a stream alone when the same config arrives again', async () => {
    await registry.put(CONFIG);
    await registry.put({ ...CONFIG });

    expect(created).toHaveLength(1);
    expect(created[0].stop).not.toHaveBeenCalled();
  });

  it.each([
    ['cameraHost', { cameraHost: '10.0.0.9' }],
    ['ndiSourceName', { ndiSourceName: 'CAM' }],
    ['bandwidth', { bandwidth: 'lowest' as const }],
    ['width', { width: 1920 }],
    ['height', { height: 1080 }],
    ['fps', { fps: 25 }],
    ['bitrateKbps', { bitrateKbps: 5000 }],
    ['encoderPref', { encoderPref: 'software' as const }],
  ])('replaces a stream when %s changed', async (_field, change) => {
    await registry.put(CONFIG);
    await registry.put({ ...CONFIG, ...change });

    expect(created).toHaveLength(2);
    expect(created[0].stop).toHaveBeenCalledTimes(1);
    expect(created[1].start).toHaveBeenCalledTimes(1);
    expect(registry.list()).toHaveLength(1);
  });

  describe('stream limit', () => {
    const idOf = (n: number): string => `7f1c2a52-7d3e-4c1a-9f0e-2b8d5a1c9e0${n}`;

    beforeEach(() => {
      registry = new StreamRegistry((config) => {
        const pipeline = new FakePipeline(config);
        created.push(pipeline);
        return pipeline;
      }, 2);
    });

    it('refuses a new id beyond the cap with 409 stream_limit', async () => {
      await registry.put({ ...CONFIG, streamId: idOf(1) });
      await registry.put({ ...CONFIG, streamId: idOf(2) });

      await expect(registry.put({ ...CONFIG, streamId: idOf(3) })).rejects.toMatchObject({
        status: 409,
        code: 'stream_limit',
      });
      expect(registry.list()).toHaveLength(2);
    });

    it('still replaces an existing id when the cap is reached', async () => {
      await registry.put({ ...CONFIG, streamId: idOf(1) });
      await registry.put({ ...CONFIG, streamId: idOf(2) });

      await registry.put({ ...CONFIG, streamId: idOf(2), fps: 25 });

      expect(registry.list()).toHaveLength(2);
      expect(created).toHaveLength(3);
    });

    it('frees a slot when a stream is removed', async () => {
      await registry.put({ ...CONFIG, streamId: idOf(1) });
      await registry.put({ ...CONFIG, streamId: idOf(2) });
      await registry.remove(idOf(1));

      await expect(registry.put({ ...CONFIG, streamId: idOf(3) })).resolves.toBeDefined();
    });
  });

  it('stops a removed stream and ignores unknown ids', async () => {
    await registry.put(CONFIG);

    await registry.remove(CONFIG.streamId);
    await registry.remove(CONFIG.streamId);

    expect(created[0].stop).toHaveBeenCalledTimes(1);
    expect(registry.list()).toEqual([]);
  });

  it('stops everything', async () => {
    await registry.put(CONFIG);
    await registry.put({ ...CONFIG, streamId: '7f1c2a52-7d3e-4c1a-9f0e-2b8d5a1c9e12' });

    await registry.stopAll();

    expect(created.every((pipeline) => pipeline.stop.mock.calls.length === 1)).toBe(true);
    expect(registry.list()).toEqual([]);
  });

  it('keeps working after a failing operation', async () => {
    await registry.put(CONFIG);
    created[0].stop.mockRejectedValueOnce(new Error('boom'));

    await expect(registry.remove(CONFIG.streamId)).rejects.toThrow('boom');
    await expect(registry.put(CONFIG)).resolves.toMatchObject({ streamId: CONFIG.streamId });
  });
});
