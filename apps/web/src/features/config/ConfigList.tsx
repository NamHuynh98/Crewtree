// SPDX-License-Identifier: Apache-2.0
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ScopeBadge } from '@/features/resources/ScopeBadge';
import type { ResourceItem } from '@/features/resources/types';

export function useResourceList(kindPath: string) {
  return useQuery({
    queryKey: ['resources', kindPath],
    queryFn: () => api<ResourceItem[]>(`/api/resources/${kindPath}`),
  });
}

export function useInvalidateResources() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['resources'] });
}

/** Left column of the config pages (UI-WIREFRAMES 9): search, scope filter, items with source badges. */
export function ConfigList({
  items,
  selectedId,
  onSelect,
  icon,
  footer,
}: {
  items: ResourceItem[];
  selectedId?: string;
  onSelect: (item: ResourceItem) => void;
  icon?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('all');
  const shown = useMemo(
    () =>
      items.filter(
        (i) =>
          (scope === 'all' || i.scope === scope) &&
          `${i.name} ${i.description}`.toLowerCase().includes(query.toLowerCase())
      ),
    [items, scope, query]
  );
  const scopes = [...new Set(items.map((i) => i.scope))];
  return (
    <div className="flex w-72 shrink-0 flex-col border-r border-border text-xs">
      <div className="flex gap-1.5 border-b border-border p-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('resources.search')}
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1"
        />
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="rounded-md border border-input bg-background px-1 py-1"
          aria-label={t('agentsPage.scope')}
        >
          <option value="all">{t('agentsPage.allScopes')}</option>
          {scopes.map((s) => (
            <option key={s} value={s}>
              {t(`scope.${s}`)}
            </option>
          ))}
        </select>
      </div>
      <ul className="flex-1 overflow-y-auto p-1">
        {shown.length === 0 && <li className="p-3 text-muted-foreground">{t('resources.empty')}</li>}
        {shown.map((i) => (
          <li key={i.id}>
            <button
              type="button"
              onClick={() => onSelect(i)}
              className={cn(
                'w-full rounded-md px-2 py-1.5 text-left hover:bg-accent',
                selectedId === i.id && 'bg-accent'
              )}
            >
              <div className="flex items-center gap-1.5">
                {icon}
                <span className={cn('truncate font-medium', i.shadowedBy && 'line-through opacity-60')}>{i.name}</span>
                <span className="ml-auto shrink-0">
                  <ScopeBadge scope={i.scope} plugin={i.plugin} readOnly={i.readOnly} />
                </span>
              </div>
              {i.description && <div className="truncate text-[11px] text-muted-foreground">{i.description}</div>}
            </button>
          </li>
        ))}
      </ul>
      {footer}
    </div>
  );
}

/** Page header with search-free title row and actions (UI-WIREFRAMES 9). */
export function ConfigHeader({ title, actions }: { title: string; actions?: React.ReactNode }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-4">
      <h1 className="text-sm font-semibold">{title}</h1>
      <div className="ml-auto flex items-center gap-2">{actions}</div>
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">{text}</div>
  );
}
