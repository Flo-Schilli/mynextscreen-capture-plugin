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
}

export interface App {
  service: PluginService;
  gate: LicenseGate;
  registry: StreamRegistry;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Runtime facts that can be absent without stopping the plugin: it then reports `error`. */
async function loadRuntime(config: Config, arch: string, logger: Logger) {
  let runtime: RuntimeInfo | null = null;
  try {
    const manifest = await loadManifest();
    runtime = await loadRuntimeInfo(resolveRuntimeDir(arch, config.runtimeDir), manifest);
  } catch (error) {
    logger.error(`NDI runtime unavailable: ${error instanceof Error ? error.message : error}`);
  }
  let pluginTerms: string | null = null;
  try {
    pluginTerms = await loadPluginTerms(config.noticePath);
  } catch (error) {
    logger.error(`Plugin terms unavailable: ${error instanceof Error ? error.message : error}`);
  }
  return { runtime, pluginTerms };
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
  const binding = overrides.binding ?? createGrandiBinding();
  const { runtime, pluginTerms } = await loadRuntime(config, arch, logger);

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
    pluginTerms,
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
