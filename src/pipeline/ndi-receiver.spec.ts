// SPDX-License-Identifier: Apache-2.0
import { jest } from '@jest/globals';
import {
  createNdiReceiverFactory,
  NdiSourceNotFoundError,
  packFrame,
  pickSource,
  type NdiBinding,
  type NdiFinder,
  type NdiRawFrame,
  type NdiRawReceiver,
} from './ndi-receiver.js';

function rawFrame(overrides: Partial<NdiRawFrame> = {}): NdiRawFrame {
  return {
    data: Buffer.alloc(4 * 2 * 2),
    xres: 4,
    yres: 2,
    lineStrideBytes: 8,
    frameRateN: 30000,
    frameRateD: 1001,
    isUyvy: true,
    ...overrides,
  };
}

describe('pickSource', () => {
  const sources = [{ name: 'A (cam1)' }, { name: 'B (cam2)' }];

  it('takes the first source without a name', () => {
    expect(pickSource(sources, null)).toBe(sources[0]);
  });

  it('matches the name exactly', () => {
    expect(pickSource(sources, 'B (cam2)')).toBe(sources[1]);
    expect(pickSource(sources, 'cam2')).toBeNull();
  });

  it('finds nothing in an empty list', () => {
    expect(pickSource([], null)).toBeNull();
  });
});

describe('packFrame', () => {
  it('returns tightly packed data untouched', () => {
    const frame = rawFrame();

    expect(packFrame(frame)).toBe(frame.data);
  });

  it('strips row padding', () => {
    const data = Buffer.from([1, 2, 3, 4, 0, 0, 5, 6, 7, 8, 0, 0]);

    const packed = packFrame(rawFrame({ data, xres: 2, yres: 2, lineStrideBytes: 6 }));

    expect([...packed]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('createNdiReceiverFactory', () => {
  let finder: jest.Mocked<NdiFinder>;
  let raw: jest.Mocked<NdiRawReceiver>;
  let binding: jest.Mocked<NdiBinding>;
  const request = {
    cameraHost: '192.168.1.60',
    ndiSourceName: null,
    bandwidth: 'highest' as const,
  };

  beforeEach(() => {
    finder = {
      wait: jest.fn<NdiFinder['wait']>().mockResolvedValue(undefined),
      sources: jest.fn<NdiFinder['sources']>(),
      destroy: jest.fn<NdiFinder['destroy']>(),
    };
    raw = {
      video: jest.fn<NdiRawReceiver['video']>(),
      destroy: jest.fn<NdiRawReceiver['destroy']>(),
    };
    binding = {
      find: jest.fn<NdiBinding['find']>().mockResolvedValue(finder),
      receive: jest.fn<NdiBinding['receive']>().mockResolvedValue(raw),
    };
  });

  it('looks only at the camera address and receives with the contract bandwidth', async () => {
    finder.sources.mockReturnValue([{ name: 'CAM' }]);

    const receiver = await createNdiReceiverFactory(binding).open({
      ...request,
      bandwidth: 'lowest',
    });

    expect(binding.find).toHaveBeenCalledWith('192.168.1.60');
    expect(binding.receive).toHaveBeenCalledWith({ name: 'CAM' }, 'lowest');
    expect(receiver.sourceName).toBe('CAM');
    expect(finder.destroy).toHaveBeenCalledTimes(1);
  });

  it('waits for a named source to show up', async () => {
    finder.sources
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ name: 'OTHER' }])
      .mockReturnValue([{ name: 'OTHER' }, { name: 'WANTED' }]);

    const receiver = await createNdiReceiverFactory(binding).open({
      ...request,
      ndiSourceName: 'WANTED',
    });

    expect(receiver.sourceName).toBe('WANTED');
    expect(finder.wait).toHaveBeenCalledTimes(3);
  });

  it('gives up with a clear error and still destroys the finder', async () => {
    finder.sources.mockReturnValue([]);

    await expect(createNdiReceiverFactory(binding, 0).open(request)).rejects.toBeInstanceOf(
      NdiSourceNotFoundError,
    );
    expect(finder.destroy).toHaveBeenCalledTimes(1);
    expect(binding.receive).not.toHaveBeenCalled();
  });

  it('stops waiting for a source as soon as the signal is aborted', async () => {
    finder.sources.mockReturnValue([]);
    const controller = new AbortController();
    finder.wait.mockImplementation(async () => controller.abort());

    await expect(
      createNdiReceiverFactory(binding, 60_000).open(request, controller.signal),
    ).rejects.toBeInstanceOf(NdiSourceNotFoundError);
    expect(finder.wait).toHaveBeenCalledTimes(1);
    expect(finder.destroy).toHaveBeenCalledTimes(1);
  });

  describe('receiver', () => {
    async function open() {
      finder.sources.mockReturnValue([{ name: 'CAM' }]);
      return createNdiReceiverFactory(binding).open(request);
    }

    it('delivers packed frames with the frame rate as a number', async () => {
      raw.video.mockResolvedValue(rawFrame());

      const frame = await (await open()).nextFrame(1000);

      expect(frame).toMatchObject({ width: 4, height: 2 });
      expect(frame?.fps).toBeCloseTo(29.97, 2);
    });

    it('returns null on a timeout', async () => {
      raw.video.mockRejectedValue(new Error('timeout'));

      expect(await (await open()).nextFrame(1000)).toBeNull();
    });

    it.each([
      ['a non-UYVY frame', { isUyvy: false }],
      ['a frame without a rate', { frameRateN: 0 }],
      ['a frame with a zero denominator', { frameRateD: 0 }],
    ])('skips %s', async (_label, overrides) => {
      raw.video.mockResolvedValue(rawFrame(overrides));

      expect(await (await open()).nextFrame(1000)).toBeNull();
    });

    it('closes the native receiver', async () => {
      (await open()).close();

      expect(raw.destroy).toHaveBeenCalled();
    });
  });
});
