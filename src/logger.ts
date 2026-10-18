// SPDX-License-Identifier: Apache-2.0

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

function threshold(): number {
  const configured = process.env.MNS_CAPTURE_LOG_LEVEL?.toLowerCase();
  if (configured === 'silent') {
    return Number.POSITIVE_INFINITY;
  }
  return LEVEL_ORDER[configured as Level] ?? LEVEL_ORDER.info;
}

/** Minimal line logger: `<iso time> <LEVEL> [scope] message`, errors and warnings on stderr. */
export function createLogger(scope: string): Logger {
  const write = (level: Level, message: string): void => {
    if (LEVEL_ORDER[level] < threshold()) {
      return;
    }
    const line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${message}\n`;
    (LEVEL_ORDER[level] >= LEVEL_ORDER.warn ? process.stderr : process.stdout).write(line);
  };
  return {
    debug: (message) => write('debug', message),
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  };
}
