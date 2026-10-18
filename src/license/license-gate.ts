// SPDX-License-Identifier: Apache-2.0
import { ApiError } from '../errors.js';
import { createLogger, type Logger } from '../logger.js';
import type { NdiRuntime } from '../pipeline/grandi-binding.js';
import type { LicenseAcceptance, LicenseRef, PluginErrorCode, PluginState } from '../types.js';
import type { AcceptanceStore } from './acceptance-store.js';
import type { PlatformVerdict } from './platform.js';
import type { RuntimeInfo } from './runtime-info.js';

export interface GateSnapshot {
  state: PluginState;
  errorCode: PluginErrorCode | null;
  /** The acceptance in force; null while the license is required. */
  acceptance: LicenseAcceptance | null;
}

export interface LicenseGateDeps {
  platform: PlatformVerdict;
  /** Null when the runtime package or its license text is missing. */
  runtime: RuntimeInfo | null;
  store: AcceptanceStore;
  ndi: NdiRuntime;
  /** Value of MNS_CAPTURE_ACCEPT_NDI_LICENSE, or null. */
  envAcceptance: string | null;
  /** Stops all pipelines when the license is revoked. */
  onRevoked: () => Promise<void>;
  logger?: Logger;
  now?: () => Date;
}

/**
 * The license gate. Until an acceptance whose hash equals the hash of the
 * license text that ships with the runtime is present, the plugin does not
 * load grandi and refuses to start pipelines. A new runtime with a changed
 * license text invalidates every earlier acceptance by construction.
 */
export class LicenseGate {
  private readonly logger: Logger;
  private readonly now: () => Date;
  private acceptance: LicenseAcceptance | null = null;
  private loadFailed = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: LicenseGateDeps) {
    this.logger = deps.logger ?? createLogger('license');
    this.now = deps.now ?? (() => new Date());
  }

  /** Restores a persisted or environment acceptance; loads the runtime when one is valid. */
  async start(): Promise<void> {
    const { runtime, platform } = this.deps;
    if (!platform.supported || !runtime) {
      return;
    }
    this.acceptance = await this.restoreAcceptance(runtime);
    if (this.acceptance) {
      await this.activate();
    }
  }

  snapshot(): GateSnapshot {
    const { platform, runtime } = this.deps;
    if (!platform.supported) {
      return { state: 'incompatible', errorCode: 'unsupported_platform', acceptance: null };
    }
    if (!runtime) {
      return { state: 'error', errorCode: 'runtime_missing', acceptance: null };
    }
    if (!this.acceptance) {
      return { state: 'license_required', errorCode: null, acceptance: null };
    }
    if (this.loadFailed) {
      return { state: 'error', errorCode: 'ndi_load_failed', acceptance: this.acceptance };
    }
    return { state: 'ready', errorCode: null, acceptance: this.acceptance };
  }

  /** Throws the 409 an operation needing the runtime gets while the plugin is not ready. */
  assertReady(): void {
    const { state } = this.snapshot();
    if (state === 'ready') {
      return;
    }
    const failure = {
      license_required: [
        'license_required',
        'The NDI SDK license has not been accepted for this runtime version',
      ],
      incompatible: ['incompatible', 'This platform is not supported (x86-64 Linux only)'],
      error: ['plugin_error', 'The NDI runtime is not usable, see the plugin status'],
    } as const;
    const [code, message] = failure[state];
    throw new ApiError(409, code, message);
  }

  /** Accepts exactly the license text this runtime ships; anything else is refused. */
  accept(ref: LicenseRef): Promise<void> {
    return this.serialised(async () => {
      this.assertCanChange();
      const runtime = this.deps.runtime as RuntimeInfo;
      if (ref.sdkVersion !== runtime.sdkVersion || ref.licenseSha256 !== runtime.licenseSha256) {
        throw new ApiError(
          409,
          'license_mismatch',
          'sdkVersion or licenseSha256 does not match the license text this plugin ships',
        );
      }
      const acceptance: LicenseAcceptance = {
        ...ref,
        via: 'api',
        acceptedAt: this.now().toISOString(),
      };
      await this.deps.store.write(acceptance);
      this.acceptance = acceptance;
      this.logger.info(`NDI license accepted via API (sha256 ${ref.licenseSha256})`);
      await this.activate();
    });
  }

  /** Withdraws the acceptance and stops all pipelines. */
  revoke(): Promise<void> {
    return this.serialised(async () => {
      this.assertCanChange();
      if (this.acceptance?.via === 'env') {
        throw new ApiError(
          409,
          'accepted_via_environment',
          'The license was accepted through MNS_CAPTURE_ACCEPT_NDI_LICENSE; remove the variable and restart',
        );
      }
      await this.deps.store.clear();
      this.acceptance = null;
      this.loadFailed = false;
      this.logger.info('NDI license acceptance revoked');
      await this.deps.onRevoked();
    });
  }

  private assertCanChange(): void {
    const { platform, runtime } = this.deps;
    if (!platform.supported) {
      throw new ApiError(409, 'incompatible', 'This platform is not supported (x86-64 Linux only)');
    }
    if (!runtime) {
      throw new ApiError(409, 'plugin_error', 'The NDI runtime or its license text is missing');
    }
  }

  private async restoreAcceptance(runtime: RuntimeInfo): Promise<LicenseAcceptance | null> {
    const { envAcceptance, store } = this.deps;
    if (envAcceptance !== null) {
      if (envAcceptance === runtime.licenseSha256) {
        this.logger.info('NDI license accepted via MNS_CAPTURE_ACCEPT_NDI_LICENSE');
        return {
          sdkVersion: runtime.sdkVersion,
          licenseSha256: runtime.licenseSha256,
          via: 'env',
          acceptedAt: this.now().toISOString(),
        };
      }
      this.logger.warn(
        'MNS_CAPTURE_ACCEPT_NDI_LICENSE does not match the shipped license text and is ignored',
      );
    }
    const stored = await store.read();
    if (
      stored &&
      stored.licenseSha256 === runtime.licenseSha256 &&
      stored.sdkVersion === runtime.sdkVersion
    ) {
      return stored;
    }
    if (stored) {
      this.logger.warn('The stored license acceptance is for another license text; it is ignored');
    }
    return null;
  }

  /** Loads grandi after an acceptance; a failure puts the plugin into `error`. */
  private async activate(): Promise<void> {
    try {
      const version = await this.deps.ndi.load();
      this.loadFailed = false;
      this.logger.info(`NDI runtime loaded (${version})`);
    } catch (error) {
      this.loadFailed = true;
      this.logger.error(
        `NDI runtime failed to load: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private serialised<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
