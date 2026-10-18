// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadManifest, resolveRuntimeDir, sha256Hex } from './license/runtime-info.js';

/**
 * Pins the bundled NDI runtime. When grandi is bumped this fails until
 * `ndi-runtime.json` is updated on purpose: a changed license text changes the
 * hash every acceptance is bound to, and CI checks the image against this file.
 */
describe('ndi-runtime.json', () => {
  const runtimeDir = resolveRuntimeDir('x64', null);

  it('pins the installed grandi version', async () => {
    const grandi = JSON.parse(
      readFileSync(join(runtimeDir, '..', '..', 'grandi', 'package.json'), 'utf8'),
    ) as { version: string };

    expect((await loadManifest()).grandiVersion).toBe(grandi.version);
  });

  it('pins the sha256 of the license text that ships with the runtime', async () => {
    const hash = sha256Hex(readFileSync(join(runtimeDir, 'LICENSE')));

    expect((await loadManifest()).licenseSha256).toBe(hash);
  });

  it('pins the sha256 of libndi.so.6', async () => {
    const hash = sha256Hex(readFileSync(join(runtimeDir, 'libndi.so.6')));

    expect((await loadManifest()).libndiSha256).toBe(hash);
  });
});
