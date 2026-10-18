// SPDX-License-Identifier: Apache-2.0
import type { NdiBandwidthValue } from '../types.js';

const BYTES_PER_PIXEL_UYVY = 2;
const FIND_TIMEOUT_MS = 10_000;
const FIND_POLL_MS = 500;

/** Raised when no matching NDI source answered at the camera address. */
export class NdiSourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NdiSourceNotFoundError';
  }
}

/** One video frame as the NDI SDK hands it over. */
export interface NdiRawFrame {
  data: Buffer;
  xres: number;
  yres: number;
  lineStrideBytes: number;
  frameRateN: number;
  frameRateD: number;
  isUyvy: boolean;
}

export interface NdiSourceInfo {
  name: string;
}

export interface NdiFinder {
  /** Waits up to `timeoutMs` for the source list to change. */
  wait(timeoutMs: number): Promise<void>;
  sources(): NdiSourceInfo[];
  destroy(): void;
}

export interface NdiRawReceiver {
  /** Rejects when no frame arrives within `timeoutMs`. */
  video(timeoutMs: number): Promise<NdiRawFrame>;
  destroy(): void;
}

/** The part of the native NDI binding the agent uses; the only seam to the addon. */
export interface NdiBinding {
  find(extraIp: string): Promise<NdiFinder>;
  receive(source: NdiSourceInfo, bandwidth: NdiBandwidthValue): Promise<NdiRawReceiver>;
}

/** A video frame with tightly packed UYVY data. */
export interface NdiFrame {
  data: Buffer;
  width: number;
  height: number;
  fps: number;
}

export interface NdiReceiver {
  readonly sourceName: string;
  /** The next UYVY frame; null when none arrived within the timeout or the frame was skipped. */
  nextFrame(timeoutMs: number): Promise<NdiFrame | null>;
  close(): void;
}

export interface NdiOpenRequest {
  cameraHost: string;
  ndiSourceName: string | null;
  bandwidth: NdiBandwidthValue;
}

export interface NdiReceiverFactory {
  open(request: NdiOpenRequest): Promise<NdiReceiver>;
}

/** The exact source when a name is given, otherwise the first one. */
export function pickSource(
  sources: readonly NdiSourceInfo[],
  sourceName: string | null,
): NdiSourceInfo | null {
  if (sourceName === null) {
    return sources[0] ?? null;
  }
  return sources.find((source) => source.name === sourceName) ?? null;
}

/** Returns tightly packed UYVY data; copies row by row when the NDI stride has padding. */
export function packFrame(frame: NdiRawFrame): Buffer {
  const rowBytes = frame.xres * BYTES_PER_PIXEL_UYVY;
  if (frame.lineStrideBytes === rowBytes) {
    return frame.data;
  }
  const packed = Buffer.allocUnsafe(rowBytes * frame.yres);
  for (let y = 0; y < frame.yres; y += 1) {
    const from = y * frame.lineStrideBytes;
    frame.data.copy(packed, y * rowBytes, from, from + rowBytes);
  }
  return packed;
}

class BindingReceiver implements NdiReceiver {
  constructor(
    readonly sourceName: string,
    private readonly raw: NdiRawReceiver,
  ) {}

  async nextFrame(timeoutMs: number): Promise<NdiFrame | null> {
    let frame: NdiRawFrame;
    try {
      frame = await this.raw.video(timeoutMs);
    } catch {
      return null;
    }
    if (!frame.isUyvy || frame.frameRateN <= 0 || frame.frameRateD <= 0) {
      return null;
    }
    return {
      data: packFrame(frame),
      width: frame.xres,
      height: frame.yres,
      fps: frame.frameRateN / frame.frameRateD,
    };
  }

  close(): void {
    this.raw.destroy();
  }
}

async function waitForSource(
  finder: NdiFinder,
  sourceName: string | null,
  timeoutMs: number,
): Promise<NdiSourceInfo | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await finder.wait(FIND_POLL_MS);
    const source = pickSource(finder.sources(), sourceName);
    if (source || Date.now() >= deadline) {
      return source;
    }
  }
}

/**
 * Finds the camera by address only (the finder is given the IP as an extra
 * address; no mDNS), then receives video. The finder is always destroyed, also
 * when nothing was found.
 */
export function createNdiReceiverFactory(
  binding: NdiBinding,
  findTimeoutMs = FIND_TIMEOUT_MS,
): NdiReceiverFactory {
  return {
    async open(request) {
      const finder = await binding.find(request.cameraHost);
      const source = await waitForSource(finder, request.ndiSourceName, findTimeoutMs).finally(() =>
        finder.destroy(),
      );
      if (!source) {
        throw new NdiSourceNotFoundError('NDI source not found at the camera address');
      }
      const raw = await binding.receive(source, request.bandwidth);
      return new BindingReceiver(source.name, raw);
    },
  };
}
