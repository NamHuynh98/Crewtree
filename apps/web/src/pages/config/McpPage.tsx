// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Eye, Plus, Power, Sparkles, Trash2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ScopeBadge } from '@/features/resources/ScopeBadge';
import type { ResourceItem } from '@/features/resources/types';
import { ConfigHeader, useInvalidateResources, useResourceList } from '@/features/config/ConfigList';
import { ConfigGenerateDialog } from '@/features/config/ConfigGenerateDialog';

const MASK = '••••';

interface McpConfig {
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface TestResult {
  ok: boolean;
  serverName?: string;
  tools?: string[];
  error?: string;
  durationMs: number;
}

interface GeneratedMcp {
  name: string;
  config: McpConfig;
  notes: string;
}

/** MCP servers (UI-WIREFRAMES 11): list, test, edit form with masked secrets, project approvals. */
export function McpPage() {
  const { t } = useTranslation();
  const { data: items = [] } = useResourceList('mcp');
  const invalidate = useInvalidateResources();
  const [tests, setTests] = useState<Record<string, TestResult | 'running'>>({});
  const [editing, setEditing] = useState<{ item?: ResourceItem; draft: Draft } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const test = async (item: ResourceItem) => {
    setTests((prev) => ({ ...prev, [item.id]: 'running' }));
    try {
      const res = await api<TestResult>('/api/mcp/test', { body: { id: item.id } });
      setTests((prev) => ({ ...prev, [item.id]: res }));
    } catch (err: any) {
      setTests((prev) => ({ ...prev, [item.id]: { ok: false, error: err.message, durationMs: 0 } }));
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await invalidate();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      <ConfigHeader
        title={t('config.mcpTitle')}
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setGenerating(true)}>
              <Sparkles />
              {t('config.createMcpAi')}
            </Button>
            <Button size="sm" onClick={() => setEditing({ draft: emptyDraft() })}>
              <Plus />
              {t('config.add')}
            </Button>
          </>
        }
      />
      {error && (
        <p className="border-b border-border bg-red-50 px-4 py-1 text-[11px] text-red-700 dark:bg-red-950/30 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="flex-1 overflow-y-auto p-4">
        <ul className="divide-y divide-border rounded-lg border border-border bg-card text-xs">
          {items.length === 0 && <li className="p-4 text-muted-foreground">{t('config.noMcp')}</li>}
          {items.map((item) => {
            const result = tests[item.id];
            return (
              <li key={item.id} className="flex items-center gap-3 px-3 py-2">
                <span
                  className={
                    result && result !== 'running'
                      ? result.ok
                        ? 'text-emerald-500'
                        : 'text-red-500'
                      : 'text-muted-foreground'
                  }
                >
                  {item.scope === 'plugin' ? '⧉' : result && result !== 'running' && result.ok ? '●' : '○'}
                </span>
                <span className="w-36 truncate font-medium">{item.name}</span>
                <span className="w-12 font-mono text-muted-foreground">{item.metadata.type}</span>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
                  title={item.description}
                >
                  {item.description}
                </span>
                <ScopeBadge scope={item.scope} plugin={item.plugin} readOnly={item.readOnly} />
                <span className="w-44 truncate text-[11px]">
                  {result === 'running'
                    ? t('config.testing')
                    : result
                      ? result.ok
                        ? t('config.connected', { count: result.tools?.length ?? 0 })
                        : `✕ ${result.error}`
                      : ''}
                </span>
                <span className="flex shrink-0 gap-1">
                  <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => void test(item)}>
                    {t('config.test')}
                  </Button>
                  {!item.readOnly && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[11px]"
                      onClick={() => setEditing({ item, draft: draftOf(item) })}
                    >
                      {t('actions.edit')}
                    </Button>
                  )}
                  {item.scope === 'project' && <ProjectToggle item={item} onChanged={invalidate} />}
                  {!item.readOnly &&
                    (confirmDelete === item.id ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-6 text-[11px]"
                        onClick={() =>
                          void act(() => api(`/api/resources/mcp/${item.id}`, { method: 'DELETE' })).then(() =>
                            setConfirmDelete(null)
                          )
                        }
                      >
                        {t('config.confirmDelete')}
                      </Button>
                    ) : (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 text-red-600"
                        onClick={() => setConfirmDelete(item.id)}
                        aria-label={t('actions.delete')}
                      >
                        <Trash2 />
                      </Button>
                    ))}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-[10px] text-muted-foreground">{t('config.mcpHint')}</p>
      </div>
      {editing && (
        <McpForm
          item={editing.item}
          initial={editing.draft}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await invalidate();
            setEditing(null);
          }}
        />
      )}
      {generating && (
        <ConfigGenerateDialog<GeneratedMcp>
          kind="mcp"
          title={t('config.createMcpAi')}
          placeholder={t('config.mcpPlaceholder')}
          modes={[{ mode: 'generate', label: t('aiGenerate.generateNew') }]}
          renderResult={(r) => (
            <div className="space-y-1">
              <div className="font-mono font-semibold">{r.name}</div>
              <pre className="max-h-60 overflow-auto rounded-md border border-border p-2 font-mono text-[11px]">
                {JSON.stringify(r.config, null, 2)}
              </pre>
              {r.notes && <p className="text-muted-foreground">{r.notes}</p>}
              <p className="text-[10px] text-muted-foreground">{t('config.mcpApplyHint')}</p>
            </div>
          )}
          onApply={async (r) => {
            setGenerating(false);
            setEditing({ draft: { ...draftFromConfig(r.config), name: r.name, scope: 'local' } });
          }}
          onClose={() => setGenerating(false)}
        />
      )}
    </main>
  );
}

function ProjectToggle({ item, onChanged }: { item: ResourceItem; onChanged: () => void }) {
  const { t } = useTranslation();
  const { data, refetch } = useQuery({
    queryKey: ['resources', 'mcp', item.id],
    queryFn: () => api<{ approval?: 'enabled' | 'disabled' | 'pending' }>(`/api/resources/mcp/${item.id}`),
  });
  const approval = data?.approval ?? 'pending';
  return (
    <Button
      size="sm"
      variant={approval === 'enabled' ? 'secondary' : 'outline'}
      className="h-6 text-[11px]"
      title={t(`config.approval.${approval}`)}
      onClick={async () => {
        await api(`/api/mcp/${item.id}/enabled`, { body: { enabled: approval !== 'enabled' } });
        await refetch();
        onChanged();
      }}
    >
      <Power className={approval === 'enabled' ? 'text-emerald-500' : ''} />
      {t(`config.approval.${approval}`)}
    </Button>
  );
}

// ---------------------------------------------------------------- form

interface Draft {
  name: string;
  scope: 'user' | 'local' | 'project';
  type: 'stdio' | 'http' | 'sse';
  command: string;
  args: string;
  url: string;
  env: Array<[string, string]>;
  headers: Array<[string, string]>;
}

function emptyDraft(): Draft {
  return { name: '', scope: 'local', type: 'stdio', command: '', args: '', url: '', env: [], headers: [] };
}

function draftFromConfig(config: McpConfig): Omit<Draft, 'name' | 'scope'> {
  return {
    type: config.type ?? (config.url ? 'http' : 'stdio'),
    command: config.command ?? '',
    args: (config.args ?? []).map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' '),
    url: config.url ?? '',
    env: Object.entries(config.env ?? {}),
    headers: Object.entries(config.headers ?? {}),
  };
}

function draftOf(item: ResourceItem): Draft {
  return { ...draftFromConfig(item.metadata.config ?? {}), name: item.name, scope: item.scope as Draft['scope'] };
}

/** `-y "@scope/pkg" --flag` → ['-y', '@scope/pkg', '--flag'] (quotes keep spaces). */
function parseArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : (m[2] ?? m[3]));
  return out;
}

function toConfig(d: Draft): McpConfig {
  const pairs = (list: Array<[string, string]>) =>
    Object.fromEntries(list.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]));
  return d.type === 'stdio'
    ? { type: 'stdio', command: d.command.trim(), args: parseArgs(d.args), env: pairs(d.env) }
    : { type: d.type, url: d.url.trim(), headers: pairs(d.headers) };
}

function Pairs({
  label,
  rows,
  onChange,
}: {
  label: string;
  rows: Array<[string, string]>;
  onChange: (rows: Array<[string, string]>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="w-16">{label}</span>
        <button type="button" className="text-primary hover:underline" onClick={() => onChange([...rows, ['', '']])}>
          + {t('config.addVar')}
        </button>
      </div>
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-1 pl-16">
          <input
            value={k}
            onChange={(e) => onChange(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}
            placeholder="NAME"
            className="w-40 rounded border border-input bg-background px-1.5 py-1 font-mono"
          />
          <span>=</span>
          <input
            type={v === MASK ? 'password' : 'text'}
            value={v}
            onChange={(e) => onChange(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
            placeholder="value or ${ENV_VAR}"
            className="min-w-0 flex-1 rounded border border-input bg-background px-1.5 py-1 font-mono"
          />
          {v === MASK && (
            <span title={t('config.secretKept')}>
              <Eye className="h-3.5 w-3.5 text-muted-foreground" />
            </span>
          )}
          <button
            type="button"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            aria-label={t('actions.delete')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

function McpForm({
  item,
  initial,
  onClose,
  onSaved,
}: {
  item?: ResourceItem;
  initial: Draft;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [d, setD] = useState<Draft>(initial);
  const [result, setResult] = useState<TestResult | 'running' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }));
  const input = 'rounded-md border border-input bg-background px-2 py-1 font-mono';

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (item)
        await api(`/api/resources/mcp/${item.id}`, { method: 'PUT', body: { name: d.name, config: toConfig(d) } });
      else await api('/api/resources/mcp', { body: { scope: d.scope, name: d.name, config: toConfig(d) } });
      await onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onMouseDown={onClose}>
      <div
        className="w-full max-w-xl space-y-3 rounded-lg border border-border bg-card p-4 text-xs shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t('config.editMcp')}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">{item ? t('config.editMcp') : t('config.addMcp')}</span>
          <button onClick={onClose} aria-label={t('actions.close')}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-16">{t('editor.name')}</span>
          <input value={d.name} onChange={(e) => set({ name: e.target.value })} className={`${input} flex-1`} />
          <span>{t('config.scope')}</span>
          <select
            value={d.scope}
            disabled={!!item}
            onChange={(e) => set({ scope: e.target.value as Draft['scope'] })}
            className={input}
          >
            {(['local', 'project', 'user'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`scope.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <p className="pl-16 text-[10px] text-muted-foreground">{t(`config.mcpScopeHint.${d.scope}`)}</p>
        <div className="flex items-center gap-3">
          <span className="w-16">{t('config.type')}</span>
          {(['stdio', 'http', 'sse'] as const).map((type) => (
            <label key={type} className="flex items-center gap-1">
              <input type="radio" checked={d.type === type} onChange={() => set({ type })} />
              {type}
            </label>
          ))}
        </div>
        {d.type === 'stdio' ? (
          <>
            <div className="flex items-center gap-2">
              <span className="w-16">{t('config.command')}</span>
              <input
                value={d.command}
                onChange={(e) => set({ command: e.target.value })}
                placeholder="npx"
                className={`${input} flex-1`}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-16">{t('config.args')}</span>
              <input
                value={d.args}
                onChange={(e) => set({ args: e.target.value })}
                placeholder="-y @modelcontextprotocol/server-github"
                className={`${input} flex-1`}
              />
            </div>
            <Pairs label="Env" rows={d.env} onChange={(env) => set({ env })} />
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="w-16">URL</span>
              <input
                value={d.url}
                onChange={(e) => set({ url: e.target.value })}
                placeholder="https://…/mcp"
                className={`${input} flex-1`}
              />
            </div>
            <Pairs label="Headers" rows={d.headers} onChange={(headers) => set({ headers })} />
          </>
        )}
        {result && (
          <p className={result !== 'running' && !result.ok ? 'text-red-600' : 'text-emerald-600'}>
            {result === 'running'
              ? t('config.testing')
              : result.ok
                ? `${t('config.connected', { count: result.tools?.length ?? 0 })}${result.serverName ? ` · ${result.serverName}` : ''}`
                : `✕ ${result.error}`}
          </p>
        )}
        {error && <p className="text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              setResult('running');
              try {
                setResult(
                  await api<TestResult>('/api/mcp/test', {
                    body: { config: toConfig(d), scope: item?.scope ?? d.scope, name: item?.name },
                  })
                );
              } catch (err: any) {
                setResult({ ok: false, error: err.message, durationMs: 0 });
              }
            }}
          >
            {t('config.testConnection')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button size="sm" disabled={busy || !d.name.trim()} onClick={() => void save()}>
            {t('actions.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
