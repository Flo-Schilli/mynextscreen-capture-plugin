// SPDX-License-Identifier: Apache-2.0
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlServer } from './server.js';

const handler = (_req: unknown, res: { end(body: string): void }): void => res.end('ok');

function get(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    request({ socketPath, path: '/' }, (res) => {
      let text = '';
      res.on('data', (chunk: Buffer) => (text += chunk.toString()));
      res.on('end', () => resolve(text));
    })
      .on('error', reject)
      .end();
  });
}

describe('ControlServer', () => {
  let dir: string;
  let server: ControlServer | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mns-srv-'));
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the socket directory 0700 and the socket 0600 and serves requests', async () => {
    const socket = join(dir, 'run', 'plugin.sock');
    server = new ControlServer(socket, handler);

    await server.listen();

    expect((await stat(join(dir, 'run'))).mode & 0o777).toBe(0o700);
    expect((await stat(socket)).mode & 0o777).toBe(0o600);
    expect(await get(socket)).toBe('ok');
  });

  it('replaces a stale socket left by a crash', async () => {
    const socket = join(dir, 'plugin.sock');
    const first = new ControlServer(socket, handler);
    await first.listen();
    // Simulate a crash: the file stays, nobody listens.
    await (first as unknown as { server: { close(): void } }).server.close();
    server = new ControlServer(socket, handler);

    await server.listen();

    expect(await get(socket)).toBe('ok');
  });

  it('refuses a path that is not a socket', async () => {
    const socket = join(dir, 'plugin.sock');
    await writeFile(socket, 'precious');
    server = new ControlServer(socket, handler);

    await expect(server.listen()).rejects.toThrow('not a socket');
  });

  it('refuses a symlinked socket directory', async () => {
    const real = join(dir, 'real');
    await mkdir(real);
    await chmod(real, 0o700);
    await symlink(real, join(dir, 'link'));
    server = new ControlServer(join(dir, 'link', 'plugin.sock'), handler);

    await expect(server.listen()).rejects.toThrow('not a plain directory');
  });

  it('closes without error when it never listened', async () => {
    server = new ControlServer(join(dir, 'x.sock'), handler);

    await expect(server.close()).resolves.toBeUndefined();
  });
});
