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
  /** Exact text of the plugin terms (`NOTICE`). */
  pluginTerms: string;
  ndiLicenseSha256: string;
  termsSha256: string;
  /**
   * What an acceptance must quote: `sha256(ndiLicenseSha256 + "\n" + termsSha256)`,
   * both hashes as lower-case hex. A change in either text invalidates every
   * earlier acceptance.
   */
  licenseSha256: string;
  /** False when `libndi.so.6` is missing or differs from the pinned build. */
  libraryVerified: boolean;
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

export const acceptanceHash = (ndiLicenseSha256: string, termsSha256: string): string =>
  sha256Hex(`${ndiLicenseSha256}\n${termsSha256}`);

/**
 * Reads the NDI license text shipped next to the runtime, hashes it together
 * with the plugin terms and, unless `verifyLibrary` is false, checks that
 * `libndi.so.6` is the pinned build.
 */
export async function loadRuntimeInfo(
  runtimeDir: string,
  manifest: RuntimeManifest,
  pluginTerms: string,
  verifyLibrary = true,
): Promise<RuntimeInfo> {
  let licenseBytes: Buffer;
  try {
    licenseBytes = await readFile(join(runtimeDir, 'LICENSE'));
  } catch {
    throw new RuntimeMissingError('NDI license text is missing next to the runtime');
  }
  const ndiLicenseSha256 = sha256Hex(licenseBytes);
  const termsSha256 = sha256Hex(pluginTerms);
  return {
    sdkVersion: manifest.sdkVersion,
    licenseText: licenseBytes.toString('utf8'),
    pluginTerms,
    ndiLicenseSha256,
    termsSha256,
    licenseSha256: acceptanceHash(ndiLicenseSha256, termsSha256),
    libraryVerified: !verifyLibrary || (await libraryMatches(runtimeDir, manifest)),
  };
}

async function libraryMatches(runtimeDir: string, manifest: RuntimeManifest): Promise<boolean> {
  try {
    return sha256Hex(await readFile(join(runtimeDir, 'libndi.so.6'))) === manifest.libndiSha256;
  } catch {
    return false;
  }
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
