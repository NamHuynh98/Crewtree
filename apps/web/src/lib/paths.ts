// SPDX-License-Identifier: Apache-2.0

/** ~/WorkSpace/app instead of /Users/me/WorkSpace/app */
export function shortenPath(p: string, homeDir?: string): string {
  return homeDir && (p === homeDir || p.startsWith(homeDir + '/')) ? '~' + p.slice(homeDir.length) : p;
}

/** `path` relative to `cwd` when it is inside it (forward slashes), else unchanged. */
export function relativePath(cwd: string, path: string): string {
  const base = cwd.replace(/\\/g, '/').replace(/\/$/, '');
  const p = path.replace(/\\/g, '/');
  return p.startsWith(`${base}/`) ? p.slice(base.length + 1) : p.replace(/^\.\//, '');
}
