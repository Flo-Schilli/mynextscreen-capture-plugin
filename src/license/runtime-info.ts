// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { PACKAGE_ROOT } from '../paths.js';

/** Pinned facts about the bundled NDI runtime; `ndi-runtime.json` in the package root. */
export interface RuntimeManifest {
  grandiVersion: string;
  /** NDI SDK version the bundled libndi comes from. */
  sdkVersion: string;
  libndiSha256: string;
  licenseSha256: string;
}

export interface RuntimeInfo {
  sdkVersion: string;
  /** Exact text of the NDI SDK license that ships with the runtime. */
  licenseText: string;
  /** SHA-256 over the bytes of `licenseText`; what an acceptance must quote. */
  licenseSha256: string;
}

export class RuntimeMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeMissingError';
  }
}

export const sha256Hex = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

export async function loadManifest(root = PACKAGE_ROOT): Promise<RuntimeManifest> {
  return JSON.parse(await readFile(join(root, 'ndi-runtime.json'), 'utf8')) as RuntimeManifest;
}

/** Directory of the `@grandi/linux-<arch>` package that holds `libndi.so.6` and the license. */
export function resolveRuntimeDir(arch: string, override: string | null): string {
  if (override) {
    return override;
  }
  const packageName = `@grandi/linux-${arch}`;
  try {
    return dirname(createRequire(import.meta.url).resolve(`${packageName}/package.json`));
  } catch {
    throw new RuntimeMissingError(`NDI runtime package ${packageName} is not installed`);
  }
}

/** Reads the license text shipped next to the runtime and hashes it. */
export async function loadRuntimeInfo(
  runtimeDir: string,
  manifest: RuntimeManifest,
): Promise<RuntimeInfo> {
  let licenseBytes: Buffer;
  try {
    licenseBytes = await readFile(join(runtimeDir, 'LICENSE'));
  } catch {
    throw new RuntimeMissingError('NDI license text is missing next to the runtime');
  }
  return {
    sdkVersion: manifest.sdkVersion,
    licenseText: licenseBytes.toString('utf8'),
    licenseSha256: sha256Hex(licenseBytes),
  };
}

const TERMS_LOCATIONS = ['/usr/share/licenses/capture-plugin/NOTICE', join(PACKAGE_ROOT, 'NOTICE')];

/** The plugin terms (`NOTICE`): from the image location, else the checkout. */
export async function loadPluginTerms(override: string | null = null): Promise<string> {
  for (const path of override ? [override] : TERMS_LOCATIONS) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      // try the next location
    }
  }
  throw new RuntimeMissingError('Plugin terms (NOTICE) are missing');
}
