// SPDX-License-Identifier: Apache-2.0
import { jest } from '@jest/globals';
import type { NdiRuntime } from '../pipeline/grandi-binding.js';
import type { NdiBinding, NdiRawFrame } from '../pipeline/ndi-receiver.js';

const WIDTH = 64;
const HEIGHT = 36;

/** A 64x36 UYVY frame; the content is irrelevant, FFmpeg is faked as well. */
export const fakeFrame = (): NdiRawFrame => ({
  data: Buffer.alloc(WIDTH * HEIGHT * 2),
  xres: WIDTH,
  yres: HEIGHT,
  lineStrideBytes: WIDTH * 2,
  frameRateN: 30,
  frameRateD: 1,
  isUyvy: true,
});

export interface FakeNdi extends NdiBinding, NdiRuntime {
  load: jest.Mock<NdiRuntime['load']>;
}

/** An NDI binding that finds one source `CAM` and delivers frames at ~100 fps. */
export function fakeNdi(): FakeNdi {
  return {
    load: jest.fn<NdiRuntime['load']>().mockResolvedValue('6.3.2.0'),
    find: async () => ({
      wait: async () => undefined,
      sources: () => [{ name: 'CAM' }],
      destroy: () => undefined,
    }),
    receive: async () => ({
      video: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return fakeFrame();
      },
      destroy: () => undefined,
    }),
  };
}
