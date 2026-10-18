// SPDX-License-Identifier: Apache-2.0
import { createLogger, type Logger } from '../logger.js';

export interface PlatformVerdict {
  supported: boolean;
  /** True when an unsupported arch is allowed through the dev override. */
  devOverride: boolean;
}

/**
 * Production scope is x86-64 general-purpose Linux (NDI SDK License clause 1b
 * excludes locked appliances and embedded hardware). Other architectures run
 * only with `MNS_CAPTURE_DEV_ALLOW_ARM=1`, for internal development tests.
 */
export function checkPlatform(
  arch: string,
  platform: string,
  allowDev: boolean,
  logger: Logger = createLogger('platform'),
): PlatformVerdict {
  if (platform !== 'linux') {
    return { supported: false, devOverride: false };
  }
  if (arch === 'x64') {
    return { supported: true, devOverride: false };
  }
  if (allowDev) {
    logger.warn(
      `Running on ${arch} because MNS_CAPTURE_DEV_ALLOW_ARM=1 is set. This is for development ` +
        'tests only and not a supported production platform (x86-64 general-purpose Linux only).',
    );
    return { supported: true, devOverride: true };
  }
  return { supported: false, devOverride: false };
}
