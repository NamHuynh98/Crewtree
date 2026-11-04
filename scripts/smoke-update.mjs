#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Release smoke test of `crewtree update` → `crewtree rollback` with a test migration, and `autostart on/off`
 * (PLAN.md 18: installer / update). Runs after the installer smoke test on each release runner:
 *   1. builds a "next" bundle from the packed one (patch + 1) with an extra migration, archive + SHA256SUMS
 *   2. `crewtree update --archive` → the migration ran (checked with the bundle's own better-sqlite3)
 *   3. `crewtree rollback` → previous version and its pre-migration database are back, the server starts
 *   4. `crewtree autostart on/off` → launchd plist / Task Scheduler entry created and removed
 *
 * Usage: node scripts/smoke-update.mjs   (after scripts/pack.mjs and the installer)
 *        node scripts/smoke-update.mjs --start-only   start/stop the installed version on this Node (another
 *        Node major than the bundle was packed with: better-sqlite3 must switch to its binary, apps/cli/src/native.ts)
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const home = os.homedir();
const crewtreeDir = path.join(home, '.crewtree');
const appDir = path.join(crewtreeDir, 'app');
const bin = isWindows ? path.join(crewtreeDir, 'bin', 'crewtree.cmd') : path.join(home, '.local', 'bin', 'crewtree');

function step(msg) {
  console.log(`\n▸ ${msg}`);
}
function fail(msg) {
  console.error(`✕ ${msg}`);
  const log = path.join(crewtreeDir, 'logs', 'server.log');
  if (fs.existsSync(log)) console.error(fs.readFileSync(log, 'utf8').split('\n').slice(-40).join('\n'));
  process.exit(1);
}
function crewtree(...args) {
  const res = spawnSync(isWindows ? `"${bin}"` : bin, args, {
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env, NO_COLOR: '1', CREWTREE_NO_UPDATE_CHECK: '1' },
  });
  return res.status ?? 1;
}
function versions() {
  return JSON.parse(fs.readFileSync(path.join(appDir, 'versions.json'), 'utf8'));
}
function tables() {
  // The installed bundle's native module matches this Node: no extra install needed
  const require = createRequire(path.join(appDir, 'current', 'server', 'package.json'));
  const Database = require('better-sqlite3');
  const db = new Database(path.join(crewtreeDir, 'crewtree.db'), { readonly: true });
  try {
    return db
      .prepare("select name from sqlite_master where type = 'table'")
      .all()
      .map((r) => r.name);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- 0. --start-only
if (process.argv.includes('--start-only')) {
  step(`Starting the installed version on Node ${process.version} (ABI ${process.versions.modules})`);
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'crewtree-smoke-node-')));
  if (crewtree('--no-open') !== 0) fail('Server did not start on this Node');
  if (crewtree('status') !== 0) fail('status');
  crewtree('stop');
  const marker = path.join(
    appDir,
    'current',
    'server',
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    '.crewtree-node-abi'
  );
  const key = fs.readFileSync(marker, 'utf8').trim();
  if (!key.startsWith(`node-v${process.versions.modules}-`)) fail(`better-sqlite3 marker is ${key}`);
  console.log(`\n✓ runs on Node ${process.version} (${key})`);
  process.exit(0);
}

// ---------------------------------------------------------------- 1. next bundle with a migration
const outRoot = path.join(root, 'dist-release');
const packed = fs
  .readdirSync(outRoot)
  .find((f) => f.startsWith('crewtree-v') && fs.statSync(path.join(outRoot, f)).isDirectory());
if (!packed) fail('No packed bundle in dist-release (run scripts/pack.mjs first)');
const m = /^crewtree-v(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?-([a-z0-9]+)-([a-z0-9]+)$/.exec(packed);
if (!m) fail(`Unexpected bundle name ${packed}`);
const current = fs.readFileSync(path.join(outRoot, packed, 'VERSION'), 'utf8').trim();
const next = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
const nextName = `crewtree-v${next}-${m[4]}-${m[5]}`;

step(`Building ${nextName} with a test migration`);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crewtree-smoke-'));
const nextDir = path.join(work, nextName);
fs.cpSync(path.join(outRoot, packed), nextDir, { recursive: true });
fs.writeFileSync(path.join(nextDir, 'VERSION'), `${next}\n`);
const bundlePkg = path.join(nextDir, 'package.json');
fs.writeFileSync(
  bundlePkg,
  JSON.stringify({ ...JSON.parse(fs.readFileSync(bundlePkg, 'utf8')), version: next }, null, 2)
);
const drizzle = path.join(nextDir, 'server', 'drizzle');
const journalFile = path.join(drizzle, 'meta', '_journal.json');
const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
const idx = journal.entries.length;
const tag = `${String(idx).padStart(4, '0')}_smoke_probe`;
fs.writeFileSync(path.join(drizzle, `${tag}.sql`), 'CREATE TABLE `smoke_probe` (`id` integer PRIMARY KEY NOT NULL);\n');
journal.entries.push({ idx, version: '6', when: Date.now(), tag, breakpoints: true });
fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2));

const archive = path.join(work, `${nextName}.${isWindows ? 'zip' : 'tar.gz'}`);
if (isWindows)
  execFileSync('pwsh', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${nextDir}' -DestinationPath '${archive}' -CompressionLevel Fastest`,
  ]);
else execFileSync('tar', ['-czf', archive, '-C', work, nextName]);
const sum = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
fs.writeFileSync(path.join(work, 'SHA256SUMS'), `${sum}  ${path.basename(archive)}\n`);

// ---------------------------------------------------------------- 2. update
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'crewtree-smoke-project-'));
process.chdir(project);
step('Seeding data with the installed version');
if (crewtree('--no-open') !== 0) fail('Server did not start');
crewtree('stop');
if (tables().includes('smoke_probe')) fail('smoke_probe exists before the update');

step(`crewtree update --archive → v${next}`);
if (crewtree('update', '--archive', archive) !== 0) fail('update failed');
if (versions().current !== `v${next}`) fail(`versions.json: ${JSON.stringify(versions())}`);
if (!tables().includes('smoke_probe')) fail('The migration did not run');
console.log('✓ migration applied');

// ---------------------------------------------------------------- 3. rollback
step('crewtree rollback');
if (crewtree('rollback') !== 0) fail('rollback failed');
if (versions().current !== `v${current}`) fail(`versions.json after rollback: ${JSON.stringify(versions())}`);
if (tables().includes('smoke_probe')) fail('The pre-update database was not restored');
if (crewtree('--no-open') !== 0) fail('Server did not start after rollback');
if (crewtree('status') !== 0) fail('status after rollback');
crewtree('stop');
console.log('✓ rolled back with the previous database');

// ---------------------------------------------------------------- 4. autostart
step('crewtree autostart on/off');
if (crewtree('autostart', 'on') !== 0) fail('autostart on failed');
const launcher = path.join(crewtreeDir, isWindows ? 'autostart.cmd' : 'autostart.sh');
if (!fs.existsSync(launcher)) fail(`launcher missing: ${launcher}`);
const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
const linuxEntries = [
  path.join(xdg, 'systemd', 'user', 'crewtree.service'),
  path.join(xdg, 'autostart', 'crewtree.desktop'),
];
if (isWindows) {
  if (spawnSync('schtasks', ['/Query', '/TN', 'Crewtree']).status !== 0) fail('Task Scheduler entry missing');
} else if (process.platform === 'darwin') {
  const plist = path.join(home, 'Library', 'LaunchAgents', 'dev.crewtree.server.plist');
  if (!fs.existsSync(plist)) fail('launchd plist missing');
  execFileSync('plutil', ['-lint', plist], { stdio: 'inherit' });
} else {
  const entry = linuxEntries.find((f) => fs.existsSync(f));
  if (!entry) fail('No systemd unit or XDG autostart entry');
  console.log(`✓ ${entry}`);
}
// The launcher finds a Node itself: run it the way the system would at login, then stop that server
if (!isWindows) {
  // A bare PATH, like launchd / systemd give it
  const child = spawn('/bin/sh', [launcher], {
    stdio: 'ignore',
    detached: true,
    env: { HOME: home, PATH: '/usr/bin:/bin' },
  });
  child.unref();
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    up = spawnSync(bin, ['status'], { stdio: 'ignore' }).status === 0;
  }
  if (!up) fail('The launcher did not start the server');
  console.log('✓ launcher found Node and started the server');
}
// launchd may already have started it (RunAtLoad): stop before removing
crewtree('stop');
if (crewtree('autostart', 'off') !== 0) fail('autostart off failed');
if (isWindows && spawnSync('schtasks', ['/Query', '/TN', 'Crewtree']).status === 0) fail('Task still registered');
if (fs.existsSync(launcher) || linuxEntries.some((f) => fs.existsSync(f))) fail('autostart off left files behind');
console.log('\n✓ update / rollback / autostart smoke test passed');
