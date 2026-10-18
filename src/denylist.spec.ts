// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PACKAGE_ROOT } from './paths.js';

/** The CI denylist for NDI SDK material, run against throw-away git repositories. */
describe('scripts/denylist.sh', () => {
  let repo: string;

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

  const run = (...args: string[]): { ok: boolean; output: string } => {
    try {
      const output = execFileSync('bash', ['scripts/denylist.sh', ...args], {
        cwd: repo,
        encoding: 'utf8',
      });
      return { ok: true, output };
    } catch (error) {
      return { ok: false, output: String((error as { stdout?: string }).stdout ?? '') };
    }
  };

  const add = (path: string, content = 'x'): void => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
    git('add', '-A');
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'mns-deny-'));
    git('init', '-q');
    git('config', 'user.email', 'ci@example.invalid');
    git('config', 'user.name', 'ci');
    git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(repo, 'scripts'));
    copyFileSync(join(PACKAGE_ROOT, 'scripts/denylist.sh'), join(repo, 'scripts/denylist.sh'));
    add('src/index.ts', 'export {};');
    git('commit', '-q', '-m', 'base');
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('passes for a clean tree', () => {
    expect(run().ok).toBe(true);
  });

  it.each([
    'libndi.so.6',
    'lib/libndi_licenses.txt',
    ['include/Processing', 'NDI.Lib.h'].join('.'),
    'NDI SDK/readme.txt',
    'NDI 6 SDK/lib/x.so',
    'NDI6SDK/notes.txt',
    'vendor/NDI_SDK/x',
    'vendor/ndi-sdk/x',
    'Install_NDI_SDK_v6_Linux.tar.gz',
  ])('rejects %s in the tree', (path) => {
    add(path);

    const result = run();

    expect(result.ok).toBe(false);
    expect(result.output).toContain('NDI SDK material found');
  });

  it('rejects SDK header symbols in file content', () => {
    add('src/native.c', ['NDIlib', 'send_create_t'].join('_') + ' settings;');

    expect(run().ok).toBe(false);
  });

  it('does not flag unrelated names that merely contain "ndi"', () => {
    add('docs/handling-index.md');
    add('src/windings.ts');

    expect(run().ok).toBe(true);
  });

  it('catches a file that a pull request added and removed again', () => {
    git('commit', '-q', '-m', 'unrelated', '--allow-empty');
    const base = git('rev-parse', 'HEAD').trim();
    add('NDI 6 SDK/lib.so');
    git('commit', '-q', '-m', 'add');
    git('rm', '-q', '-r', '-f', 'NDI 6 SDK');
    git('commit', '-q', '-m', 'remove');

    expect(run().ok).toBe(true); // the tree is clean again
    expect(run(base).ok).toBe(false); // the PR commits are not
  });
});
