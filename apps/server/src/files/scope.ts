// SPDX-License-Identifier: Apache-2.0
import picomatch from 'picomatch';

const GLOB_CHARS = /[*?[\]{}!]/;
const caseInsensitive = process.platform !== 'linux';

function clean(entry: string): string {
  return entry.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** `src/auth/**`, `src/pages/Login*`, or a plain directory/file such as `src/auth`. */
export function isInScope(relPath: string, scope: string[]): boolean {
  const target = clean(relPath);
  return scope.some((raw) => {
    const entry = clean(raw);
    if (!entry) return false;
    if (GLOB_CHARS.test(entry)) return picomatch(entry, { dot: true, nocase: caseInsensitive })(target);
    const a = caseInsensitive ? target.toLowerCase() : target;
    const b = caseInsensitive ? entry.toLowerCase() : entry;
    return a === b || a.startsWith(b + '/');
  });
}

function literalPrefix(segment: string): string {
  const idx = segment.search(GLOB_CHARS);
  return idx === -1 ? segment : segment.slice(0, idx);
}

/** Conservative overlap test between two scope entries: false only when no path can match both. */
export function entriesOverlap(rawA: string, rawB: string): boolean {
  const norm = (s: string) => (caseInsensitive ? clean(s).toLowerCase() : clean(s));
  const a = norm(rawA).split('/');
  const b = norm(rawB).split('/');
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const sa = a[i];
    const sb = b[i];
    if (sa === '**' || sb === '**') return true;
    const ga = GLOB_CHARS.test(sa);
    const gb = GLOB_CHARS.test(sb);
    if (!ga && !gb) {
      if (sa !== sb) return false;
      continue;
    }
    // At least one side is a pattern: compatible when their literal prefixes agree
    const pa = literalPrefix(sa);
    const pb = literalPrefix(sb);
    if (!(pa.startsWith(pb) || pb.startsWith(pa))) return false;
    if (ga && !gb && !picomatch(sa, { dot: true, nocase: caseInsensitive })(sb)) return false;
    if (gb && !ga && !picomatch(sb, { dot: true, nocase: caseInsensitive })(sa)) return false;
  }
  if (a.length === b.length) return true;
  // Different depth: overlap when the shorter one is a directory (no glob in its last segment) or ends in **
  const shorter = a.length < b.length ? a : b;
  const last = shorter[shorter.length - 1];
  return last === '**' || !GLOB_CHARS.test(last);
}

export function scopesOverlap(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => entriesOverlap(x, y)));
}
