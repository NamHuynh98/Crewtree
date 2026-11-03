// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import { readFrontmatter } from '../frontmatter.js';

export function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export function readJson<T = any>(file: string): T | undefined {
  const text = readText(file);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Directory entries following symlinks (skills are often links into ~/.agents/skills). */
export function listDir(dir: string): Array<{ name: string; full: string; isDir: boolean }> {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      return [{ name, full, isDir: stat.isDirectory() }];
    } catch {
      return []; // broken link
    }
  });
}

/** `*.md` files of a directory, optionally recursive (commands support subfolders as namespaces). */
export function markdownFiles(dir: string, recursive = false, prefix = ''): Array<{ file: string; rel: string }> {
  return listDir(dir).flatMap((entry) => {
    if (entry.isDir) return recursive ? markdownFiles(entry.full, true, `${prefix}${entry.name}/`) : [];
    return entry.name.endsWith('.md') ? [{ file: entry.full, rel: `${prefix}${entry.name}` }] : [];
  });
}

/** `description` from frontmatter, else the first non-heading line of the body. */
export function describe(content: string): string {
  const fm = readFrontmatter(content);
  if (typeof fm.description === 'string') return fm.description;
  const body = content.replace(/^---[\s\S]*?\n---\r?\n?/, '');
  const line = body.split('\n').find((l) => l.trim() && !l.startsWith('#'));
  return (line ?? '').trim().slice(0, 200);
}
