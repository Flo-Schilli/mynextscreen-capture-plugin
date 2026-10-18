// SPDX-License-Identifier: Apache-2.0
import { jest } from '@jest/globals';
import {
  createGrandiBinding,
  parseSdkVersion,
  type GrandiLoader,
  type GrandiModule,
} from './grandi-binding.js';

function fakeGrandi(overrides: Partial<GrandiModule> = {}): GrandiModule {
  return {
    version: () => 'NDI SDK LINUX 12:51:52 Apr 13 2026 6.3.2.0',
    isSupportedCPU: () => true,
    initialize: () => true,
    find: async () => ({
      wait: async () => undefined,
      sources: () => [{ name: 'CAM' }],
      destroy: () => undefined,
    }),
    receive: async () => ({
      video: async () => ({
        data: Buffer.alloc(4),
        xres: 2,
        yres: 1,
        lineStrideBytes: 4,
        frameRateN: 30,
        frameRateD: 1,
        fourCC: 7,
      }),
      destroy: () => undefined,
    }),
    ColorFormat: { UYVY_BGRA: 0 },
    Bandwidth: { Lowest: 1, Highest: 2 },
    FourCC: { UYVY: 7 },
    ...overrides,
  };
}

const loaderFor = (grandi: GrandiModule): jest.Mock<GrandiLoader> =>
  jest.fn<GrandiLoader>().mockResolvedValue({ default: grandi });

describe('parseSdkVersion', () => {
  it.each([
    ['NDI SDK LINUX 12:51:52 Apr 13 2026 6.3.2.0', '6.3.2.0'],
    ['6.1.1', '6.1.1'],
    ['no version here', null],
  ])('reads %s', (banner, expected) => {
    expect(parseSdkVersion(banner)).toBe(expected);
  });
});

describe('createGrandiBinding', () => {
  it('does not touch grandi until it is used', () => {
    const loader = loaderFor(fakeGrandi());

    createGrandiBinding('6.3.2.0', loader);

    expect(loader).not.toHaveBeenCalled();
  });

  it('loads once and reports the SDK version', async () => {
    const loader = loaderFor(fakeGrandi());
    const binding = createGrandiBinding('6.3.2.0', loader);

    expect(await binding.load()).toBe('6.3.2.0');
    expect(await binding.load()).toBe('6.3.2.0');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unsupported CPU', { isSupportedCPU: () => false }],
    ['failed initialisation', { initialize: () => false }],
    ['another major version', { version: () => 'NDI SDK 7.0.0.0' }],
    ['another patch version', { version: () => 'NDI SDK 6.3.3.0' }],
    ['unreadable version', { version: () => 'garbage' }],
  ])('rejects on %s', async (_name, overrides) => {
    const binding = createGrandiBinding('6.3.2.0', loaderFor(fakeGrandi(overrides)));

    await expect(binding.load()).rejects.toThrow();
  });

  it('retries after a failed load', async () => {
    const loader = jest
      .fn<GrandiLoader>()
      .mockRejectedValueOnce(new Error('addon missing'))
      .mockResolvedValue({ default: fakeGrandi() });
    const binding = createGrandiBinding('6.3.2.0', loader);

    await expect(binding.load()).rejects.toThrow('addon missing');
    expect(await binding.load()).toBe('6.3.2.0');
  });

  it('finds sources by extra IP and passes them through untouched', async () => {
    const find = jest.fn<GrandiModule['find']>().mockResolvedValue({
      wait: async () => undefined,
      sources: () => [{ name: 'CAM' }],
      destroy: () => undefined,
    });
    const binding = createGrandiBinding('6.3.2.0', loaderFor(fakeGrandi({ find })));

    const finder = await binding.find('10.0.0.5');
    await finder.wait(10);

    expect(find).toHaveBeenCalledWith({ extraIPs: '10.0.0.5' });
    expect(finder.sources()).toEqual([{ name: 'CAM' }]);
    expect(() => finder.destroy()).not.toThrow();
  });

  it.each([
    ['lowest', 1],
    ['highest', 2],
  ] as const)('receives UYVY with %s bandwidth', async (bandwidth, expected) => {
    const receive = jest.fn<GrandiModule['receive']>(fakeGrandi().receive);
    const binding = createGrandiBinding('6.3.2.0', loaderFor(fakeGrandi({ receive })));

    const receiver = await binding.receive({ name: 'CAM' }, bandwidth);
    const frame = await receiver.video(100);

    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({ bandwidth: expected, allowVideoFields: false }),
    );
    expect(frame).toMatchObject({ xres: 2, isUyvy: true });
    expect(() => receiver.destroy()).not.toThrow();
  });

  it('flags frames in another pixel format', async () => {
    const binding = createGrandiBinding('6.3.2.0', loaderFor(fakeGrandi({ FourCC: { UYVY: 99 } })));

    const receiver = await binding.receive({ name: 'CAM' }, 'highest');

    expect((await receiver.video(100)).isUyvy).toBe(false);
  });
});
