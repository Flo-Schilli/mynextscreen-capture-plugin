// SPDX-License-Identifier: Apache-2.0
import type {
  NdiBinding,
  NdiFinder,
  NdiRawFrame,
  NdiRawReceiver,
  NdiSourceInfo,
} from './ndi-receiver.js';

/**
 * The slice of the `grandi` module the plugin touches. Declared here instead
 * of imported: the package carries a native addon that loads eagerly, and
 * neither the build nor the specs may pull it in.
 */
export interface GrandiModule {
  version(): string;
  isSupportedCPU(): boolean;
  initialize(): boolean;
  find(options: { extraIPs?: string; showLocalSources?: boolean }): Promise<{
    wait(timeoutMs: number): Promise<unknown>;
    sources(): Array<{ name: string }>;
    destroy(): void;
  }>;
  receive(options: {
    source: { name: string };
    colorFormat: number;
    bandwidth: number;
    allowVideoFields: boolean;
  }): Promise<{
    video(timeoutMs: number): Promise<{
      data: Buffer;
      xres: number;
      yres: number;
      lineStrideBytes: number;
      frameRateN: number;
      frameRateD: number;
      fourCC: number;
    }>;
    destroy(): void;
  }>;
  ColorFormat: { UYVY_BGRA: number };
  Bandwidth: { Lowest: number; Highest: number };
  FourCC: { UYVY: number };
}

/** Seam that the specs replace; the only place that names the `grandi` module. */
export type GrandiLoader = () => Promise<{ default: GrandiModule }>;

const importGrandi: GrandiLoader = () =>
  import('grandi') as unknown as Promise<{ default: GrandiModule }>;

/** The NDI runtime as the license gate sees it: load once, report the library version. */
export interface NdiRuntime {
  /** Loads the addon and the NDI library. Rejects when the runtime cannot be used. */
  load(): Promise<string>;
}

export class NdiRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NdiRuntimeError';
  }
}

const SUPPORTED_MAJOR = 6;

/** Last dotted number in `NDI SDK LINUX 12:51:52 Apr 13 2026 6.3.2.0`. */
export function parseSdkVersion(banner: string): string | null {
  const matches = banner.match(/\d+(?:\.\d+){2,3}/g);
  return matches?.at(-1) ?? null;
}

/**
 * Loads grandi on first use, so a plugin that has not been licensed never
 * touches the addon or the NDI library.
 */
export function createGrandiBinding(load: GrandiLoader = importGrandi): NdiBinding & NdiRuntime {
  let loading: Promise<GrandiModule> | null = null;

  const loadModule = (): Promise<GrandiModule> => {
    loading ??= load()
      .then(({ default: grandi }) => {
        if (!grandi.isSupportedCPU()) {
          throw new NdiRuntimeError('NDI is not supported on this CPU');
        }
        if (!grandi.initialize()) {
          throw new NdiRuntimeError('NDI runtime failed to initialise');
        }
        const version = parseSdkVersion(grandi.version());
        if (version === null || Number(version.split('.')[0]) !== SUPPORTED_MAJOR) {
          throw new NdiRuntimeError(`Unsupported NDI runtime version: ${grandi.version()}`);
        }
        return grandi;
      })
      .catch((error: unknown) => {
        loading = null; // allow a retry after a transient failure
        throw error;
      });
    return loading;
  };

  return {
    async load(): Promise<string> {
      const grandi = await loadModule();
      return parseSdkVersion(grandi.version()) ?? 'unknown';
    },

    async find(extraIp: string): Promise<NdiFinder> {
      const grandi = await loadModule();
      const finder = await grandi.find({ extraIPs: extraIp });
      return {
        wait: async (timeoutMs) => {
          await finder.wait(timeoutMs);
        },
        // Handed through untouched: `receive` needs the address fields the SDK
        // attached to each source, not just the name.
        sources: (): NdiSourceInfo[] => finder.sources(),
        destroy: () => finder.destroy(),
      };
    },

    async receive(source, bandwidth): Promise<NdiRawReceiver> {
      const grandi = await loadModule();
      const receiver = await grandi.receive({
        source,
        colorFormat: grandi.ColorFormat.UYVY_BGRA,
        bandwidth: bandwidth === 'lowest' ? grandi.Bandwidth.Lowest : grandi.Bandwidth.Highest,
        allowVideoFields: false,
      });
      return {
        video: async (timeoutMs): Promise<NdiRawFrame> => {
          const frame = await receiver.video(timeoutMs);
          return { ...frame, isUyvy: frame.fourCC === grandi.FourCC.UYVY };
        },
        destroy: () => receiver.destroy(),
      };
    },
  };
}
