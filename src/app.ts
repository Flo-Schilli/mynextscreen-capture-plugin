// SPDX-License-Identifier: Apache-2.0
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequestHandler } from './api/router.js';
import { ControlServer } from './api/server.js';
import type { Config } from './config.js';
import { LicenseGate } from './license/license-gate.js';
import { FileAcceptanceStore, type AcceptanceStore } from './license/acceptance-store.js';
import { checkPlatform } from './license/platform.js';
import {
  loadManifest,
  loadPluginTerms,
  loadRuntimeInfo,
  resolveRuntimeDir,
  type RuntimeInfo,
  type RuntimeManifest,
} from './license/runtime-info.js';
import { createLogger, type Logger } from './logger.js';
import { createGrandiBinding, type NdiRuntime } from './pipeline/grandi-binding.js';
import { systemDeviceProbe, type DeviceProbe } from './pipeline/ndi-encoder.js';
import { DEFAULT_BACKOFF, NdiPipeline } from './pipeline/ndi-pipeline.js';
import { createNdiReceiverFactory, type NdiBinding } from './pipeline/ndi-receiver.js';
import { systemFfmpegSpawner, type FfmpegSpawner } from './pipeline/ndi-transcoder.js';
import { ensurePrivateDir, systemStreamDirectory } from './pipeline/stream-directory.js';
import { streamDir } from './pipeline/stream-id.js';
import { PluginService } from './service.js';
import { StreamRegistry } from './streams/stream-registry.js';

/** Seams for tests and development; production uses the defaults. */
export interface AppOverrides {
  binding?: NdiBinding & NdiRuntime;
  spawner?: FfmpegSpawner;
  probe?: DeviceProbe;
  store?: AcceptanceStore;
  arch?: string;
  platform?: string;
  logger?: Logger;
  /** Test seam: use this runtime directory without the dev flag. */
  runtimeDir?: string;
  /** Test seam: verify `libndi.so.6` even for a runtime directory override. */
  verifyRuntime?: boolean;
}

export interface App {
  service: PluginService;
  gate: LicenseGate;
  registry: StreamRegistry;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The directory of the NDI runtime package. An override (`MNS_CAPTURE_RUNTIME_DIR`)
 * is honored only together with the dev flag; the library is then not checked
 * against the pinned build.
 */
function runtimeOverride(config: Config, overrides: AppOverrides, logger: Logger): string | null {
  if (overrides.runtimeDir) {
    return overrides.runtimeDir;
  }
  if (!config.runtimeDir) {
    return null;
  }
  if (!config.devAllowArm) {
    logger.warn('MNS_CAPTURE_RUNTIME_DIR is ignored without MNS_CAPTURE_DEV_ALLOW_ARM=1');
    return null;
  }
  logger.warn(
    `Using the NDI runtime from ${config.runtimeDir} (development override, not verified)`,
  );
  return config.runtimeDir;
}

/**
 * Runtime facts that can be absent without stopping the plugin: it then reports
 * `error`. The plugin terms are part of what an acceptance covers, so without
 * them there is no runtime info either.
 */
async function loadRuntime(
  config: Config,
  overrides: AppOverrides,
  arch: string,
  logger: Logger,
): Promise<{ manifest: RuntimeManifest | null; runtime: RuntimeInfo | null }> {
  let manifest: RuntimeManifest | null = null;
  try {
    manifest = await loadManifest();
    const dir = runtimeOverride(config, overrides, logger);
    const terms = await loadPluginTerms(config.noticePath);
    const verify = dir === null || overrides.verifyRuntime === true;
    const runtime = await loadRuntimeInfo(resolveRuntimeDir(arch, dir), manifest, terms, verify);
    return { manifest, runtime };
  } catch (error) {
    logger.error(`NDI runtime unavailable: ${error instanceof Error ? error.message : error}`);
    return { manifest, runtime: null };
  }
}

async function clearChildren(dir: string): Promise<void> {
  for (const entry of await readdir(dir)) {
    await rm(join(dir, entry), { recursive: true, force: true });
  }
}

export async function createApp(config: Config, overrides: AppOverrides = {}): Promise<App> {
  const logger = overrides.logger ?? createLogger('plugin');
  const arch = overrides.arch ?? process.arch;
  const probe = overrides.probe ?? systemDeviceProbe;
  const { manifest, runtime } = await loadRuntime(config, overrides, arch, logger);
  const binding = overrides.binding ?? createGrandiBinding(manifest?.sdkVersion ?? '');

  const registry = new StreamRegistry(
    (pipelineConfig) =>
      new NdiPipeline(pipelineConfig, {
        receivers: createNdiReceiverFactory(binding),
        directory: systemStreamDirectory,
        dir: streamDir(config.hlsDir, pipelineConfig.streamId),
        settings: {
          ffmpegPath: config.ffmpegPath,
          encoderOverride: config.encoderOverride,
          arch,
          backoff: DEFAULT_BACKOFF,
        },
        spawner: overrides.spawner ?? systemFfmpegSpawner,
        probe,
      }),
    config.maxStreams,
  );

  const gate = new LicenseGate({
    platform: checkPlatform(arch, overrides.platform ?? process.platform, config.devAllowArm),
    runtime,
    store: overrides.store ?? new FileAcceptanceStore(config.stateDir),
    ndi: binding,
    envAcceptance: config.acceptNdiLicense,
    onRevoked: () => registry.stopAll(),
  });

  const service = new PluginService({
    gate,
    registry,
    runtime,
    pluginVersion: config.pluginVersion,
    arch,
    probe,
  });
  const server = new ControlServer(config.socketPath, createRequestHandler(service));

  return {
    service,
    gate,
    registry,
    async start() {
      await ensurePrivateDir(config.stateDir);
      await ensurePrivateDir(config.hlsDir);
      await clearChildren(config.hlsDir); // leftovers of a crashed run
      await gate.start();
      await server.listen();
      logger.info(
        `mynextscreen capture plugin ${config.pluginVersion} is up (${gate.snapshot().state})`,
      );
    },
    async stop() {
      await server.close();
      await registry.stopAll();
    },
  };
}
