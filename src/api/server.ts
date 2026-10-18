// SPDX-License-Identifier: Apache-2.0
import { chmod, lstat, rm } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import { dirname } from 'node:path';
import { createLogger, type Logger } from '../logger.js';
import { ensurePrivateDir } from '../pipeline/stream-directory.js';

const REQUEST_TIMEOUT_MS = 10_000;
const HEADERS_TIMEOUT_MS = 5_000;

/** The control API on a unix socket. Filesystem permissions are the authentication. */
export class ControlServer {
  private readonly server: Server;

  constructor(
    private readonly socketPath: string,
    handler: RequestListener,
    private readonly logger: Logger = createLogger('api'),
  ) {
    this.server = createServer(handler);
    this.server.requestTimeout = REQUEST_TIMEOUT_MS;
    this.server.headersTimeout = HEADERS_TIMEOUT_MS;
  }

  async listen(): Promise<void> {
    await ensurePrivateDir(dirname(this.socketPath));
    await this.removeStaleSocket();
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    await chmod(this.socketPath, 0o600);
    this.logger.info(`Control API listening on ${this.socketPath}`);
  }

  async close(): Promise<void> {
    if (!this.server.listening) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  /** A socket left behind by a crash is replaced; anything else at the path is refused. */
  private async removeStaleSocket(): Promise<void> {
    let info;
    try {
      info = await lstat(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    if (!info.isSocket()) {
      throw new Error(`${this.socketPath} exists and is not a socket`);
    }
    await rm(this.socketPath);
  }
}
