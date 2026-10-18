// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadManifest,
  loadPluginTerms,
  acceptanceHash,
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

  const manifestFor = async (libndi: string | null) => ({
    ...(await loadManifest()),
    libndiSha256: sha256Hex(libndi ?? ''),
  });

  it('hashes the exact bytes of the license text and covers the plugin terms', async () => {
    await writeFile(join(dir, 'LICENSE'), 'NDI SDK License Agreement\r\n');
    const manifest = await loadManifest();

    const info = await loadRuntimeInfo(dir, manifest, 'terms v1', false);

    expect(info.licenseText).toBe('NDI SDK License Agreement\r\n');
    expect(info.pluginTerms).toBe('terms v1');
    expect(info.ndiLicenseSha256).toBe(sha256Hex(Buffer.from('NDI SDK License Agreement\r\n')));
    expect(info.termsSha256).toBe(sha256Hex('terms v1'));
    expect(info.licenseSha256).toBe(acceptanceHash(info.ndiLicenseSha256, info.termsSha256));
    expect(info.sdkVersion).toBe(manifest.sdkVersion);
  });

  it('changes the acceptance hash when either text changes', async () => {
    await writeFile(join(dir, 'LICENSE'), 'license');
    const manifest = await loadManifest();

    const base = await loadRuntimeInfo(dir, manifest, 'terms', false);
    const otherTerms = await loadRuntimeInfo(dir, manifest, 'terms changed', false);
    await writeFile(join(dir, 'LICENSE'), 'license changed');
    const otherLicense = await loadRuntimeInfo(dir, manifest, 'terms', false);

    expect(
      new Set([base.licenseSha256, otherTerms.licenseSha256, otherLicense.licenseSha256]).size,
    ).toBe(3);
  });

  it('fails when the license text is missing', async () => {
    await expect(loadRuntimeInfo(dir, await loadManifest(), 'terms')).rejects.toBeInstanceOf(
      RuntimeMissingError,
    );
  });

  it('verifies libndi.so.6 against the pinned sha256', async () => {
    await writeFile(join(dir, 'LICENSE'), 'license');
    await writeFile(join(dir, 'libndi.so.6'), 'the pinned build');

    const ok = await loadRuntimeInfo(dir, await manifestFor('the pinned build'), 'terms');
    const wrong = await loadRuntimeInfo(dir, await manifestFor('another build'), 'terms');

    expect([ok.libraryVerified, wrong.libraryVerified]).toEqual([true, false]);
  });

  it('treats a missing libndi.so.6 as unverified, and skips the check on request', async () => {
    await writeFile(join(dir, 'LICENSE'), 'license');
    const manifest = await manifestFor('x');

    expect((await loadRuntimeInfo(dir, manifest, 'terms')).libraryVerified).toBe(false);
    expect((await loadRuntimeInfo(dir, manifest, 'terms', false)).libraryVerified).toBe(true);
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
