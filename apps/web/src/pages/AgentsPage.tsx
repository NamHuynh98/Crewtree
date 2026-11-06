// SPDX-License-Identifier: Apache-2.0
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { AlertTriangle, Copy, MoreHorizontal, Pencil, Plus, Upload } from 'lucide-react';
import { api } from '@/lib/api';
import { useAgents } from '@/features/resources/useAgents';
import { Button } from '@/components/ui/button';
import { ScopeBadge } from '@/features/resources/ScopeBadge';
import { WRITABLE_SCOPES, type ResourceItem, type Scope, type WritableScope } from '@/features/resources/types';
import { ModelPicker, useModelCatalog } from '@/features/model-picker/ModelPicker';
import { modelAvailable, modelLabel } from '@/features/model-picker/models';

const COLOR_BAR: Record<string, string> = {
  violet: 'bg-violet-500',
  purple: 'bg-violet-500',
  blue: 'bg-blue-500',
  cyan: 'bg-cyan-500',
  green: 'bg-emerald-500',
  yellow: 'bg-yellow-500',
  orange: 'bg-orange-500',
  red: 'bg-red-500',
  pink: 'bg-pink-500',
};

const menuItem =
  'flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none focus:bg-accent data-[disabled]:opacity-50';

export { useAgents };

/** Agents library (UI-WIREFRAMES 7): every agent from every source, editable where it is ours. */
export function AgentsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: agents = [], isLoading } = useAgents();
  const { data: catalog } = useModelCatalog();
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<'all' | Scope>('all');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkModel, setBulkModel] = useState<string | undefined>('sonnet');
  const [bulkPreview, setBulkPreview] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ResourceItem | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  const visible = useMemo(
    () =>
      agents.filter(
        (a) =>
          (scope === 'all' || a.scope === scope) &&
          `${a.name} ${a.description}`.toLowerCase().includes(search.toLowerCase())
      ),
    [agents, scope, search]
  );

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['resources'] });
  const run = async (fn: () => Promise<unknown>, success: string) => {
    try {
      await fn();
      setMessage({ text: success });
      await refresh();
    } catch (err: any) {
      setMessage({ text: err.message, error: true });
    }
  };

  const duplicate = (a: ResourceItem) =>
    run(
      async () => {
        const res = await api<{ item: ResourceItem }>(`/api/resources/agents/${a.id}/duplicate`, { body: {} });
        navigate(`/agents/${res.item.id}`);
      },
      t('agentsPage.duplicated', { name: a.name })
    );

  const move = (a: ResourceItem, target: WritableScope) =>
    run(
      () => api(`/api/resources/agents/${a.id}/move`, { body: { scope: target } }),
      t('agentsPage.moved', { name: a.name, scope: t(`scope.${target}`) })
    );

  const remove = (a: ResourceItem) =>
    run(() => api(`/api/resources/agents/${a.id}`, { method: 'DELETE' }), t('agentsPage.deleted', { name: a.name }));

  /** Import .md: a definition file from disk becomes a User agent, then opens in the editor. */
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    const content = await file.text();
    await run(
      async () => {
        const res = await api<{ item: ResourceItem }>('/api/resources/agents', { body: { scope: 'user', content } });
        navigate(`/agents/${res.item.id}`);
      },
      t('agentsPage.imported', { name: file.name })
    );
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectedAgents = agents.filter((a) => selected.has(a.id));
  const applyBulk = () =>
    run(
      async () => {
        const res = await api<{ results: Array<{ name: string; ok: boolean; error?: string }> }>(
          '/api/agents/bulk-model',
          {
            body: { ids: [...selected], model: bulkModel },
          }
        );
        const failed = res.results.filter((r) => !r.ok);
        if (failed.length) throw new Error(failed.map((f) => `${f.name}: ${f.error}`).join('; '));
        setSelected(new Set());
        setSelecting(false);
        setBulkPreview(false);
      },
      t('agentsPage.bulkDone', { count: selected.size, model: bulkModel })
    );

  return (
    <main className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-4">
          <h1 className="mr-auto text-xl font-bold tracking-tight">{t('agents')}</h1>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('agentsPage.search')}
            className="w-48 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs"
            aria-label={t('agentsPage.search')}
          />
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as 'all' | Scope)}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
            aria-label={t('agentsPage.scope')}
          >
            <option value="all">{t('agentsPage.allScopes')}</option>
            {(['crewtree', 'user', 'project', 'plugin', 'builtin'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`scope.${s}`)}
              </option>
            ))}
          </select>
          <Button size="sm" variant={selecting ? 'secondary' : 'outline'} onClick={() => setSelecting((v) => !v)}>
            {t('agentsPage.bulkModel')}
          </Button>
          <Button size="sm" variant="outline" asChild>
            <label className="cursor-pointer">
              <Upload />
              {t('agentsPage.import')}
              <input
                type="file"
                accept=".md,text/markdown"
                className="hidden"
                onChange={(e) => {
                  void importFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </label>
          </Button>
          <Button size="sm" asChild>
            <Link to="/agents/new">
              <Plus />
              {t('agentsPage.newAgent')}
            </Link>
          </Button>
        </div>

        {message && (
          <p className={`text-xs ${message.error ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}>
            {message.text}
          </p>
        )}
        {isLoading && <p className="text-xs text-muted-foreground">…</p>}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map((a) => {
            const m = a.metadata;
            const available = modelAvailable(m.model, catalog);
            const tools = m.tools as string[] | null;
            return (
              <div
                key={a.id}
                className={`relative flex flex-col overflow-hidden rounded-lg border border-border bg-card pl-3 shadow-sm ${a.shadowedBy ? 'opacity-70' : ''}`}
              >
                <span
                  className={`absolute inset-y-0 left-0 w-1 ${COLOR_BAR[String(m.color)] ?? 'bg-border'}`}
                  aria-hidden
                />
                <div className="flex flex-1 flex-col gap-1.5 p-3 pl-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {selecting && !a.readOnly && (
                        <input
                          type="checkbox"
                          checked={selected.has(a.id)}
                          onChange={() => toggle(a.id)}
                          aria-label={a.name}
                        />
                      )}
                      <span className="truncate text-sm font-semibold">{a.name}</span>
                    </div>
                    <ScopeBadge scope={a.scope} plugin={a.plugin} readOnly={a.readOnly} />
                  </div>
                  <p className="line-clamp-2 text-[11px] text-muted-foreground" title={a.description}>
                    {a.description || '—'}
                  </p>
                  <div className="mt-auto space-y-0.5 text-[11px] text-muted-foreground">
                    <div className="flex items-center gap-1">
                      {available === false && (
                        <AlertTriangle className="h-3 w-3 text-amber-500" aria-label={t('models.unavailable')} />
                      )}
                      <span className={available === false ? 'text-amber-600 dark:text-amber-400' : ''}>
                        {modelLabel(m.model, catalog)}
                      </span>
                      <span>·</span>
                      <span>
                        {tools === null ? t('agentsPage.allTools') : t('agentsPage.tools', { count: tools.length })}
                      </span>
                    </div>
                    {m.canDelegate && (
                      <div className="truncate">
                        {t('agentsPage.delegates')} →{' '}
                        {m.delegates === '*' ? t('agentsPage.anyAgent') : (m.delegates as string[]).join(', ')}
                      </div>
                    )}
                    {(m.skills as string[])?.length > 0 && (
                      <div>✦ {t('agentsPage.skills', { count: m.skills.length })}</div>
                    )}
                    {a.shadowedBy && <div>{t('agentsPage.shadowedBy', { scope: t(`scope.${a.shadowedBy}`) })}</div>}
                  </div>
                  <div className="mt-1.5 flex items-center gap-1">
                    {a.readOnly ? (
                      a.path && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-[11px]"
                          onClick={() => void duplicate(a)}
                        >
                          <Copy />
                          {t('agentsPage.duplicateAsMine')}
                        </Button>
                      )
                    ) : (
                      <>
                        <Button size="sm" variant="outline" className="h-7 text-[11px]" asChild>
                          <Link to={`/agents/${a.id}`}>
                            <Pencil />
                            {t('actions.edit')}
                          </Link>
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => void duplicate(a)}>
                          {t('actions.duplicate')}
                        </Button>
                      </>
                    )}
                    {a.path && (
                      <Menu.Root>
                        <Menu.Trigger
                          className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                          aria-label={t('agentsPage.more')}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Menu.Trigger>
                        <Menu.Portal>
                          <Menu.Content
                            align="end"
                            sideOffset={4}
                            className="z-50 min-w-[11rem] rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
                          >
                            <Menu.Item className={menuItem} asChild>
                              <a href={`/api/resources/agents/${a.id}/export`} download={`${a.name}.md`}>
                                {t('agentsPage.export')}
                              </a>
                            </Menu.Item>
                            {!a.readOnly && (
                              <>
                                <Menu.Item
                                  className={menuItem}
                                  onSelect={() => navigate(`/agents/${a.id}?tab=history`)}
                                >
                                  {t('agentsPage.history')}
                                </Menu.Item>
                                <Menu.Sub>
                                  <Menu.SubTrigger className={menuItem}>{t('agentsPage.moveTo')}</Menu.SubTrigger>
                                  <Menu.Portal>
                                    <Menu.SubContent className="z-50 min-w-[8rem] rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
                                      {WRITABLE_SCOPES.map((s) => (
                                        <Menu.Item
                                          key={s}
                                          className={menuItem}
                                          disabled={s === a.scope}
                                          onSelect={() => void move(a, s)}
                                        >
                                          {t(`scope.${s}`)}
                                        </Menu.Item>
                                      ))}
                                    </Menu.SubContent>
                                  </Menu.Portal>
                                </Menu.Sub>
                                <Menu.Separator className="my-1 h-px bg-border" />
                                <Menu.Item
                                  className={`${menuItem} text-red-600 dark:text-red-400`}
                                  onSelect={() => setConfirmDelete(a)}
                                >
                                  {t('actions.delete')}
                                </Menu.Item>
                              </>
                            )}
                          </Menu.Content>
                        </Menu.Portal>
                      </Menu.Root>
                    )}
                  </div>
                  {confirmDelete?.id === a.id && (
                    <div className="mt-1.5 rounded-md border border-red-200 bg-red-50 p-2 text-[11px] dark:border-red-900 dark:bg-red-950/30">
                      <p>{t('agentsPage.confirmDelete', { name: a.name, path: a.path })}</p>
                      <div className="mt-1.5 flex gap-1.5">
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-6 text-[11px]"
                          onClick={() => {
                            setConfirmDelete(null);
                            void remove(a);
                          }}
                        >
                          {t('actions.delete')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-[11px]"
                          onClick={() => setConfirmDelete(null)}
                        >
                          {t('actions.cancel')}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {selecting && (
          <div className="sticky bottom-0 space-y-2 rounded-lg border border-border bg-card p-3 shadow-lg">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium">{t('agentsPage.selected', { count: selected.size })}</span>
              <ModelPicker value={bulkModel} onChange={setBulkModel} allowInherit={false} className="w-72" />
              <Button size="sm" disabled={!selected.size || !bulkModel} onClick={() => setBulkPreview(true)}>
                {t('agentsPage.previewChanges')}
              </Button>
            </div>
            {bulkPreview && (
              <div className="space-y-1.5 text-[11px]">
                <p className="text-muted-foreground">{t('agentsPage.bulkPreview', { model: bulkModel })}</p>
                <ul className="max-h-40 overflow-y-auto font-mono">
                  {selectedAgents.map((a) => (
                    <li key={a.id}>
                      {a.path}{' '}
                      <span className="text-muted-foreground">
                        ({a.metadata.model ?? 'inherit'} → {bulkModel})
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="flex gap-1.5">
                  <Button size="sm" onClick={() => void applyBulk()}>
                    {t('agentsPage.apply')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setBulkPreview(false)}>
                    {t('actions.cancel')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
