// SPDX-License-Identifier: Apache-2.0
import path from 'path';
import picomatch from 'picomatch';
import { normalizePath } from '../paths.js';

/** Tools whose permission spec is a path glob, like Claude Code's `Edit(src/**)`. */
export const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Tools that modify files (file locks, scope checks, file_touches). */
export const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const RULE_RE = /^([A-Za-z0-9_\-:.]+)(?:\((.*)\))?$/s;

export function parseRule(rule: string): { tool: string; spec?: string } | null {
  const match = RULE_RE.exec(rule.trim());
  if (!match) return null;
  return { tool: match[1], spec: match[2] === undefined ? undefined : match[2].trim() };
}

export function filePathOf(input: any): string | undefined {
  const p = input?.file_path ?? input?.notebook_path ?? input?.path;
  return typeof p === 'string' ? p : undefined;
}

/** Path relative to cwd with forward slashes; absolute (normalized) when outside cwd. */
export function relativeToCwd(filePath: string, cwd: string): string {
  const abs = path.resolve(cwd, filePath);
  const rel = path.relative(cwd, abs);
  return normalizePath(rel.startsWith('..') || path.isAbsolute(rel) ? abs : rel);
}

/** Rejects rules the UI must never offer (PLAN.md 10: no blanket `Bash`). Returns an error message or null. */
export function validateRule(rule: string): string | null {
  const parsed = parseRule(rule);
  if (!parsed) return `Invalid permission rule: ${rule}`;
  if (parsed.tool === 'Bash' && (!parsed.spec || parsed.spec === '*' || parsed.spec === ':*')) {
    return 'A rule must not allow every Bash command; use a command prefix like Bash(npm test:*)';
  }
  return null;
}

export function matchesRule(rule: string, toolName: string, input: any, cwd: string): boolean {
  const parsed = parseRule(rule);
  if (!parsed || parsed.tool !== toolName) return false;
  if (parsed.spec === undefined) return toolName !== 'Bash';

  if (toolName === 'Bash') {
    const command = String(input?.command ?? '').trim();
    if (parsed.spec.endsWith(':*')) {
      const prefix = parsed.spec.slice(0, -2).trim();
      return command === prefix || command.startsWith(prefix + ' ');
    }
    return command === parsed.spec;
  }

  if (FILE_TOOLS.has(toolName)) {
    const filePath = filePathOf(input);
    if (!filePath) return false;
    const spec = parsed.spec.replace(/^\.\//, '');
    const target = path.isAbsolute(spec) ? normalizePath(path.resolve(cwd, filePath)) : relativeToCwd(filePath, cwd);
    return picomatch(spec, { dot: true, nocase: process.platform !== 'linux' })(target);
  }

  if (toolName === 'WebFetch' && parsed.spec.startsWith('domain:')) {
    try {
      const host = new URL(String(input?.url)).hostname;
      const domain = parsed.spec.slice('domain:'.length);
      return host === domain || host.endsWith('.' + domain);
    } catch {
      return false;
    }
  }
  return false;
}

/** Pre-filled "Always allow" suggestion; editable by the user before saving (PLAN.md 10). */
export function suggestRule(toolName: string, input: any, cwd: string): string {
  if (toolName === 'Bash') {
    const words = String(input?.command ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const prefix = words.length > 1 && !words[1].startsWith('-') ? words.slice(0, 2) : words.slice(0, 1);
    return `Bash(${prefix.join(' ') || 'command'}:*)`;
  }
  if (FILE_TOOLS.has(toolName)) {
    const filePath = filePathOf(input);
    if (!filePath) return toolName;
    const rel = relativeToCwd(filePath, cwd);
    const dir = path.posix.dirname(rel);
    return `${toolName}(${dir === '.' ? rel : `${dir}/**`})`;
  }
  if (toolName === 'WebFetch') {
    try {
      return `WebFetch(domain:${new URL(String(input?.url)).hostname})`;
    } catch {
      return toolName;
    }
  }
  return toolName;
}
