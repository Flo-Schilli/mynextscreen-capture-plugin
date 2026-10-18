// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LicenseAcceptance } from '../types.js';
import { FileAcceptanceStore } from './acceptance-store.js';

const ACCEPTANCE: LicenseAcceptance = {
  sdkVersion: '6.3.2.0',
  licenseSha256: 'a'.repeat(64),
  via: 'api',
  acceptedAt: '2026-10-18T10:00:00.000Z',
};

describe('FileAcceptanceStore', () => {
  let dir: string;
  let store: FileAcceptanceStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mns-store-'));
    store = new FileAcceptanceStore(join(dir, 'state'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null before anything was stored', async () => {
    expect(await store.read()).toBeNull();
  });

  it('round-trips an acceptance in a private file', async () => {
    await store.write(ACCEPTANCE);

    expect(await store.read()).toEqual(ACCEPTANCE);
    expect((await stat(join(dir, 'state'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'state', 'license-acceptance.json'))).mode & 0o777).toBe(0o600);
  });

  it('clears the acceptance and tolerates clearing twice', async () => {
    await store.write(ACCEPTANCE);

    await store.clear();
    await store.clear();

    expect(await store.read()).toBeNull();
  });

  it.each(['not json', '{"sdkVersion":"6.3.2.0"}', JSON.stringify({ ...ACCEPTANCE, via: 'x' })])(
    'ignores a corrupt file (%s)',
    async (content) => {
      await store.write(ACCEPTANCE);
      await writeFile(join(dir, 'state', 'license-acceptance.json'), content);

      expect(await store.read()).toBeNull();
    },
  );

  it('rethrows read errors other than a missing file', async () => {
    await store.write(ACCEPTANCE);
    const broken = new FileAcceptanceStore(join(dir, 'state', 'license-acceptance.json'));

    await expect(broken.read()).rejects.toThrow();
  });

  it('leaves no temp file behind', async () => {
    await store.write(ACCEPTANCE);

    await expect(readFile(join(dir, 'state', 'license-acceptance.json.tmp'))).rejects.toThrow();
  });
});
