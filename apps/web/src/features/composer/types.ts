// SPDX-License-Identifier: Apache-2.0

/** Where `@` file search and line previews read from: a session's cwd or a known project folder. */
export interface ComposerContext {
  sessionId?: string;
  cwd?: string;
}

export type SuggestionKind = 'file' | 'dir' | 'agent' | 'skill' | 'command';

export interface SuggestionItem {
  kind: SuggestionKind;
  /** Path, agent name or slash name */
  value: string;
  detail?: string;
  /** Recently edited by an agent in this session */
  recent?: { agent: string; ts: number };
  /** `#10-24` typed after the file query */
  range?: { start: number; end: number };
}

export interface ComposerAttachment {
  /** Local key until the upload finishes */
  key: string;
  id?: string;
  name: string;
  kind?: 'image' | 'pdf' | 'text' | 'binary';
  previewUrl?: string;
  uploading: boolean;
  error?: string;
}

export interface ComposerSendPayload {
  /** Text with chip tokens: [[file:path#L10-24]], [[dir:path]], [[agent:name]], /skill */
  text: string;
  attachments: string[];
  mode: 'queue' | 'interrupt';
}

/** Chip token for a mention node id (`file:src/a.ts#L1-2`, `agent:analyst`, `slash:review`). */
export function tokenFor(id: string): string {
  if (id.startsWith('slash:')) return `/${id.slice(6)}`;
  return `[[${id}]]`;
}

export function chipId(item: SuggestionItem): string {
  if (item.kind === 'skill' || item.kind === 'command') return `slash:${item.value}`;
  if (item.kind === 'file' && item.range) {
    const { start, end } = item.range;
    return `file:${item.value}#L${start}${end !== start ? `-${end}` : ''}`;
  }
  return `${item.kind}:${item.value}`;
}

export function chipLabel(id: string): string {
  const [kind, ...rest] = id.split(':');
  const value = rest.join(':');
  if (kind === 'agent') return `@${value}`;
  if (kind === 'slash') return `/${value}`;
  if (kind === 'dir') return `${value}/`;
  return value;
}

/** `auth#10-24` → { query: 'auth', range: {10, 24} } */
export function splitRangeQuery(query: string): { query: string; range?: { start: number; end: number } } {
  const m = /^(.*?)[#:](\d+)(?:-(\d+))?$/.exec(query);
  if (!m) return { query: query.replace(/[#:]$/, '') };
  const start = Number(m[2]);
  const end = Math.max(start, Number(m[3] ?? m[2]));
  return { query: m[1], range: { start, end } };
}
