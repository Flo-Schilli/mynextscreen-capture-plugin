// SPDX-License-Identifier: Apache-2.0
import { isStreamId, streamDir } from './stream-id.js';

const ID = '6F1C2A52-7d3e-4c1a-9f0e-2b8d5a1c9e11';

describe('stream ids', () => {
  it('accepts UUIDs', () => {
    expect(isStreamId(ID)).toBe(true);
  });

  it.each(['', '../etc', 'abc', `${ID}/..`, `${ID}x`, '6f1c2a52-7d3e-4c1a-9f0e'])(
    'rejects %p',
    (value) => {
      expect(isStreamId(value)).toBe(false);
    },
  );

  it('builds a lower-case directory under the base', () => {
    expect(streamDir('/base', ID)).toBe(`/base/${ID.toLowerCase()}`);
  });

  it('refuses to build a path from anything else', () => {
    expect(() => streamDir('/base', '../x')).toThrow('Invalid stream id');
  });
});
