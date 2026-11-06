// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { ChevronDown, FolderOpen } from 'lucide-react';
import { api } from '@/lib/api';
import { shortenPath } from '@/lib/paths';
import type { ProjectInfo } from './shell';

interface ProjectsResponse {
  current: ProjectInfo;
  recent: Array<{ id: string; path: string; name: string; lastOpenedAt: number }>;
}

/** Project switcher (UI-WIREFRAMES 0): decides which `<cwd>/.claude` is loaded as project scope. */
export function ProjectSwitcher() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['projects'], queryFn: () => api<ProjectsResponse>('/api/projects') });
  const [folder, setFolder] = useState('');
  const [error, setError] = useState<string | null>(null);
  const current = data?.current;

  const open = async (path: string) => {
    setError(null);
    try {
      await api('/api/projects/open', { body: { path } });
      setFolder('');
      await queryClient.invalidateQueries();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger
        className="flex min-w-0 max-w-[min(32rem,100%)] items-center gap-1.5 text-xs text-muted-foreground bg-muted px-2.5 py-1 rounded-md border border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        title={current?.path}
      >
        <span className="shrink-0">{t('project')}:</span>
        {/* One line; a long path is cut at the start so the project folder stays visible */}
        <span dir="rtl" className="min-w-0 truncate font-medium text-foreground font-mono">
          <bdi dir="ltr">{current ? shortenPath(current.path, current.homeDir) : '…'}</bdi>
        </span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="start"
          sideOffset={4}
          className="z-50 w-80 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t('projects.recent')}
          </div>
          {(data?.recent ?? []).length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('projects.none')}</div>
          )}
          {(data?.recent ?? []).map((p) => (
            <DropdownMenuPrimitive.Item
              key={p.id}
              onSelect={() => void open(p.path)}
              className="flex cursor-default select-none flex-col rounded-sm px-2 py-1.5 text-xs outline-none focus:bg-accent"
            >
              <span className="truncate font-medium">{p.name}</span>
              <span dir="rtl" className="truncate text-left font-mono text-[10px] text-muted-foreground" title={p.path}>
                <bdi dir="ltr">{shortenPath(p.path, current?.homeDir)}</bdi>
              </span>
            </DropdownMenuPrimitive.Item>
          ))}
          <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
          <form
            className="flex items-center gap-1.5 p-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (folder.trim()) void open(folder.trim());
            }}
          >
            <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder={t('projects.openPlaceholder')}
              className="flex-1 rounded border border-input bg-background px-2 py-1 font-mono text-[11px]"
              aria-label={t('projects.open')}
            />
          </form>
          {error && <p className="px-2 pb-1.5 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
