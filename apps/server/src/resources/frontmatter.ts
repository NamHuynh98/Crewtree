// SPDX-License-Identifier: Apache-2.0
import { parseDocument, type Document } from 'yaml';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)([\s\S]*)$/;

export function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Rewrites `text` with the line endings already used by the file being replaced (PLAN.md 16.6). */
export function withEol(text: string, eol: '\r\n' | '\n'): string {
  const lf = text.replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}

export function splitFrontmatter(content: string): { yaml: string; body: string } | null {
  const match = FRONTMATTER_RE.exec(content);
  return match ? { yaml: match[1], body: match[3] } : null;
}

export function readFrontmatter(content: string): Record<string, unknown> {
  const parts = splitFrontmatter(content);
  if (!parts) return {};
  const value = parseDocument(parts.yaml).toJS();
  return value && typeof value === 'object' ? value : {};
}

/**
 * Edits frontmatter keys while keeping the rest of the file (order, comments, body) as it was.
 * Creates a frontmatter block when there is none.
 */
export function updateFrontmatter(content: string, mutate: (doc: Document) => void): string {
  const eol = detectEol(content);
  const parts = splitFrontmatter(content.replace(/\r\n/g, '\n'));
  const doc = parseDocument(parts?.yaml ?? '');
  mutate(doc);
  const yaml = doc.toString({ lineWidth: 0 }).replace(/\n$/, '');
  const body = parts ? parts.body : content.replace(/\r\n/g, '\n');
  return withEol(`---\n${yaml}\n---\n${body.replace(/^\n/, '')}`, eol);
}
