// SPDX-License-Identifier: Apache-2.0
import { isIP } from 'node:net';
import { ApiError } from '../errors.js';
import {
  NDI_BANDWIDTH_VALUES,
  NDI_ENCODER_PREFERENCE_VALUES,
  type LicenseRef,
  type StreamConfig,
} from '../types.js';

export const LIMITS = {
  width: { min: 16, max: 7680 },
  height: { min: 16, max: 4320 },
  fps: { min: 1, max: 120 },
  bitrateKbps: { min: 100, max: 50_000 },
  sourceNameMaxLength: 200,
} as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SDK_VERSION_PATTERN = /^\d+(?:\.\d+){1,3}$/;

const invalid = (message: string): ApiError => new ApiError(400, 'invalid_request', message);

type Fields = Record<string, unknown>;

/** A plain JSON object with exactly the allowed keys, all of them required. */
function exactObject(body: unknown, allowed: readonly string[]): Fields {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid('Body must be a JSON object');
  }
  const fields = body as Fields;
  const unknown = Object.keys(fields).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw invalid(`Unknown field: ${unknown.slice(0, 3).join(', ')}`);
  }
  const missing = allowed.filter((key) => !(key in fields));
  if (missing.length > 0) {
    throw invalid(`Missing field: ${missing.join(', ')}`);
  }
  return fields;
}

function integerInRange(fields: Fields, key: string, min: number, max: number): number {
  const value = fields[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function oneOf<T extends string>(fields: Fields, key: string, values: readonly T[]): T {
  const value = fields[key];
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw invalid(`${key} must be one of: ${values.join(', ')}`);
  }
  return value as T;
}

const STREAM_FIELDS = [
  'cameraHost',
  'ndiSourceName',
  'bandwidth',
  'width',
  'height',
  'fps',
  'bitrateKbps',
  'encoderPref',
] as const;

/** Validates the body of `PUT /v1/streams/:streamId`. Unknown fields are rejected. */
export function parseStreamConfig(body: unknown): StreamConfig {
  const fields = exactObject(body, STREAM_FIELDS);
  const { cameraHost, ndiSourceName } = fields;
  if (typeof cameraHost !== 'string' || isIP(cameraHost) === 0) {
    throw invalid('cameraHost must be an IPv4 or IPv6 address');
  }
  if (
    ndiSourceName !== null &&
    (typeof ndiSourceName !== 'string' ||
      ndiSourceName.length === 0 ||
      ndiSourceName.length > LIMITS.sourceNameMaxLength)
  ) {
    throw invalid(`ndiSourceName must be null or a string of 1 to ${LIMITS.sourceNameMaxLength}`);
  }
  return {
    cameraHost,
    ndiSourceName,
    bandwidth: oneOf(fields, 'bandwidth', NDI_BANDWIDTH_VALUES),
    width: integerInRange(fields, 'width', LIMITS.width.min, LIMITS.width.max),
    height: integerInRange(fields, 'height', LIMITS.height.min, LIMITS.height.max),
    fps: integerInRange(fields, 'fps', LIMITS.fps.min, LIMITS.fps.max),
    bitrateKbps: integerInRange(
      fields,
      'bitrateKbps',
      LIMITS.bitrateKbps.min,
      LIMITS.bitrateKbps.max,
    ),
    encoderPref: oneOf(fields, 'encoderPref', NDI_ENCODER_PREFERENCE_VALUES),
  };
}

/** Validates the body of `PUT /v1/license`. */
export function parseLicenseRef(body: unknown): LicenseRef {
  const fields = exactObject(body, ['sdkVersion', 'licenseSha256']);
  const { sdkVersion, licenseSha256 } = fields;
  if (typeof sdkVersion !== 'string' || !SDK_VERSION_PATTERN.test(sdkVersion)) {
    throw invalid('sdkVersion must be a dotted version such as 6.3.2.0');
  }
  if (typeof licenseSha256 !== 'string' || !SHA256_PATTERN.test(licenseSha256)) {
    throw invalid('licenseSha256 must be 64 lowercase hex characters');
  }
  return { sdkVersion, licenseSha256 };
}
