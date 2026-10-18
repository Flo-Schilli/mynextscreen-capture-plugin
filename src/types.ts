// SPDX-License-Identifier: Apache-2.0

/** Version of the control API (`/v1`). The agent rejects an unknown major version. */
export const API_VERSION = '1';

export type NdiBandwidthValue = 'lowest' | 'highest';
export type NdiEncoderPreferenceValue = 'auto' | 'software' | 'hardware';

export const NDI_BANDWIDTH_VALUES: readonly NdiBandwidthValue[] = ['lowest', 'highest'];
export const NDI_ENCODER_PREFERENCE_VALUES: readonly NdiEncoderPreferenceValue[] = [
  'auto',
  'software',
  'hardware',
];

/** What `PUT /v1/streams/:streamId` carries: one NDI camera turned into an HLS stream. */
export interface StreamConfig {
  /** IP handed to the NDI finder as an extra address; no mDNS discovery is used. */
  cameraHost: string;
  /** Exact NDI source name; null takes the first source found under `cameraHost`. */
  ndiSourceName: string | null;
  bandwidth: NdiBandwidthValue;
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  encoderPref: NdiEncoderPreferenceValue;
}

/** A stream config together with its id; the unit a pipeline works on. */
export interface PipelineConfig extends StreamConfig {
  streamId: string;
}

export type NdiStreamStateValue = 'connecting' | 'streaming' | 'error';

/** The only error texts a stream reports. Detail stays in the local log. */
export type NdiErrorCode =
  'source_not_found' | 'ffmpeg_exited' | 'no_frames' | 'resolution_changed' | 'internal_error';

export const NDI_STATUS_MAX_SOURCE_NAME = 200;
export const NDI_STATUS_MAX_ENCODER = 100;

/** Per-stream pipeline status. Never carries secrets. */
export interface StreamStatus {
  streamId: string;
  state: NdiStreamStateValue;
  sourceName: string | null;
  encoder: string | null;
  fps: number | null;
  framesDropped: number;
  error: NdiErrorCode | null;
}

export type PluginState = 'license_required' | 'ready' | 'error' | 'incompatible';

/** Machine-readable reason behind the `error` and `incompatible` states. */
export type PluginErrorCode =
  'unsupported_platform' | 'runtime_missing' | 'runtime_mismatch' | 'ndi_load_failed';

export interface LicenseRef {
  sdkVersion: string;
  licenseSha256: string;
}

export interface LicenseAcceptance extends LicenseRef {
  /** `api` = PUT /v1/license, `env` = MNS_CAPTURE_ACCEPT_NDI_LICENSE. */
  via: 'api' | 'env';
  acceptedAt: string;
}
