// SPDX-License-Identifier: Apache-2.0
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger('main');

const FORCED_EXIT_MS = 8_000;

async function main(): Promise<void> {
  const app = await createApp(loadConfig());
  await app.start();

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info(`${signal} received, stopping`);
    // A pipeline stuck in the NDI library must not keep the container alive.
    setTimeout(() => {
      logger.error(`Shutdown took longer than ${FORCED_EXIT_MS} ms, exiting`);
      process.exit(1);
    }, FORCED_EXIT_MS).unref();
    app.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error(`Shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  logger.error(`Startup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
