// SPDX-License-Identifier: Apache-2.0
import { jest } from '@jest/globals';
import { ApiError } from '../errors.js';
import type { NdiRuntime } from '../pipeline/grandi-binding.js';
import type { LicenseAcceptance } from '../types.js';
import type { AcceptanceStore } from './acceptance-store.js';
import { LicenseGate, type LicenseGateDeps } from './license-gate.js';
import type { RuntimeInfo } from './runtime-info.js';

const SHA = 'c'.repeat(64);
const RUNTIME: RuntimeInfo = { sdkVersion: '6.3.2.0', licenseText: 'text', licenseSha256: SHA };
const REF = { sdkVersion: '6.3.2.0', licenseSha256: SHA };
const NOW = new Date('2026-10-18T10:00:00.000Z');

class MemoryStore implements AcceptanceStore {
  constructor(public value: LicenseAcceptance | null = null) {}
  read = jest.fn(async () => this.value);
  write = jest.fn(async (acceptance: LicenseAcceptance) => {
    this.value = acceptance;
  });
  clear = jest.fn(async () => {
    this.value = null;
  });
}

function build(overrides: Partial<LicenseGateDeps> = {}) {
  const store = new MemoryStore();
  const ndi = { load: jest.fn<NdiRuntime['load']>().mockResolvedValue('6.3.2.0') };
  const onRevoked = jest.fn(async () => undefined);
  const deps: LicenseGateDeps = {
    platform: { supported: true, devOverride: false },
    runtime: RUNTIME,
    store,
    ndi,
    envAcceptance: null,
    onRevoked,
    now: () => NOW,
    ...overrides,
  };
  return { gate: new LicenseGate(deps), store, ndi, onRevoked };
}

async function failureOf(task: () => unknown): Promise<ApiError> {
  try {
    await task();
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('expected a failure');
}

describe('LicenseGate', () => {
  it('starts in license_required without loading the runtime', async () => {
    const { gate, ndi } = build();

    await gate.start();

    expect(gate.snapshot()).toEqual({
      state: 'license_required',
      errorCode: null,
      acceptance: null,
    });
    expect(ndi.load).not.toHaveBeenCalled();
  });

  it('accepts a matching reference, persists it and loads the runtime', async () => {
    const { gate, store, ndi } = build();
    await gate.start();

    await gate.accept(REF);

    expect(gate.snapshot().state).toBe('ready');
    expect(store.value).toEqual({ ...REF, via: 'api', acceptedAt: NOW.toISOString() });
    expect(ndi.load).toHaveBeenCalledTimes(1);
  });

  it('refuses a reference that differs in hash or version', async () => {
    const { gate, store, ndi } = build();
    await gate.start();

    const hash = await failureOf(() => gate.accept({ ...REF, licenseSha256: 'd'.repeat(64) }));
    const version = await failureOf(() => gate.accept({ ...REF, sdkVersion: '6.4.0.0' }));

    expect([hash.code, version.code]).toEqual(['license_mismatch', 'license_mismatch']);
    expect(store.write).not.toHaveBeenCalled();
    expect(ndi.load).not.toHaveBeenCalled();
  });

  it('restores a persisted acceptance after a restart', async () => {
    const stored: LicenseAcceptance = { ...REF, via: 'api', acceptedAt: NOW.toISOString() };
    const { gate, ndi } = build({ store: new MemoryStore(stored) });

    await gate.start();

    expect(gate.snapshot()).toMatchObject({ state: 'ready', acceptance: stored });
    expect(ndi.load).toHaveBeenCalledTimes(1);
  });

  it('falls back to license_required when the shipped license text changed', async () => {
    const stale: LicenseAcceptance = {
      sdkVersion: '6.3.2.0',
      licenseSha256: 'e'.repeat(64),
      via: 'api',
      acceptedAt: NOW.toISOString(),
    };
    const { gate, ndi } = build({ store: new MemoryStore(stale) });

    await gate.start();

    expect(gate.snapshot().state).toBe('license_required');
    expect(ndi.load).not.toHaveBeenCalled();
  });

  describe('environment acceptance', () => {
    it('accepts when the variable holds the exact hash', async () => {
      const { gate, store } = build({ envAcceptance: SHA });

      await gate.start();

      expect(gate.snapshot()).toMatchObject({ state: 'ready', acceptance: { via: 'env' } });
      expect(store.write).not.toHaveBeenCalled();
    });

    it.each(['true', '1', 'd'.repeat(64)])('ignores the value %s', async (value) => {
      const { gate, ndi } = build({ envAcceptance: value });

      await gate.start();

      expect(gate.snapshot().state).toBe('license_required');
      expect(ndi.load).not.toHaveBeenCalled();
    });

    it('cannot be revoked through the API', async () => {
      const { gate } = build({ envAcceptance: SHA });
      await gate.start();

      const error = await failureOf(() => gate.revoke());

      expect(error.code).toBe('accepted_via_environment');
      expect(gate.snapshot().state).toBe('ready');
    });
  });

  it('revokes: clears the store, stops pipelines and requires the license again', async () => {
    const { gate, store, onRevoked } = build();
    await gate.start();
    await gate.accept(REF);

    await gate.revoke();

    expect(store.value).toBeNull();
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(gate.snapshot().state).toBe('license_required');
  });

  it('reports error when the runtime fails to load, and retries on the next acceptance', async () => {
    const { gate, ndi } = build();
    ndi.load.mockRejectedValueOnce(new Error('boom'));
    await gate.start();

    await gate.accept(REF);
    expect(gate.snapshot()).toMatchObject({ state: 'error', errorCode: 'ndi_load_failed' });

    await gate.accept(REF);
    expect(gate.snapshot().state).toBe('ready');
  });

  describe('assertReady', () => {
    it('passes when ready', async () => {
      const { gate } = build({ envAcceptance: SHA });
      await gate.start();

      expect(() => gate.assertReady()).not.toThrow();
    });

    it.each([
      ['license_required', {}, 'license_required'],
      ['incompatible', { platform: { supported: false, devOverride: false } }, 'incompatible'],
      ['runtime missing', { runtime: null }, 'plugin_error'],
    ])('answers 409 %s', async (_name, overrides, code) => {
      const { gate } = build(overrides);
      await gate.start();

      const error = await failureOf(() => gate.assertReady());

      expect(error).toMatchObject({ status: 409, code });
    });
  });

  describe('unusable plugin', () => {
    it('is incompatible on an unsupported platform and never loads the runtime', async () => {
      const { gate, ndi } = build({
        platform: { supported: false, devOverride: false },
        envAcceptance: SHA,
      });

      await gate.start();

      expect(gate.snapshot()).toEqual({
        state: 'incompatible',
        errorCode: 'unsupported_platform',
        acceptance: null,
      });
      expect(ndi.load).not.toHaveBeenCalled();
      expect((await failureOf(() => gate.accept(REF))).code).toBe('incompatible');
      expect((await failureOf(() => gate.revoke())).code).toBe('incompatible');
    });

    it('reports runtime_missing when the runtime package is absent', async () => {
      const { gate } = build({ runtime: null });

      await gate.start();

      expect(gate.snapshot()).toMatchObject({ state: 'error', errorCode: 'runtime_missing' });
      expect((await failureOf(() => gate.accept(REF))).code).toBe('plugin_error');
    });
  });
});
