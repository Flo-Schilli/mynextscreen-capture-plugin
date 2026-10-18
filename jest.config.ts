// SPDX-License-Identifier: Apache-2.0
import type { Config } from 'jest';

const config: Config = {
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: '<rootDir>/../tsconfig.json' }],
  },
  setupFiles: ['<rootDir>/../jest.setup.cjs'],
  testEnvironment: 'node',
  testTimeout: 30000,
  collectCoverageFrom: [
    '**/*.ts',
    '!**/*.spec.ts',
    '!**/testing/**',
    '!main.ts', // process bootstrap, exercised by the image smoke test
    '!healthcheck.ts', // container health probe, exercised by the image smoke test
  ],
  coverageDirectory: '../coverage',
  coverageThreshold: {
    global: { statements: 85, branches: 75, functions: 83, lines: 85 },
  },
};

export default config;
