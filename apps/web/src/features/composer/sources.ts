// SPDX-License-Identifier: Apache-2.0
import { api } from '@/lib/api';
import type { ComposerContext, SuggestionItem } from './types';
import { splitRangeQuery } from './types';

function contextQuery(ctx: ComposerContext): string {
  const params = new URLSearchParams();
  if (ctx.sessionId) params.set('sessionId', ctx.sessionId);
  else if (ctx.cwd) params.set('cwd', ctx.cwd);
  return params.toString();
}

/** `@` — recent files, files/folders (fuzzy, .gitignore) and agents (PLAN.md 8). */
export async function mentionItems(
  ctx: ComposerContext,
  rawQuery: string,
  agents: string[]
): Promise<SuggestionItem[]> {
  const { query, range } = splitRangeQuery(rawQuery);
  const q = query.toLowerCase();
  const agentItems: SuggestionItem[] = range
    ? []
    : agents
        .filter((a) => a.toLowerCase().includes(q))
        .slice(0, 6)
        .map((a) => ({ kind: 'agent', value: a }));
  let files: SuggestionItem[] = [];
  try {
    const res = await api<{
      items: Array<{ path: string; type: 'file' | 'dir'; recent?: { agent: string; ts: number } }>;
    }>(`/api/fs/search?q=${encodeURIComponent(query)}&limit=20&${contextQuery(ctx)}`);
    files = res.items
      .filter((i) => !range || i.type === 'file')
      .map((i) => ({ kind: i.type, value: i.path, recent: i.recent, range: i.type === 'file' ? range : undefined }));
  } catch {
    // No file search outside a known project: agents only
  }
  return [...files, ...agentItems];
}

interface ResourceLite {
  name: string;
  description: string;
  scope: string;
  plugin?: string;
  shadowedBy?: string;
}

let slashCache: { at: number; items: SuggestionItem[] } | null = null;

/** `/` — skills and commands from every scope (PLAN.md 8). Cached for a minute. */
export async function slashItems(rawQuery: string): Promise<SuggestionItem[]> {
  if (!slashCache || Date.now() - slashCache.at > 60_000) {
    const [skills, commands] = await Promise.all([
      api<ResourceLite[]>('/api/resources/skills').catch(() => []),
      api<ResourceLite[]>('/api/resources/commands').catch(() => []),
    ]);
    const toItem = (kind: 'skill' | 'command') => (r: ResourceLite) => ({
      kind,
      value: r.plugin && kind === 'command' ? `${r.plugin}:${r.name}` : r.name,
      detail: r.plugin ? `plugin: ${r.plugin}` : r.description,
    });
    slashCache = {
      at: Date.now(),
      items: [
        ...skills.filter((s) => !s.shadowedBy).map(toItem('skill')),
        ...commands.filter((c) => !c.shadowedBy).map(toItem('command')),
      ],
    };
  }
  const q = rawQuery.toLowerCase();
  return slashCache.items.filter((i) => i.value.toLowerCase().includes(q)).slice(0, 12);
}

export async function readFile(ctx: ComposerContext, path: string) {
  const params = new URLSearchParams({ path });
  const c = contextQuery(ctx);
  return api<{ path: string; content?: string; binary: boolean; tooLarge: boolean; size: number }>(
    `/api/fs/file?${params.toString()}${c ? `&${c}` : ''}`
  );
}

export async function uploadFiles(ctx: ComposerContext, files: File[]) {
  const form = new FormData();
  // The scope field must precede the files (the server streams parts in order)
  if (ctx.sessionId) form.append('sessionId', ctx.sessionId);
  for (const f of files) form.append('file', f, f.name);
  const res = await fetch('/api/uploads', { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body.attachments as Array<{ id: string; name: string; kind: 'image' | 'pdf' | 'text' | 'binary' }>;
}
