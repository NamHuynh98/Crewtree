// SPDX-License-Identifier: Apache-2.0
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { shortenPath } from '@/lib/paths';
import { useShell } from '@/app/shell';
import { ScopeBadge } from '@/features/resources/ScopeBadge';
import type { ResourceItem } from '@/features/resources/types';

export type ListKind = 'skills' | 'commands' | 'memory' | 'mcp' | 'plugins';

/** Extra line per kind: what matters at a glance. */
function details(kind: ListKind, item: ResourceItem, t: (k: string, o?: any) => string): string | undefined {
  const m = item.metadata;
  switch (kind) {
    case 'skills':
      return t('resources.files', { count: m.files ?? 1 }) + (m.synced ? ` · ${t('resources.synced')}` : '');
    case 'commands':
      return [m.namespace && `${m.namespace}:`, m.argumentHint].filter(Boolean).join(' ') || undefined;
    case 'memory':
      return [
        t(`resources.memoryRole.${m.role}`),
        m.imports?.length ? t('resources.imports', { count: m.imports.length }) : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'mcp':
      return `${m.type}`;
    case 'plugins': {
      const c = m.components ?? {};
      return [
        m.version && `v${m.version}`,
        m.enabled ? t('resources.enabled') : t('resources.disabled'),
        c.agents ? t('resources.nAgents', { count: c.agents }) : undefined,
        c.skills ? t('resources.nSkills', { count: c.skills }) : undefined,
        c.commands ? t('resources.nCommands', { count: c.commands }) : undefined,
        c.mcpServers ? t('resources.nMcp', { count: c.mcpServers }) : undefined,
        c.hooks ? 'hooks' : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
    }
  }
}

/**
 * Read-only listing of the other Claude Code resources (PLAN.md 6.1): everything found on disk shows up
 * here, updated by the watcher. Editing them arrives with the Claude Config Manager in Phase 6.
 */
export function ResourceListPage({ kind }: { kind: ListKind }) {
  const { t } = useTranslation();
  const { project } = useShell();
  const [search, setSearch] = useState('');
  const {
    data: items = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['resources', kind],
    queryFn: () => api<ResourceItem[]>(`/api/resources/${kind}`),
  });
  const visible = useMemo(
    () => items.filter((i) => `${i.name} ${i.description}`.toLowerCase().includes(search.toLowerCase())),
    [items, search]
  );

  return (
    <main className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-4">
          <div className="mr-auto">
            <h1 className="text-xl font-bold tracking-tight">{t(`resources.title.${kind}`)}</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('resources.readOnlyNote')}</p>
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('agentsPage.search')}
            className="w-48 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs"
            aria-label={t('agentsPage.search')}
          />
        </div>
        {isLoading && <p className="text-xs text-muted-foreground">…</p>}
        {error && <p className="text-xs text-red-600 dark:text-red-400">{(error as Error).message}</p>}
        {!isLoading && visible.length === 0 && <p className="text-xs text-muted-foreground">{t('resources.empty')}</p>}
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {visible.map((item) => (
            <li key={item.id} className="flex items-start gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium">
                    {kind === 'commands' ? `/${item.name}` : item.name}
                  </span>
                  <ScopeBadge scope={item.scope} plugin={item.plugin} readOnly={item.readOnly} />
                </div>
                {item.description && (
                  <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{item.description}</p>
                )}
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {details(kind, item, t)}
                  {item.path && <span className="font-mono"> · {shortenPath(item.path, project?.homeDir)}</span>}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}

export function ComingSoonPage({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();
  return (
    <main className="flex flex-1 items-center justify-center p-6 text-center">
      <div>
        <h1 className="text-xl font-bold tracking-tight">{t(titleKey)}</h1>
        <p className="mt-1 text-xs text-muted-foreground">{t('resources.comingPhase6')}</p>
      </div>
    </main>
  );
}
