// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadManifest,
  loadPluginTerms,
  loadRuntimeInfo,
  resolveRuntimeDir,
  RuntimeMissingError,
  sha256Hex,
} from './runtime-info.js';

describe('runtime info', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mns-rt-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('hashes the exact bytes of the license text', async () => {
    await writeFile(join(dir, 'LICENSE'), 'NDI SDK License Agreement\r\n');
    const manifest = await loadManifest();

    const info = await loadRuntimeInfo(dir, manifest);

    expect(info.licenseText).toBe('NDI SDK License Agreement\r\n');
    expect(info.licenseSha256).toBe(sha256Hex(Buffer.from('NDI SDK License Agreement\r\n')));
    expect(info.sdkVersion).toBe(manifest.sdkVersion);
  });

  it('fails when the license text is missing', async () => {
    await expect(loadRuntimeInfo(dir, await loadManifest())).rejects.toBeInstanceOf(
      RuntimeMissingError,
    );
  });

  it('uses the override directory as is', () => {
    expect(resolveRuntimeDir('x64', '/somewhere')).toBe('/somewhere');
  });

  it('resolves the installed grandi runtime package for the host architecture', () => {
    expect(resolveRuntimeDir(process.arch, null)).toMatch(/@grandi\/linux-(x64|arm64)$/);
  });

  it('reports a missing runtime package for an unknown architecture', () => {
    expect(() => resolveRuntimeDir('riscv64', null)).toThrow(RuntimeMissingError);
  });

  describe('plugin terms', () => {
    it('reads the override file', async () => {
      await writeFile(join(dir, 'NOTICE'), 'terms');

      expect(await loadPluginTerms(join(dir, 'NOTICE'))).toBe('terms');
    });

    it('falls back to the NOTICE of the checkout', async () => {
      expect(await loadPluginTerms()).toContain('NDI');
    });

    it('fails when an override does not exist', async () => {
      await expect(loadPluginTerms(join(dir, 'missing'))).rejects.toBeInstanceOf(
        RuntimeMissingError,
      );
    });
  });
});
