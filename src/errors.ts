// SPDX-License-Identifier: Apache-2.0

/** Machine-readable error codes of the control API; documented in `openapi.json`. */
export type ApiErrorCode =
  | 'invalid_request'
  | 'invalid_json'
  | 'invalid_stream_id'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'not_found'
  | 'method_not_allowed'
  | 'license_required'
  | 'license_mismatch'
  | 'accepted_via_environment'
  | 'plugin_error'
  | 'incompatible'
  | 'internal_error';

/** A failure that maps to an HTTP status and a stable error body. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
