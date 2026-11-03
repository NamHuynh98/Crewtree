// SPDX-License-Identifier: Apache-2.0

/** Official release channel (PLAN.md 16.5, 21.2): GitHub Releases of this repository. */
export const RELEASE_REPO = 'NamHuynh98/Crewtree';

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

export function parseVersion(input: string): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(input.trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

/** Semver precedence: -1 when a < b, 0 when equal, 1 when a > b. Invalid versions sort first. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return !x && !y ? 0 : !x ? -1 : 1;
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && +p !== +q) return +p < +q ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export type ReleaseOs = 'darwin' | 'win32' | 'linux';

/** `crewtree-v0.2.0-darwin-arm64.tar.gz` / `crewtree-v0.2.0-win32-x64.zip` */
export function assetName(version: string, os: string, arch: string): string {
  const v = version.startsWith('v') ? version : `v${version}`;
  return `crewtree-${v}-${os}-${arch}.${os === 'win32' ? 'zip' : 'tar.gz'}`;
}

export interface ReleaseInfo {
  tag: string;
  version: string;
  prerelease: boolean;
  url: string;
  assets: Array<{ name: string; url: string; size: number }>;
}

function toRelease(r: any): ReleaseInfo {
  return {
    tag: r.tag_name,
    version: String(r.tag_name).replace(/^v/, ''),
    prerelease: !!r.prerelease,
    url: r.html_url,
    assets: (r.assets ?? []).map((a: any) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
  };
}

/**
 * Newest release (GitHub API). `pre` includes pre-releases; `version` picks one tag.
 * Drafts are never returned.
 */
export async function fetchRelease(
  opts: { version?: string; pre?: boolean; repo?: string; timeoutMs?: number } = {}
): Promise<ReleaseInfo> {
  const repo = opts.repo ?? RELEASE_REPO;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'crewtree' };
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  const get = async (url: string) => {
    const res = await fetch(url, { headers, signal });
    if (res.status === 404)
      throw new Error(opts.version ? `Release ${opts.version} not found` : 'No release published yet');
    if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`);
    return res.json();
  };
  if (opts.version) {
    const tag = opts.version.startsWith('v') ? opts.version : `v${opts.version}`;
    return toRelease(await get(`https://api.github.com/repos/${repo}/releases/tags/${tag}`));
  }
  if (!opts.pre) return toRelease(await get(`https://api.github.com/repos/${repo}/releases/latest`));
  const list = (await get(`https://api.github.com/repos/${repo}/releases?per_page=20`)) as any[];
  const newest = list
    .filter((r) => !r.draft)
    .map(toRelease)
    .sort((a, b) => compareVersions(b.version, a.version))[0];
  if (!newest) throw new Error('No release published yet');
  return newest;
}
