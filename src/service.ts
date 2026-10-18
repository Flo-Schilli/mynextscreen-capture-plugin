// SPDX-License-Identifier: Apache-2.0
import { ApiError } from './errors.js';
import type { LicenseGate } from './license/license-gate.js';
import type { RuntimeInfo } from './license/runtime-info.js';
import { availableEncoders, type DeviceProbe } from './pipeline/ndi-encoder.js';
import type { StreamRegistry } from './streams/stream-registry.js';
import {
  API_VERSION,
  type LicenseAcceptance,
  type LicenseRef,
  type PluginErrorCode,
  type PluginState,
  type StreamConfig,
  type StreamStatus,
} from './types.js';

/** What exactly an acceptance covers. */
export interface LicenseInfo extends LicenseRef {
  /** SHA-256 of the NDI SDK license text that ships with the runtime. */
  ndiLicenseSha256: string;
  /** SHA-256 of the plugin terms (`NOTICE`). */
  termsSha256: string;
}

export interface PluginStatus {
  apiVersion: string;
  pluginVersion: string;
  state: PluginState;
  errorCode: PluginErrorCode | null;
  sdkVersion: string | null;
  /**
   * What an acceptance must quote. `licenseSha256` is
   * `sha256(ndiLicenseSha256 + "\n" + termsSha256)`; null when the runtime is missing.
   */
  license: LicenseInfo | null;
  /** The acceptance in force, null while the license is required. */
  acceptance: LicenseAcceptance | null;
  arch: string;
  encoders: string[];
}

export interface LicenseText extends LicenseInfo {
  licenseText: string;
  pluginTerms: string;
}

/** What the HTTP layer calls; the contract in `openapi.json` is exactly this surface. */
export interface ControlApi {
  status(): PluginStatus;
  licenseText(): LicenseText;
  acceptLicense(ref: LicenseRef): Promise<PluginStatus>;
  revokeLicense(): Promise<PluginStatus>;
  putStream(streamId: string, config: StreamConfig): Promise<StreamStatus>;
  deleteStream(streamId: string): Promise<void>;
  listStreams(): StreamStatus[];
}

export interface PluginServiceDeps {
  gate: LicenseGate;
  registry: StreamRegistry;
  runtime: RuntimeInfo | null;
  pluginVersion: string;
  arch: string;
  probe: DeviceProbe;
}

const licenseInfo = (runtime: RuntimeInfo): LicenseInfo => ({
  sdkVersion: runtime.sdkVersion,
  licenseSha256: runtime.licenseSha256,
  ndiLicenseSha256: runtime.ndiLicenseSha256,
  termsSha256: runtime.termsSha256,
});

export class PluginService implements ControlApi {
  constructor(private readonly deps: PluginServiceDeps) {}

  status(): PluginStatus {
    const { runtime, pluginVersion, arch, probe } = this.deps;
    const { state, errorCode, acceptance } = this.deps.gate.snapshot();
    return {
      apiVersion: API_VERSION,
      pluginVersion,
      state,
      errorCode,
      sdkVersion: runtime?.sdkVersion ?? null,
      license: runtime ? licenseInfo(runtime) : null,
      acceptance,
      arch,
      encoders: availableEncoders(arch, probe),
    };
  }

  licenseText(): LicenseText {
    const { runtime } = this.deps;
    if (!runtime) {
      throw new ApiError(409, 'plugin_error', 'The license text or the plugin terms are missing');
    }
    return {
      ...licenseInfo(runtime),
      licenseText: runtime.licenseText,
      pluginTerms: runtime.pluginTerms,
    };
  }

  async acceptLicense(ref: LicenseRef): Promise<PluginStatus> {
    await this.deps.gate.accept(ref);
    return this.status();
  }

  async revokeLicense(): Promise<PluginStatus> {
    await this.deps.gate.revoke();
    return this.status();
  }

  putStream(streamId: string, config: StreamConfig): Promise<StreamStatus> {
    this.deps.gate.assertReady();
    return this.deps.registry.put({ ...config, streamId });
  }

  deleteStream(streamId: string): Promise<void> {
    return this.deps.registry.remove(streamId);
  }

  listStreams(): StreamStatus[] {
    return this.deps.registry.list();
  }
}
