// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const isWindows = process.platform === 'win32';

export function crewtreeDir(): string {
  return process.env.CREWTREE_DIR || path.join(os.homedir(), '.crewtree');
}

/** Where versions live: ~/.crewtree/app/<version>/ and ~/.crewtree/app/current (PLAN.md 16.1). */
export function appDir(): string {
  return process.env.CREWTREE_INSTALL_DIR || path.join(crewtreeDir(), 'app');
}

export function currentLink(): string {
  return path.join(appDir(), 'current');
}

/** The bundle this CLI runs from: <bundle>/cli/dist/index.js (in a checkout: apps/cli/dist). */
export function bundleRoot(): string {
  return path.resolve(here, '../..');
}

export function serverEntry(root = bundleRoot()): string {
  return path.join(root, 'server', 'dist', 'index.js');
}

export function cliVersion(): string {
  for (const file of [path.join(bundleRoot(), 'VERSION')]) {
    try {
      return fs.readFileSync(file, 'utf8').trim().replace(/^v/, '');
    } catch {
      // dev checkout
    }
  }
  try {
    return JSON.parse(fs.readFileSync(path.resolve(bundleRoot(), '..', 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

/** True when running from an installed release (not a git checkout). */
export function isInstalled(): boolean {
  try {
    return (
      fs.existsSync(path.join(bundleRoot(), 'VERSION')) && path.resolve(bundleRoot(), '..') === path.resolve(appDir())
    );
  } catch {
    return false;
  }
}

export const files = {
  config: () => path.join(crewtreeDir(), 'config.json'),
  pid: () => path.join(crewtreeDir(), 'crewtree.pid'),
  token: () => path.join(crewtreeDir(), 'shutdown.token'),
  db: () => path.join(crewtreeDir(), 'crewtree.db'),
  backups: () => path.join(crewtreeDir(), 'backups'),
  logs: () => path.join(crewtreeDir(), 'logs'),
  serverLog: () => path.join(crewtreeDir(), 'logs', 'server.log'),
  updateCheck: () => path.join(crewtreeDir(), 'update-check.json'),
  versions: () => path.join(appDir(), 'versions.json'),
};

/** `crewtree` on PATH: ~/.local/bin/crewtree (symlink) or %USERPROFILE%\.crewtree\bin\crewtree.cmd. */
export function binPath(): string {
  return isWindows
    ? path.join(crewtreeDir(), 'bin', 'crewtree.cmd')
    : path.join(os.homedir(), '.local', 'bin', 'crewtree');
}

export interface VersionsFile {
  current?: string;
  previous?: string;
}

export function readVersions(): VersionsFile {
  try {
    return JSON.parse(fs.readFileSync(files.versions(), 'utf8'));
  } catch {
    try {
      return { current: path.basename(fs.realpathSync(currentLink())) };
    } catch {
      return {};
    }
  }
}

export function writeVersions(v: VersionsFile) {
  fs.mkdirSync(appDir(), { recursive: true });
  fs.writeFileSync(files.versions(), JSON.stringify(v, null, 2));
}

/** Points `current` at a version folder: symlink on POSIX, junction on Windows (no admin needed). */
export function pointCurrent(versionDir: string) {
  const link = currentLink();
  try {
    const stat = fs.lstatSync(link);
    // A junction looks like a directory on Windows; rmdir removes the link, never the target
    if (stat.isSymbolicLink()) fs.unlinkSync(link);
    else if (isWindows) fs.rmdirSync(link);
    else throw new Error(`${link} is not a link; refusing to replace it`);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
  fs.symlinkSync(versionDir, link, isWindows ? 'junction' : 'dir');
}
