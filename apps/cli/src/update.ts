// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assetName, compareVersions, fetchRelease, type ReleaseInfo } from '@crewtree/shared';
import {
  appDir,
  cliVersion,
  crewtreeDir,
  files,
  isInstalled,
  isWindows,
  pointCurrent,
  readVersions,
  writeVersions,
} from './layout.js';
import { health, startServer, stopServer } from './server.js';
import { c, CliError, fail, info, ok, progress, step, warn } from './ui.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function platformAsset(version: string): string {
  return assetName(version, process.platform, process.arch);
}

export function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/** `<hash>  <file>` lines → map */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m) out.set(m[2].trim(), m[1].toLowerCase());
  }
  return out;
}

async function download(url: string, dest: string) {
  const res = await fetch(url, { headers: { 'User-Agent': 'crewtree' } });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const out = fs.createWriteStream(dest);
  let done = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    done += value.length;
    if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
    progress(done, total);
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
}

/** The Claude Agent SDK is not in the bundle (proprietary): npm installs the pinned version (see NOTICE). */
export function installSdk(bundleDir: string) {
  const npm = isWindows ? 'npm.cmd' : 'npm';
  const res = spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: bundleDir,
    stdio: 'pipe',
    encoding: 'utf8',
    // npm.cmd needs a shell on Windows; the arguments are fixed
    shell: isWindows,
  });
  if (res.status !== 0)
    throw new Error(
      `npm install failed: ${(res.stderr || res.error?.message || '').trim().split('\n').slice(-3).join(' ')}`
    );
}

/** tar for .tar.gz, Expand-Archive for .zip on Windows; no shell involved. */
export function extract(archive: string, into: string) {
  fs.mkdirSync(into, { recursive: true });
  if (archive.endsWith('.zip') && isWindows) {
    // Same extractor as install.ps1 (bsdtar is unreliable with large zips on Windows)
    const quote = (p: string) => `'${p.replace(/'/g, "''")}'`;
    const res = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(into)} -Force`,
      ],
      { stdio: 'pipe' }
    );
    if (res.status !== 0) throw new Error(`Extracting failed: ${res.stderr?.toString().trim() || res.error?.message}`);
    return;
  }
  const args = archive.endsWith('.zip') ? ['-xf', archive, '-C', into] : ['-xzf', archive, '-C', into];
  const res = spawnSync('tar', args, { stdio: 'pipe' });
  if (res.status !== 0) throw new Error(`Extracting failed: ${res.stderr?.toString().trim() || res.error?.message}`);
}

/** The archive has one top-level folder (crewtree-v0.2.0-darwin-arm64/); move its content to the version dir. */
function installExtracted(tmpDir: string, versionDir: string) {
  const entries = fs.readdirSync(tmpDir);
  const top =
    entries.length === 1 && fs.statSync(path.join(tmpDir, entries[0])).isDirectory()
      ? path.join(tmpDir, entries[0])
      : tmpDir;
  if (!fs.existsSync(path.join(top, 'VERSION')))
    throw new Error('The archive is not a Crewtree bundle (no VERSION file)');
  fs.rmSync(versionDir, { recursive: true, force: true });
  fs.renameSync(top, versionDir);
}

function versionDirOf(version: string) {
  return path.join(appDir(), `v${version.replace(/^v/, '')}`);
}

function backupDb(version: string): string | undefined {
  if (!fs.existsSync(files.db())) return undefined;
  fs.mkdirSync(files.backups(), { recursive: true });
  const dest = path.join(files.backups(), `crewtree-v${version}.db`);
  fs.copyFileSync(files.db(), dest);
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(files.db() + ext)) fs.copyFileSync(files.db() + ext, dest + ext);
    else fs.rmSync(dest + ext, { force: true });
  }
  return dest;
}

function restoreDb(backup: string) {
  fs.copyFileSync(backup, files.db());
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(backup + ext)) fs.copyFileSync(backup + ext, files.db() + ext);
    else fs.rmSync(files.db() + ext, { force: true });
  }
}

/** Keep the current and the previous version folders only (PLAN.md 16.4). */
function pruneVersions(keep: string[]) {
  for (const name of fs.readdirSync(appDir())) {
    if (!/^v\d/.test(name) || keep.includes(name)) continue;
    fs.rmSync(path.join(appDir(), name), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- update notice

export interface UpdateCheck {
  checkedAt: number;
  current: string;
  latest?: string;
  releaseUrl?: string;
  updateAvailable: boolean;
}

function noticesDisabled(): boolean {
  if (process.env.CREWTREE_NO_UPDATE_CHECK === '1') return true;
  return false;
}

/** At most one GitHub call a day (cache shared with the server's web banner). */
export async function cachedCheck(): Promise<UpdateCheck | null> {
  if (noticesDisabled()) return null;
  const current = cliVersion();
  try {
    const cached = JSON.parse(fs.readFileSync(files.updateCheck(), 'utf8')) as UpdateCheck & { disabled?: boolean };
    if (cached.disabled) return null;
    if (Date.now() - cached.checkedAt < DAY_MS && cached.latest) {
      return { ...cached, current, updateAvailable: compareVersions(cached.latest, current) > 0 };
    }
  } catch {
    // no cache
  }
  try {
    const release = await fetchRelease({ timeoutMs: 3000 });
    const result: UpdateCheck = {
      checkedAt: Date.now(),
      current,
      latest: release.version,
      releaseUrl: release.url,
      updateAvailable: compareVersions(release.version, current) > 0,
    };
    fs.mkdirSync(crewtreeDir(), { recursive: true });
    fs.writeFileSync(files.updateCheck(), JSON.stringify(result));
    return result;
  } catch {
    return null;
  }
}

export async function printUpdateNotice() {
  const check = await cachedCheck().catch(() => null);
  if (check?.updateAvailable) {
    console.log(
      `\n${c.cyan('↑')} Crewtree v${check.latest} is available (you have v${check.current}). Run: ${c.bold('crewtree update')}`
    );
  }
}

// ---------------------------------------------------------------- update / rollback

export interface UpdateOptions {
  version?: string;
  /** Offline update from a local archive with SHA256SUMS next to it */
  archive?: string;
  check?: boolean;
  pre?: boolean;
  wait?: boolean;
  force?: boolean;
}

async function waitForIdle() {
  for (;;) {
    const h = await health();
    if (!h || h.runningAgents === 0) return;
    process.stdout.write(`\r  Waiting for ${h.runningAgents} running agent process(es) to finish…`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

/**
 * `crewtree update` (PLAN.md 16.4): download → SHA256 → extract into its own folder → back up the DB →
 * switch `current` → restart (migrations run on start) → on failure restore the DB and the old version.
 */
export async function update(opts: UpdateOptions) {
  const current = cliVersion();
  let target: {
    version: string;
    url?: string;
    download?: { asset: string; sums: string };
    local?: { archive: string; sums: string };
  };
  if (opts.archive) {
    const archive = path.resolve(opts.archive);
    const m = /^crewtree-v(.+)-([a-z0-9]+)-([a-z0-9]+)\.(tar\.gz|zip)$/.exec(path.basename(archive));
    if (!m || !fs.existsSync(archive)) throw new CliError(`Not a Crewtree archive: ${archive}`);
    if (`${m[2]}-${m[3]}` !== `${process.platform}-${process.arch}`)
      throw new CliError(`That archive is for ${m[2]}-${m[3]}`);
    target = { version: m[1], local: { archive, sums: path.join(path.dirname(archive), 'SHA256SUMS') } };
    console.log(`  Current: v${current}   Archive: v${target.version}`);
  } else {
    let release: ReleaseInfo;
    try {
      release = await fetchRelease({ version: opts.version, pre: opts.pre });
    } catch (err: any) {
      throw new CliError(`Could not check for updates: ${err.message}`);
    }
    console.log(`  Current: v${current}   ${opts.version ? 'Target' : 'Latest'}: v${release.version}`);
    if (!opts.version && compareVersions(release.version, current) <= 0) {
      ok('You have the latest version');
      return;
    }
    console.log(`  What's new: ${release.url}`);
    if (opts.check) return;
    const name = platformAsset(release.version);
    const asset = release.assets.find((a) => a.name === name);
    const sums = release.assets.find((a) => a.name === 'SHA256SUMS');
    if (!asset) throw new CliError(`No build for ${process.platform}-${process.arch} in v${release.version}`);
    if (!sums) throw new CliError('The release has no SHA256SUMS; refusing to install an unverified download');
    target = { version: release.version, url: release.url, download: { asset: asset.url, sums: sums.url } };
  }
  if (!isInstalled()) {
    throw new CliError(
      'This copy of Crewtree is a development checkout',
      'Update it with git pull && pnpm build, or install a release with install.sh / install.ps1.'
    );
  }
  if (target.version === current) {
    ok(`v${current} is already installed`);
    return;
  }
  const release = { version: target.version };
  const name = platformAsset(release.version);

  const running = await health();
  if (running && running.runningAgents > 0) {
    if (opts.wait) await waitForIdle();
    else if (!opts.force) {
      throw new CliError(
        `${running.runningAgents} agent process(es) are running`,
        'Run again with --wait (update when they finish) or --force (running tasks become interrupted and can be resumed).'
      );
    }
  }

  const started = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crewtree-update-'));
  const total = 5;
  try {
    step(1, total, `Downloading v${release.version}`);
    const archive = path.join(tmp, name);
    const sumsFile = path.join(tmp, 'SHA256SUMS');
    if (target.local) {
      fs.copyFileSync(target.local.archive, archive);
      if (!fs.existsSync(target.local.sums)) throw new CliError('SHA256SUMS not found next to the archive');
      fs.copyFileSync(target.local.sums, sumsFile);
      console.log(c.green('✓ local archive'));
    } else {
      await download(target.download!.asset, archive);
      await download(target.download!.sums, sumsFile);
      console.log(c.green('100%'));
    }

    step(2, total, 'Verifying checksum');
    const expected = parseSums(fs.readFileSync(sumsFile, 'utf8')).get(name);
    const actual = await sha256(archive);
    if (!expected || expected !== actual)
      throw new CliError('Checksum mismatch: the download was removed and nothing changed');
    console.log(c.green('✓ SHA256 OK'));

    step(3, total, 'Extracting');
    const extractDir = path.join(tmp, 'extract');
    extract(archive, extractDir);
    const targetDir = versionDirOf(release.version);
    installExtracted(extractDir, targetDir);
    installSdk(targetDir);
    console.log(c.green(`✓ ${targetDir}`));

    step(4, total, 'Backing up data');
    const wasRunning = !!(await health());
    if (wasRunning) await stopServer();
    const backup = backupDb(current);
    console.log(c.green(backup ? `✓ Backup: ${backup}` : '✓ No database yet'));

    step(5, total, 'Switching & restarting');
    const previousDir = versionDirOf(current);
    pointCurrent(targetDir);
    writeVersions({ current: path.basename(targetDir), previous: path.basename(previousDir) });
    try {
      // Migrations run when the new server opens the database
      await startServer({ root: targetDir });
      if (!wasRunning) await stopServer();
    } catch {
      // New version failed to start: restore the DB and the old version
      if (backup) restoreDb(backup);
      pointCurrent(previousDir);
      writeVersions({ current: path.basename(previousDir) });
      if (wasRunning) await startServer({ root: previousDir }).catch(() => undefined);
      throw new CliError(
        `v${release.version} did not start; restored v${current} and its database`,
        `See ${files.serverLog()}`
      );
    }
    console.log(c.green(`✓ current → v${release.version}${wasRunning ? ' · server restarted' : ''}`));
    pruneVersions([path.basename(targetDir), path.basename(previousDir)]);
    ok(`Updated v${current} → v${release.version} in ${Math.round((Date.now() - started) / 1000)}s`);
    info(`Roll back anytime with: ${c.bold('crewtree rollback')}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** `crewtree rollback`: `current` back to the previous version + the database backed up before the update. */
export async function rollback() {
  if (!isInstalled()) throw new CliError('Rollback only works for installed releases');
  const versions = readVersions();
  if (!versions.previous) throw new CliError('There is no previous version to roll back to');
  const previousDir = path.join(appDir(), versions.previous);
  if (!fs.existsSync(previousDir)) throw new CliError(`${previousDir} no longer exists`);
  const wasRunning = !!(await health());
  if (wasRunning) await stopServer();
  const backup = path.join(files.backups(), `crewtree-${versions.previous}.db`);
  if (fs.existsSync(backup)) {
    restoreDb(backup);
    ok(`Database restored from ${backup}`);
  } else warn('No database backup for that version; keeping the current database');
  pointCurrent(previousDir);
  writeVersions({ current: versions.previous, previous: versions.current });
  if (wasRunning) await startServer({ root: previousDir });
  ok(`Rolled back to ${versions.previous}`);
}

export function describeInstall(): string {
  return isInstalled()
    ? `${appDir()}${isWindows ? '\\' : '/'}${readVersions().current ?? '?'}`
    : 'development checkout';
}

export { fail };
