// SPDX-License-Identifier: Apache-2.0
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Popover from '@radix-ui/react-dropdown-menu';
import { AlertTriangle, Check, ChevronDown, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import type { ModelCatalog } from '@/features/resources/types';
import { modelAvailable, modelLabel } from './models';

export function useModelCatalog() {
  return useQuery({ queryKey: ['models'], queryFn: () => api<ModelCatalog>('/api/models'), staleTime: 5 * 60_000 });
}

/** Model picker of UI-WIREFRAMES 8: the models the logged-in account can use, plus inherit. */
export function ModelPicker({
  value,
  onChange,
  allowInherit = true,
  className,
}: {
  value: string | undefined;
  onChange: (model: string | undefined) => void;
  allowInherit?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: catalog } = useModelCatalog();
  const [search, setSearch] = useState('');
  const available = modelAvailable(value, catalog);
  const models = useMemo(
    () =>
      (catalog?.models ?? []).filter(
        (m) =>
          m.value !== 'inherit' &&
          `${m.displayName} ${m.value} ${m.description}`.toLowerCase().includes(search.toLowerCase())
      ),
    [catalog, search]
  );

  const refresh = async () => {
    const fresh = await api<ModelCatalog>('/api/models/refresh', { body: {} });
    queryClient.setQueryData(['models'], fresh);
  };

  return (
    <div className={`flex items-center gap-1.5 ${className ?? ''}`}>
      <Popover.Root>
        <Popover.Trigger className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            {available === false && (
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label={t('models.unavailable')} />
            )}
            <span className="truncate">{value ? modelLabel(value, catalog) : t('models.inherit')}</span>
            {value && modelLabel(value, catalog) !== value && (
              <span className="font-mono text-[10px] text-muted-foreground">{value}</span>
            )}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={4}
            className="z-50 w-80 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          >
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder={t('models.search')}
              className="mb-1 w-full rounded border border-input bg-background px-2 py-1 text-xs"
              aria-label={t('models.search')}
            />
            <div className="max-h-64 overflow-y-auto">
              {models.map((m) => (
                <Popover.Item
                  key={m.value}
                  onSelect={() => onChange(m.value)}
                  className="flex cursor-default select-none items-start gap-2 rounded-sm px-2 py-1.5 text-xs outline-none focus:bg-accent"
                >
                  <Check className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${m.value === value ? 'opacity-100' : 'opacity-0'}`} />
                  <span className="min-w-0">
                    <span className="block font-medium">{m.displayName}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {m.resolvedModel ?? m.value} · {m.description}
                    </span>
                  </span>
                </Popover.Item>
              ))}
              {allowInherit && (
                <Popover.Item
                  onSelect={() => onChange(undefined)}
                  className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none focus:bg-accent"
                >
                  <Check className={`h-3.5 w-3.5 ${!value ? 'opacity-100' : 'opacity-0'}`} />
                  <span>
                    {t('models.inherit')} <span className="text-muted-foreground">· {t('models.inheritHint')}</span>
                  </span>
                </Popover.Item>
              )}
            </div>
            {catalog?.source === 'fallback' && (
              <p className="px-2 pb-1 text-[10px] text-muted-foreground">{t('models.fallback')}</p>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <button
        type="button"
        onClick={() => void refresh()}
        className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        title={t('models.refresh')}
        aria-label={t('models.refresh')}
      >
        <RefreshCw className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
