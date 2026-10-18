// SPDX-License-Identifier: Apache-2.0
import { jest } from '@jest/globals';
import { checkPlatform } from './platform.js';

const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

describe('checkPlatform', () => {
  beforeEach(() => jest.clearAllMocks());

  it('supports x86-64 Linux without a warning', () => {
    expect(checkPlatform('x64', 'linux', false, logger)).toEqual({
      supported: true,
      devOverride: false,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('refuses arm64 by default', () => {
    expect(checkPlatform('arm64', 'linux', false, logger).supported).toBe(false);
  });

  it('allows arm64 for development with a loud warning', () => {
    expect(checkPlatform('arm64', 'linux', true, logger)).toEqual({
      supported: true,
      devOverride: true,
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('development'));
  });

  it('never supports another operating system, override or not', () => {
    expect(checkPlatform('x64', 'darwin', true, logger).supported).toBe(false);
  });
});
