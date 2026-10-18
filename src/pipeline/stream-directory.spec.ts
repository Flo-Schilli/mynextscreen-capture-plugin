// SPDX-License-Identifier: Apache-2.0
import { jest } from '@jest/globals';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemDeviceProbe } from './ndi-encoder.js';
import { ensurePrivateDir, systemStreamDirectory } from './stream-directory.js';

describe('stream directory', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mns-seam-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('prepares an empty stream directory and removes it again', async () => {
    const dir = join(root, 'stream');
    await systemStreamDirectory.prepare(dir);
    await writeFile(join(dir, 'old.ts'), 'x');

    await systemStreamDirectory.prepare(dir);

    expect((await stat(dir)).isDirectory()).toBe(true);
    await expect(stat(join(dir, 'old.ts'))).rejects.toThrow();

    await systemStreamDirectory.remove(dir);
    await expect(stat(dir)).rejects.toThrow();
  });

  describe('ensurePrivateDir', () => {
    it('creates the directory private', async () => {
      const base = join(root, 'base');

      await ensurePrivateDir(base);

      expect((await stat(base)).mode & 0o777).toBe(0o700);
    });

    it('tightens a directory that is readable by others', async () => {
      const base = join(root, 'loose');
      await mkdir(base, { mode: 0o755 });
      await chmod(base, 0o755);

      await ensurePrivateDir(base);

      expect((await stat(base)).mode & 0o777).toBe(0o700);
    });

    it('refuses a symlink, even one that points at a directory', async () => {
      const target = join(root, 'target');
      await mkdir(target);
      const link = join(root, 'link');
      await symlink(target, link);

      await expect(ensurePrivateDir(link)).rejects.toThrow('not a plain directory');
    });

    it('refuses a directory owned by another user', async () => {
      const base = join(root, 'foreign');
      await mkdir(base);
      const getuid = jest.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1);

      await expect(ensurePrivateDir(base)).rejects.toThrow('owned by another user');
      getuid.mockRestore();
    });

    it('is used when preparing a stream directory', async () => {
      const link = join(root, 'linked-base');
      await symlink(root, link);

      await expect(systemStreamDirectory.prepare(join(link, 'stream'))).rejects.toThrow(
        'not a plain directory',
      );
    });
  });

  it('probes devices without throwing', () => {
    expect(systemDeviceProbe.exists('/definitely/not/here')).toBe(false);
    expect(typeof systemDeviceProbe.hasVideoDevices()).toBe('boolean');
  });
});
