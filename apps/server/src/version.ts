// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { compareVersions, fetchRelease } from '@crewtree/shared';
import { getCrewtreeDir } from './paths.js';
import { getAppSettings } from './settings/appSettings.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The running version: the release bundle has a VERSION file at its root (written by scripts/pack.ts);
 * a dev checkout falls back to the monorepo package.json.
 */
export function currentVersion(): string {
  for (const candidate of [path.resolve(here, '../../VERSION'), path.resolve(here, '../../../VERSION')]) {
    try {
      const v = fs.readFileSync(candidate, 'utf8').trim();
      if (v) return v.replace(/^v/, '');
    } catch {
      // next
    }
  }
  try {
    return JSON.parse(fs.readFileSync(path.resolve(here, '../../../package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface UpdateCheck {
  checkedAt: number;
  current: string;
  latest?: string;
  updateAvailable: boolean;
  releaseUrl?: string;
  error?: string;
  disabled?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function updateCheckPath(): string {
  return path.join(getCrewtreeDir(), 'update-check.json');
}

export function updateChecksDisabled(): boolean {
  return process.env.CREWTREE_NO_UPDATE_CHECK === '1' || !getAppSettings().update.check;
}

/** At most one GitHub call a day, shared with the CLI through ~/.crewtree/update-check.json (PLAN.md 16.4). */
export async function checkForUpdate(force = false): Promise<UpdateCheck> {
  const current = currentVersion();
  if (updateChecksDisabled() && !force) {
    const off = { checkedAt: Date.now(), current, updateAvailable: false, disabled: true };
    // The CLI reads the same file: Settings → General "Check for updates" off silences it too
    try {
      fs.writeFileSync(updateCheckPath(), JSON.stringify(off));
    } catch {
      // optional
    }
    return off;
  }
  try {
    const cached = JSON.parse(fs.readFileSync(updateCheckPath(), 'utf8')) as UpdateCheck;
    if (!force && Date.now() - cached.checkedAt < DAY_MS && cached.latest) {
      return { ...cached, current, updateAvailable: compareVersions(cached.latest, current) > 0 };
    }
  } catch {
    // no cache yet
  }
  let result: UpdateCheck;
  try {
    const release = await fetchRelease({ timeoutMs: 8000 });
    result = {
      checkedAt: Date.now(),
      current,
      latest: release.version,
      releaseUrl: release.url,
      updateAvailable: compareVersions(release.version, current) > 0,
    };
  } catch (err: any) {
    result = { checkedAt: Date.now(), current, updateAvailable: false, error: err?.message ?? String(err) };
  }
  try {
    fs.writeFileSync(updateCheckPath(), JSON.stringify(result));
  } catch {
    // cache is optional
  }
  return result;
}
