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

export interface PluginStatus {
  apiVersion: string;
  pluginVersion: string;
  state: PluginState;
  errorCode: PluginErrorCode | null;
  sdkVersion: string | null;
  /** The license text this runtime ships; what an acceptance must quote. */
  license: LicenseRef | null;
  /** The acceptance in force, null while the license is required. */
  acceptance: LicenseAcceptance | null;
  arch: string;
  encoders: string[];
}

export interface LicenseText extends LicenseRef {
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
  pluginTerms: string | null;
  pluginVersion: string;
  arch: string;
  probe: DeviceProbe;
}

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
      license: runtime
        ? { sdkVersion: runtime.sdkVersion, licenseSha256: runtime.licenseSha256 }
        : null,
      acceptance,
      arch,
      encoders: availableEncoders(arch, probe),
    };
  }

  licenseText(): LicenseText {
    const { runtime, pluginTerms } = this.deps;
    if (!runtime || pluginTerms === null) {
      throw new ApiError(409, 'plugin_error', 'The license text or the plugin terms are missing');
    }
    return {
      sdkVersion: runtime.sdkVersion,
      licenseSha256: runtime.licenseSha256,
      licenseText: runtime.licenseText,
      pluginTerms,
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
