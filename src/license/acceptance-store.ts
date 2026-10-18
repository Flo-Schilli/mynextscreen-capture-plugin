// SPDX-License-Identifier: Apache-2.0
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, type Logger } from '../logger.js';
import type { LicenseAcceptance } from '../types.js';
import { ensurePrivateDir } from '../pipeline/stream-directory.js';

export interface AcceptanceStore {
  read(): Promise<LicenseAcceptance | null>;
  write(acceptance: LicenseAcceptance): Promise<void>;
  clear(): Promise<void>;
}

const FILE_NAME = 'license-acceptance.json';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isAcceptance(value: unknown): value is LicenseAcceptance {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.sdkVersion === 'string' &&
    typeof record.licenseSha256 === 'string' &&
    SHA256_PATTERN.test(record.licenseSha256) &&
    (record.via === 'api' || record.via === 'env') &&
    typeof record.acceptedAt === 'string'
  );
}

/** Acceptance persisted as one JSON file (0600) in the private state directory. */
export class FileAcceptanceStore implements AcceptanceStore {
  private readonly path: string;

  constructor(
    private readonly dir: string,
    private readonly logger: Logger = createLogger('license'),
  ) {
    this.path = join(dir, FILE_NAME);
  }

  async read(): Promise<LicenseAcceptance | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isAcceptance(parsed)) {
        return parsed;
      }
    } catch {
      // fall through to the warning
    }
    this.logger.warn('Ignoring a corrupt license acceptance file');
    return null;
  }

  async write(acceptance: LicenseAcceptance): Promise<void> {
    await ensurePrivateDir(this.dir);
    const temp = `${this.path}.tmp`;
    await writeFile(temp, `${JSON.stringify(acceptance, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.path);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
