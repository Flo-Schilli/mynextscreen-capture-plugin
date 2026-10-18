// SPDX-License-Identifier: Apache-2.0
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StreamDirectory } from './ndi-pipeline.js';

/**
 * Creates a directory private (0o700) and refuses to use one that could be
 * planted by someone else: a symlink, a non-directory or a directory owned by
 * another user. Used for the socket, state and HLS base directories, which live
 * on volumes that other local users could otherwise pre-create.
 */
export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${path} is not a plain directory`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`${path} is owned by another user`);
  }
  if ((info.mode & 0o077) !== 0) {
    await chmod(path, 0o700);
  }
}

export const systemStreamDirectory: StreamDirectory = {
  prepare: async (dir) => {
    await ensurePrivateDir(dirname(dir));
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
  },
  remove: (dir) => rm(dir, { recursive: true, force: true }),
};
