// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stream ids are UUIDs from the server; anything else never reaches a path or URL. */
export function isStreamId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Working directory of one stream. Throws for an id that is not a UUID. */
export function streamDir(baseDir: string, streamId: string): string {
  if (!isStreamId(streamId)) {
    throw new Error('Invalid stream id');
  }
  return join(baseDir, streamId.toLowerCase());
}
