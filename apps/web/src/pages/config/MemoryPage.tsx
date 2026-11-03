// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { FilePlus, Sparkles, Wand2 } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { shortenPath } from '@/lib/paths';
import { useIsDark } from '@/lib/useIsDark';
import { useShell } from '@/app/shell';
import { Button } from '@/components/ui/button';
import { DiffView } from '@/features/resources/DiffView';
import type { ResourceDetail, ResourceItem } from '@/features/resources/types';
import { ConfigHeader, Empty, useInvalidateResources, useResourceList } from '@/features/config/ConfigList';
import { FileEditor } from '@/features/config/FileEditor';
import { ConfigGenerateDialog } from '@/features/config/ConfigGenerateDialog';

interface GeneratedMemory {
  content: string;
  summary: string;
}

type Target = 'user' | 'project' | 'local' | 'auto';

/** Memory (UI-WIREFRAMES 10): CLAUDE.md files with their @import tree, local memory, auto memory. */
export function MemoryPage() {
  const { t } = useTranslation();
  const { project } = useShell();
  const { data: items = [] } = useResourceList('memory');
  const invalidate = useInvalidateResources();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [ai, setAi] = useState<'add-rule' | 'cleanup' | null>(null);
  const [newAuto, setNewAuto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = items.find((i) => i.id === selectedId);
  const dark = useIsDark();

  useEffect(() => {
    if (!selectedId && items.length) setSelectedId(items[0].id);
  }, [items, selectedId]);

  const { data: detail, refetch } = useQuery({
    queryKey: ['resources', 'memory', selectedId],
    queryFn: () => api<ResourceDetail>(`/api/resources/memory/${selectedId}`),
    enabled: !!selectedId,
  });
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => setValue(null), [selectedId]);
  useEffect(() => {
    if (detail?.content !== undefined && value === null) setValue(detail.content);
  }, [detail, value]);

  // Group: USER / PROJECT / LOCAL / AUTO MEMORY, imports nested under the file that imports them
  const groups = useMemo(() => {
    const roots = items.filter((i) => i.metadata.role !== 'import');
    const childrenOf = (file?: string) =>
      items.filter((i) => i.metadata.role === 'import' && i.metadata.importedBy === file);
    return (['user', 'project', 'local', 'auto'] as const).map((role) => ({
      role,
      roots: roots.filter((i) => i.metadata.role === role),
      childrenOf,
    }));
  }, [items]);

  const missing = (['user', 'project', 'local'] as const).filter(
    (role) => !items.some((i) => i.metadata.role === role)
  );

  const create = async (target: Target, fileName?: string) => {
    setError(null);
    try {
      const res = await api<{ item: ResourceItem }>('/api/resources/memory', {
        body: { target, fileName, content: target === 'auto' ? '' : '# Instructions\n\n' },
      });
      await invalidate();
      setSelectedId(res.item.id);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const renderItem = (
    item: ResourceItem,
    depth: number,
    childrenOf: (f?: string) => ResourceItem[]
  ): React.ReactNode => (
    <li key={item.id}>
      <button
        type="button"
        onClick={() => setSelectedId(item.id)}
        className={cn(
          'flex w-full items-center gap-1 rounded px-2 py-1 text-left font-mono hover:bg-accent',
          selectedId === item.id && 'bg-accent'
        )}
        style={{ paddingLeft: 8 + depth * 14 }}
        title={item.path}
      >
        <span className="truncate">
          {depth > 0
            ? `@${item.name}`
            : item.metadata.role === 'auto'
              ? item.name
              : shortenPath(item.path ?? item.name, project?.homeDir)}
        </span>
      </button>
      <ul>{childrenOf(item.path).map((c) => renderItem(c, depth + 1, childrenOf))}</ul>
    </li>
  );

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      <ConfigHeader
        title={t('memory')}
        actions={
          <Button size="sm" variant="outline" disabled={!selected} onClick={() => setAi('add-rule')}>
            <Sparkles />
            {t('config.aiAddRule')}
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-72 shrink-0 flex-col border-r border-border text-xs">
          <div className="flex-1 overflow-y-auto p-2">
            {groups.map((g) => (
              <div key={g.role} className="mb-3">
                <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t(`config.memoryGroup.${g.role}`)}
                  {g.role === 'auto' && g.roots.length > 0 && ` (${g.roots.length})`}
                </div>
                <ul>{g.roots.map((r) => renderItem(r, 0, g.childrenOf))}</ul>
                {g.role === 'auto' &&
                  (newAuto === null ? (
                    <button
                      type="button"
                      className="px-2 py-1 text-[11px] text-primary hover:underline"
                      onClick={() => setNewAuto('')}
                    >
                      <FilePlus className="mr-1 inline h-3 w-3" />
                      {t('config.newAutoMemory')}
                    </button>
                  ) : (
                    <form
                      className="px-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (newAuto.trim()) void create('auto', newAuto.trim()).then(() => setNewAuto(null));
                      }}
                    >
                      <input
                        autoFocus
                        value={newAuto}
                        onChange={(e) => setNewAuto(e.target.value)}
                        onBlur={() => !newAuto && setNewAuto(null)}
                        placeholder="notes.md"
                        className="w-full rounded border border-input bg-background px-1.5 py-1 font-mono text-[11px]"
                      />
                    </form>
                  ))}
              </div>
            ))}
            {missing.length > 0 && (
              <div className="space-y-1 border-t border-border px-2 pt-2">
                {missing.map((role) => (
                  <button
                    key={role}
                    type="button"
                    className="block text-[11px] text-primary hover:underline"
                    onClick={() => void create(role)}
                  >
                    + {t(`config.createMemory.${role}`)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="border-t border-border p-2">
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={!selected}
              onClick={() => setAi('cleanup')}
            >
              <Wand2 />
              {t('config.aiCleanup')}
            </Button>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {error && <p className="border-b border-border bg-red-50 px-4 py-1 text-[11px] text-red-700">{error}</p>}
          {!selected || value === null ? (
            <Empty text={t('config.pickMemory')} />
          ) : (
            <>
              {(selected.metadata.imports as string[] | undefined)?.length ? (
                <div className="flex flex-wrap gap-1 border-b border-border px-3 py-1 text-[11px]">
                  <span className="text-muted-foreground">{t('config.imports')}:</span>
                  {(selected.metadata.imports as string[]).map((p) => {
                    const target = items.find((i) => i.path === p);
                    return (
                      <button
                        key={p}
                        type="button"
                        disabled={!target}
                        className="font-mono text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
                        onClick={() => target && setSelectedId(target.id)}
                        title={p}
                      >
                        @{p.split('/').pop()}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <FileEditor
                key={selected.id}
                path={selected.path ?? selected.name}
                value={value}
                original={detail?.content ?? ''}
                onChange={setValue}
                revisions={detail?.revisions}
                onSave={async (content) => {
                  await api(`/api/resources/memory/${selected.id}`, { method: 'PUT', body: { content } });
                  await invalidate();
                  await refetch();
                }}
                onRollback={async (revisionId) => {
                  await api(`/api/resources/memory/${selected.id}/rollback`, { body: { revisionId } });
                  const fresh = await refetch();
                  setValue(fresh.data?.content ?? '');
                }}
              />
            </>
          )}
        </div>
      </div>
      {ai && selected && value !== null && (
        <ConfigGenerateDialog<GeneratedMemory>
          kind="memory"
          title={
            ai === 'add-rule'
              ? t('config.aiAddRuleTitle', { file: selected.name })
              : t('config.aiCleanupTitle', { file: selected.name })
          }
          placeholder={ai === 'add-rule' ? t('config.rulePlaceholder') : t('config.cleanupPlaceholder')}
          current={value}
          modes={
            ai === 'add-rule'
              ? [{ mode: 'add-rule', label: t('config.addRule') }]
              : [{ mode: 'cleanup', label: t('config.cleanUp') }]
          }
          renderResult={(r) => (
            <div className="space-y-1">
              {r.summary && <p>{r.summary}</p>}
              <div className="overflow-auto rounded-md border border-input">
                <DiffView before={value} after={r.content} dark={dark} />
              </div>
              <p className="text-[10px] text-muted-foreground">{t('config.applyHint')}</p>
            </div>
          )}
          onApply={async (r) => {
            // Applying fills the editor; Save still shows the diff and writes a revision
            setValue(r.content);
            setAi(null);
          }}
          onClose={() => setAi(null)}
        />
      )}
    </main>
  );
}
