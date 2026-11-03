// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';

/** Upper bound on indexed paths per root; huge monorepos are truncated rather than exhausting memory. */
export const MAX_ENTRIES = 50_000;
/** Roots kept in memory at once (PLAN.md 21: caches have an entry limit). */
const MAX_ROOTS = 6;
/** An index older than this is refreshed in the background; the stale list still answers immediately. */
const STALE_MS = 10_000;

const FALLBACK_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.turbo/**',
];

export interface IndexEntry {
  path: string; // relative, forward slashes
  type: 'file' | 'dir';
}

export interface SearchHit extends IndexEntry {
  score: number;
}

interface RootIndex {
  entries: IndexEntry[];
  builtAt: number;
  truncated: boolean;
  building?: Promise<void>;
}

function gitLsFiles(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 10_000 },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(stdout.split('\0').filter(Boolean));
      }
    );
  });
}

async function listFiles(root: string): Promise<string[]> {
  // git respects .gitignore exactly (nested files, negations); fast-glob is the fallback outside repos.
  const fromGit = fs.existsSync(path.join(root, '.git')) ? await gitLsFiles(root) : null;
  if (fromGit) return fromGit.filter((p) => fs.existsSync(path.join(root, p)));
  return fg('**/*', { cwd: root, dot: true, onlyFiles: true, ignore: FALLBACK_IGNORE, suppressErrors: true });
}

function toEntries(files: string[]): { entries: IndexEntry[]; truncated: boolean } {
  const truncated = files.length > MAX_ENTRIES;
  const kept = files.slice(0, MAX_ENTRIES).map((f) => f.replace(/\\/g, '/'));
  const dirs = new Set<string>();
  for (const f of kept) {
    let i = f.lastIndexOf('/');
    while (i > 0) {
      const dir = f.slice(0, i);
      if (dirs.has(dir)) break;
      dirs.add(dir);
      i = dir.lastIndexOf('/');
    }
  }
  return {
    entries: [
      ...[...dirs].map((p) => ({ path: p, type: 'dir' as const })),
      ...kept.map((p) => ({ path: p, type: 'file' as const })),
    ],
    truncated,
  };
}

/**
 * Fuzzy score of `query` against `target` (both lower-case), or -1 when not every query char appears in order.
 * Rewards matches on the basename, at segment starts and in runs; shorter paths win ties.
 */
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const base = target.lastIndexOf('/') + 1;
  let score = 0;
  let ti = 0;
  let run = 0;
  for (let qi = 0; qi < query.length; qi++) {
    const c = query[qi];
    const found = target.indexOf(c, ti);
    if (found === -1) return -1;
    const prev = target[found - 1];
    const segmentStart = found === 0 || prev === '/' || prev === '-' || prev === '_' || prev === '.';
    run = found === ti && qi > 0 ? run + 1 : 0;
    score += 1 + run * 2 + (segmentStart ? 3 : 0) + (found >= base ? 2 : 0);
    ti = found + 1;
  }
  const baseName = target.slice(base);
  if (baseName.startsWith(query)) score += 10;
  else if (baseName.includes(query)) score += 5;
  return score - target.length * 0.01;
}

/** In-memory path index per project root for `@` mentions (PLAN.md 8: GET /api/fs/search < 50ms). */
export class FileIndex {
  private static instance: FileIndex;
  private roots = new Map<string, RootIndex>();

  public static getInstance(): FileIndex {
    if (!FileIndex.instance) FileIndex.instance = new FileIndex();
    return FileIndex.instance;
  }

  private async build(root: string, index: RootIndex): Promise<void> {
    const files = await listFiles(root);
    const { entries, truncated } = toEntries(files);
    index.entries = entries;
    index.truncated = truncated;
    index.builtAt = Date.now();
  }

  private async get(root: string): Promise<RootIndex> {
    let index = this.roots.get(root);
    if (!index) {
      index = { entries: [], builtAt: 0, truncated: false };
      this.roots.set(root, index);
      while (this.roots.size > MAX_ROOTS) this.roots.delete(this.roots.keys().next().value!);
      index.building = this.build(root, index).finally(() => (index!.building = undefined));
      await index.building;
      return index;
    }
    // LRU: move to the end
    this.roots.delete(root);
    this.roots.set(root, index);
    if (Date.now() - index.builtAt > STALE_MS && !index.building) {
      const current = index;
      current.building = this.build(root, current)
        .catch(() => undefined)
        .finally(() => (current.building = undefined));
    }
    return index;
  }

  public invalidate(root?: string) {
    if (root) this.roots.delete(root);
    else this.roots.clear();
  }

  public async search(root: string, query: string, limit = 30): Promise<{ hits: SearchHit[]; truncated: boolean }> {
    const index = await this.get(root);
    const q = query.trim().toLowerCase().replace(/\\/g, '/');
    const hits: SearchHit[] = [];
    for (const entry of index.entries) {
      const score = fuzzyScore(q, entry.path.toLowerCase());
      if (score < 0) continue;
      // Without a query, show shallow entries first
      hits.push({ ...entry, score: q ? score : -entry.path.split('/').length - (entry.type === 'dir' ? 0 : 0.5) });
    }
    hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return { hits: hits.slice(0, limit), truncated: index.truncated };
  }
}
