// SPDX-License-Identifier: Apache-2.0
/**
 * better-sqlite3 is a native module built for one Node ABI. A release is packed with one Node version, but each
 * user runs their own (22, 24, a later one, and they upgrade it). Before the server starts, the CLI makes sure
 * the module matches the Node running it:
 *   1. the marker says it already matches → nothing to do
 *   2. it loads → write the marker
 *   3. a binary for this ABI shipped in the bundle (server/native/, see scripts/pack.mjs) → copy it in
 *   4. download the prebuilt binary (prebuild-install), then compile (npm rebuild) as the last resort
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { isWindows } from './layout.js';
import { CliError, info } from './ui.js';

const MODULE = 'better-sqlite3';

function isMusl(): boolean {
  if (process.platform !== 'linux') return false;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return !report?.header?.glibcVersionRuntime;
}

/** node-v137-darwin-arm64, node-v127-linuxmusl-x64: the naming of better-sqlite3's prebuilt binaries */
export function nativeKey(): string {
  const platform = isMusl() ? 'linuxmusl' : process.platform;
  return `node-v${process.versions.modules}-${platform}-${process.arch}`;
}

function loads(pkgDir: string): boolean {
  const code = `const D = require(${JSON.stringify(pkgDir)}); new D(':memory:').close()`;
  return spawnSync(process.execPath, ['-e', code], { stdio: 'ignore', timeout: 30_000 }).status === 0;
}

/** npm of the Node running us: the one on PATH may belong to another Node (nvm, system installs) */
function npmCli(): string[] {
  const dir = path.dirname(process.execPath);
  for (const cli of [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // macOS / Linux
  ])
    if (fs.existsSync(cli)) return [process.execPath, cli];
  return [isWindows ? 'npm.cmd' : 'npm'];
}

function run(cmd: string[], cwd: string): boolean {
  const res = spawnSync(cmd[0], cmd.slice(1), {
    cwd,
    stdio: 'ignore',
    shell: isWindows && cmd[0].endsWith('.cmd'),
    timeout: 10 * 60_000,
    // Scripts run by npm pick up this Node first
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  return res.status === 0;
}

/** Makes the bundle at `root` loadable by this Node. No-op in a git checkout (pnpm manages it there). */
export function ensureNative(root: string): void {
  if (!fs.existsSync(path.join(root, 'VERSION'))) return;
  const pkgDir = path.join(root, 'server', 'node_modules', MODULE);
  if (!fs.existsSync(pkgDir)) return;
  const releaseDir = path.join(pkgDir, 'build', 'Release');
  const binary = path.join(releaseDir, 'better_sqlite3.node');
  const marker = path.join(releaseDir, '.crewtree-node-abi');
  const key = nativeKey();
  const done = () => fs.writeFileSync(marker, `${key}\n`);
  try {
    if (fs.readFileSync(marker, 'utf8').trim() === key && fs.existsSync(binary)) return;
  } catch {
    // no marker yet
  }
  if (loads(pkgDir)) return done();

  const shipped = path.join(root, 'server', 'native', `better_sqlite3-${key}.node`);
  if (fs.existsSync(shipped)) {
    fs.mkdirSync(releaseDir, { recursive: true });
    const tmp = `${binary}.tmp`;
    fs.copyFileSync(shipped, tmp);
    fs.renameSync(tmp, binary);
    if (loads(pkgDir)) return done();
  }

  info(`Preparing the SQLite module for Node ${process.version} (one time)…`);
  const prebuild = path.join(root, 'server', 'node_modules', 'prebuild-install', 'bin.js');
  if (fs.existsSync(prebuild) && run([process.execPath, prebuild], pkgDir) && loads(pkgDir)) return done();
  if (run([...npmCli(), 'rebuild', MODULE, '--no-audit', '--no-fund'], path.join(root, 'server')) && loads(pkgDir))
    return done();
  throw new CliError(
    `The SQLite module could not be prepared for Node ${process.version} (${key})`,
    'Install Node 22 or 24 LTS from https://nodejs.org (or switch with nvm), then run crewtree again.'
  );
}
