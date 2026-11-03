// SPDX-License-Identifier: Apache-2.0

/** ~/WorkSpace/app instead of /Users/me/WorkSpace/app */
export function shortenPath(p: string, homeDir?: string): string {
  return homeDir && (p === homeDir || p.startsWith(homeDir + '/')) ? '~' + p.slice(homeDir.length) : p;
}
