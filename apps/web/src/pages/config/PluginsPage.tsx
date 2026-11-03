// SPDX-License-Identifier: Apache-2.0
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Power, RefreshCw, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { ResourceItem } from '@/features/resources/types';
import { ConfigHeader, useInvalidateResources, useResourceList } from '@/features/config/ConfigList';
import { ConfigGenerateDialog, FilesPreview } from '@/features/config/ConfigGenerateDialog';

interface PluginDetails {
  agents: string[];
  commands: string[];
  skills: string[];
  mcpServers: string[];
  hooks: string[];
}

interface Marketplace {
  name: string;
  lastUpdated?: string;
  plugins: Array<{ id: string; name: string; description: string; category?: string; installed: boolean }>;
}

interface GeneratedPlugin {
  name: string;
  description: string;
  files: Array<{ path: string; content: string }>;
}

/** Plugins (UI-WIREFRAMES 12): installed (on/off, details, uninstall) and marketplace (install). */
export function PluginsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'installed' | 'marketplace'>('installed');
  const [scaffolding, setScaffolding] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const invalidate = useInvalidateResources();

  const run = async (fn: () => Promise<{ output?: string } | unknown>, done?: string) => {
    setNotice(null);
    try {
      const res = (await fn()) as { output?: string } | undefined;
      await invalidate();
      setNotice({ ok: true, text: done ?? res?.output ?? t('config.done') });
    } catch (err: any) {
      setNotice({ ok: false, text: err.message });
    }
  };

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      <ConfigHeader
        title={t('plugins')}
        actions={
          <>
            <div className="mr-2 flex rounded-md border border-border text-xs">
              {(['installed', 'marketplace'] as const).map((x) => (
                <button
                  key={x}
                  type="button"
                  onClick={() => setTab(x)}
                  className={cn('px-2.5 py-1', tab === x ? 'bg-accent font-medium' : 'text-muted-foreground')}
                >
                  {t(`config.pluginTabs.${x}`)}
                </button>
              ))}
            </div>
            <Button size="sm" variant="outline" onClick={() => setScaffolding(true)}>
              <Sparkles />
              {t('config.scaffoldPlugin')}
            </Button>
          </>
        }
      />
      {notice && (
        <p
          className={cn(
            'whitespace-pre-wrap border-b border-border px-4 py-1.5 text-[11px]',
            notice.ok
              ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300'
              : 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400'
          )}
        >
          {notice.text}
        </p>
      )}
      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'installed' ? <Installed run={run} /> : <MarketplaceTab run={run} />}
      </div>
      <p className="border-t border-border px-4 py-1.5 text-[10px] text-muted-foreground">
        {t('config.pluginRestartHint')}
      </p>
      {scaffolding && (
        <ConfigGenerateDialog<GeneratedPlugin>
          kind="plugin"
          title={t('config.scaffoldPlugin')}
          placeholder={t('config.pluginPlaceholder')}
          modes={[{ mode: 'generate', label: t('aiGenerate.generateNew') }]}
          renderResult={(r) => (
            <div className="space-y-1">
              <div>
                <span className="font-mono font-semibold">{r.name}/</span> — {r.description}
              </div>
              <FilesPreview files={r.files} />
              <p className="text-[10px] text-muted-foreground">{t('config.scaffoldHint', { name: r.name })}</p>
            </div>
          )}
          onApply={async (r) => {
            const res = await api<{ dir: string }>('/api/plugins/scaffold', { body: { name: r.name, files: r.files } });
            setScaffolding(false);
            setNotice({ ok: true, text: t('config.scaffolded', { dir: res.dir }) });
            await invalidate();
          }}
          onClose={() => setScaffolding(false)}
        />
      )}
    </main>
  );
}

type Run = (fn: () => Promise<unknown>, done?: string) => Promise<void>;

function Installed({ run }: { run: Run }) {
  const { t } = useTranslation();
  const { data: items = [] } = useResourceList('plugins');
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (id: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(id);
    await run(fn, done);
    setBusy(null);
  };
  if (!items.length) return <p className="text-xs text-muted-foreground">{t('config.noPlugins')}</p>;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border bg-card text-xs">
      {items.map((p) => {
        const c = p.metadata.components ?? {};
        return (
          <li key={p.id} className="px-3 py-2">
            <div className="flex items-center gap-3">
              <span>⧉</span>
              <span className="w-56 truncate font-medium">{p.name}</span>
              <span className="w-14 text-muted-foreground">{p.metadata.version ? `v${p.metadata.version}` : ''}</span>
              <Button
                size="sm"
                variant={p.metadata.enabled ? 'secondary' : 'outline'}
                className="h-6 text-[11px]"
                disabled={busy === p.id}
                onClick={() =>
                  void act(p.id, () =>
                    api('/api/plugins/enabled', { body: { id: p.name, enabled: !p.metadata.enabled } })
                  )
                }
              >
                <Power className={p.metadata.enabled ? 'text-emerald-500' : ''} />
                {p.metadata.enabled ? t('config.on') : t('config.off')}
              </Button>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {[
                  c.agents && t('resources.nAgents', { count: c.agents }),
                  c.skills && t('resources.nSkills', { count: c.skills }),
                  c.commands && t('resources.nCommands', { count: c.commands }),
                  c.mcpServers && t('resources.nMcp', { count: c.mcpServers }),
                  c.hooks && 'hooks',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-[11px]"
                onClick={() => setOpen(open === p.id ? null : p.id)}
              >
                {t('config.details')}
              </Button>
              {confirm === p.id ? (
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-6 text-[11px]"
                  disabled={busy === p.id}
                  onClick={() =>
                    void act(p.id, () => api('/api/plugins/uninstall', { body: { id: p.name } })).then(() =>
                      setConfirm(null)
                    )
                  }
                >
                  {t('config.confirmUninstall')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[11px] text-red-600"
                  onClick={() => setConfirm(p.id)}
                >
                  {t('config.uninstall')}
                </Button>
              )}
            </div>
            {p.description && <p className="pl-6 text-[11px] text-muted-foreground">{p.description}</p>}
            {open === p.id && <PluginDetailsRow item={p} />}
          </li>
        );
      })}
    </ul>
  );
}

function PluginDetailsRow({ item }: { item: ResourceItem }) {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ['resources', 'plugin', item.id],
    queryFn: () => api<{ details: PluginDetails }>(`/api/resources/plugins/${item.id}`),
  });
  const d = data?.details;
  if (!d) return <p className="pl-6 pt-1 text-muted-foreground">{t('composer.loading')}</p>;
  const row = (label: string, names: string[]) => (
    <div>
      <span className="text-muted-foreground">{label}:</span> {names.length ? names.join(', ') : '—'}
    </div>
  );
  return (
    <div className="mt-1 space-y-0.5 rounded-md bg-muted/40 p-2 pl-6 text-[11px]">
      {row(t('agents'), d.agents)}
      {row(t('skills'), d.skills)}
      {row(t('commands'), d.commands)}
      {row(t('mcp'), d.mcpServers)}
      {row('Hooks', d.hooks)}
      <div className="font-mono text-[10px] text-muted-foreground">{item.path}</div>
    </div>
  );
}

function MarketplaceTab({ run }: { run: Run }) {
  const { t } = useTranslation();
  const { data: markets = [], refetch } = useQuery({
    queryKey: ['resources', 'marketplaces'],
    queryFn: () => api<Marketplace[]>('/api/plugins/marketplaces'),
  });
  const [market, setMarket] = useState<string>('');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const current = markets.find((m) => m.name === market) ?? markets[0];
  const plugins = useMemo(
    () =>
      (current?.plugins ?? []).filter((p) => `${p.name} ${p.description}`.toLowerCase().includes(query.toLowerCase())),
    [current, query]
  );
  const act = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    await run(fn, done);
    await refetch();
    setBusy(null);
  };

  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">{t('config.marketplaces')}:</span>
        <select
          value={current?.name ?? ''}
          onChange={(e) => setMarket(e.target.value)}
          className="rounded-md border border-input bg-background px-2 py-1"
        >
          {markets.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name} ({m.plugins.length})
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-[11px]"
          disabled={busy === 'update'}
          onClick={() => void act('update', () => api('/api/plugins/marketplaces/update', { body: {} }))}
        >
          <RefreshCw className={busy === 'update' ? 'animate-spin' : ''} />
          {t('config.updateMarketplaces')}
        </Button>
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (source.trim())
              void act('add', () => api('/api/plugins/marketplaces', { body: { source } })).then(() => setSource(''));
          }}
        >
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="owner/repo or URL"
            className="w-48 rounded-md border border-input bg-background px-2 py-1 font-mono"
          />
          <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={!source.trim() || busy === 'add'}>
            {t('config.addMarketplace')}
          </Button>
        </form>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('config.searchPlugins')}
          className="ml-auto w-56 rounded-md border border-input bg-background px-2 py-1"
        />
      </div>
      {!markets.length && <p className="text-muted-foreground">{t('config.noMarketplaces')}</p>}
      <ul className="divide-y divide-border rounded-lg border border-border bg-card">
        {plugins.slice(0, 200).map((p) => (
          <li key={p.id} className="flex items-center gap-3 px-3 py-2">
            <span>⧉</span>
            <span className="w-48 truncate font-medium">{p.name}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={p.description}>
              {p.description}
            </span>
            {p.installed ? (
              <span className="text-emerald-600">✓ {t('config.installed')}</span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[11px]"
                disabled={busy === p.id}
                onClick={() => void act(p.id, () => api('/api/plugins/install', { body: { id: p.id } }))}
              >
                {busy === p.id ? t('config.installing') : t('config.install')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {plugins.length > 200 && (
        <p className="text-muted-foreground">{t('config.moreResults', { count: plugins.length - 200 })}</p>
      )}
    </div>
  );
}
