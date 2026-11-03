// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { AppSettings, SessionSettings } from '@crewtree/shared';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { formatTokens } from './agentInfo';
import type { Workspace } from './useWorkspace';

interface Processes {
  running: number;
  suspended: number;
  all: { count: number; rssBytes: number } | null;
}

interface Checkpoint {
  ref: string;
  commit: string;
  n: number;
}

function formatBytes(n: number): string {
  const mb = n / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

const input = 'w-20 rounded-md border border-input bg-background px-2 py-1 text-xs';

/** Limits, config groups, idle suspend and checkpoint fields shared by New session and Session settings. */
export function SessionSettingsFields({
  value,
  onChange,
  globalMaxConcurrent,
}: {
  value: SessionSettings;
  onChange: (next: SessionSettings) => void;
  globalMaxConcurrent?: number;
}) {
  const { t } = useTranslation();
  const limits = value.limits;
  const setLimit = (key: keyof SessionSettings['limits'], n: number) =>
    onChange({ ...value, limits: { ...limits, [key]: Math.max(1, Math.floor(n || 1)) } });
  const num = (key: keyof SessionSettings['limits'], label: string, extra?: string) => (
    <label className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="number"
        min={1}
        className={input}
        value={limits[key]}
        onChange={(e) => setLimit(key, Number(e.target.value))}
      />
      {extra && <span className="text-[10px] text-muted-foreground">{extra}</span>}
    </label>
  );
  return (
    <div className="space-y-2.5 text-xs">
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {num(
          'maxConcurrentAgents',
          t('sessionSettings.concurrent'),
          globalMaxConcurrent ? `(≤ ${globalMaxConcurrent})` : undefined
        )}
        {num('maxDepth', t('sessionSettings.maxDepth'))}
        {num('maxTotalAgents', t('sessionSettings.maxTotal'))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {num('maxTokens', t('sessionSettings.maxTokens'), formatTokens(limits.maxTokens))}
        {num('maxTurns', t('sessionSettings.maxTurns'))}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-muted-foreground">{t('sessionSettings.config')}</span>
        {(['claudemd', 'skillsPlugins', 'hooks', 'permissions'] as const).map((g) => (
          <label key={g} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={value.configGroups[g]}
              onChange={(e) => onChange({ ...value, configGroups: { ...value.configGroups, [g]: e.target.checked } })}
            />
            {t(`sessionSettings.groups.${g}`)}
          </label>
        ))}
      </div>
      {!value.configGroups.permissions && (value.configGroups.claudemd || value.configGroups.skillsPlugins) && (
        <p className="text-[10px] text-amber-700 dark:text-amber-400">{t('sessionSettings.permissionsWarning')}</p>
      )}
      <label className="flex items-center gap-1.5">
        <span className="text-muted-foreground">{t('sessionSettings.idleSuspend')}</span>
        <input
          type="number"
          min={0}
          className={input}
          value={value.idleSuspendMinutes}
          onChange={(e) =>
            onChange({ ...value, idleSuspendMinutes: Math.max(0, Math.floor(Number(e.target.value) || 0)) })
          }
        />
        <span className="text-muted-foreground">{t('sessionSettings.minutes')}</span>
      </label>
      <label className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={value.checkpoint}
          onChange={(e) => onChange({ ...value, checkpoint: e.target.checked })}
        />
        {t('sessionSettings.checkpoint')}
      </label>
    </div>
  );
}

/** Session settings drawer (UI-WIREFRAMES 2 `⚙ Session`). */
export function SessionSettingsPanel({ ws, onClose }: { ws: Workspace; onClose: () => void }) {
  const { t } = useTranslation();
  const session = ws.session!;
  const [draft, setDraft] = useState<SessionSettings>(session.settings);
  const [saved, setSaved] = useState(false);
  const [processes, setProcesses] = useState<Processes | null>(null);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: app } = useQuery({ queryKey: ['settings'], queryFn: () => api<AppSettings>('/api/settings') });

  useEffect(() => {
    setDraft(session.settings);
  }, [session.settings]);
  useEffect(() => {
    const load = () =>
      api<Processes>(`/api/sessions/${session.id}/processes`)
        .then(setProcesses)
        .catch(() => undefined);
    load();
    const timer = setInterval(load, 5000);
    api<Checkpoint[]>(`/api/sessions/${session.id}/checkpoints`)
      .then(setCheckpoints)
      .catch(() => setCheckpoints([]));
    return () => clearInterval(timer);
  }, [session.id]);

  const used = session.totalTokens + ws.usage.inputTokens + ws.usage.outputTokens;
  const pct = Math.min(100, Math.round((used / draft.limits.maxTokens) * 100));
  const dirty = JSON.stringify(draft) !== JSON.stringify(session.settings);

  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex w-[min(480px,100%)] flex-col border-l border-border bg-card shadow-xl">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-sm font-semibold">{t('sessionSettings.title')}</span>
        <button type="button" onClick={onClose} aria-label={t('actions.close')}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4 text-xs">
        <SessionSettingsFields
          value={draft}
          onChange={(next) => {
            setSaved(false);
            setDraft(next);
          }}
          globalMaxConcurrent={app?.limits.defaults.maxConcurrentAgents}
        />
        <p className="text-[10px] text-muted-foreground">{t('sessionSettings.applyHint')}</p>
        <section className="space-y-1">
          <div className="text-muted-foreground">
            {t('sessionSettings.usage', { used: formatTokens(used), max: formatTokens(draft.limits.maxTokens) })}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className={`h-full ${pct > 90 ? 'bg-red-500' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="text-[10px] text-muted-foreground">
            {t('sessionSettings.usageDetail', {
              input: formatTokens(ws.usage.inputTokens),
              output: formatTokens(ws.usage.outputTokens),
              cache: formatTokens(ws.usage.cacheReadTokens),
            })}
          </div>
        </section>
        <section className="text-muted-foreground">
          {processes
            ? t('sessionSettings.processes', {
                running: processes.running,
                suspended: processes.suspended,
                ram: processes.all ? formatBytes(processes.all.rssBytes) : '—',
              })
            : t('composer.loading')}
          <div className="text-[10px]">{t('sessionSettings.ramHint')}</div>
        </section>
        <section className="space-y-1">
          <div className="font-medium">{t('sessionSettings.checkpoints')}</div>
          {checkpoints.length === 0 ? (
            <p className="text-muted-foreground">{t('sessionSettings.noCheckpoints')}</p>
          ) : (
            <ul className="space-y-1">
              {checkpoints.map((c) => (
                <li key={c.n} className="flex items-center gap-2">
                  <span>#{c.n}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">{c.commit.slice(0, 8)}</span>
                  {restoring === c.n ? (
                    <span className="ml-auto flex items-center gap-1">
                      <span className="text-[10px] text-amber-700">{t('sessionSettings.restoreConfirm')}</span>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-6 text-[11px]"
                        onClick={async () => {
                          try {
                            await api(`/api/sessions/${session.id}/checkpoints/${c.n}/restore`, { body: {} });
                            setRestoring(null);
                          } catch (err: any) {
                            setError(err.message);
                          }
                        }}
                      >
                        {t('sessionSettings.restore')}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setRestoring(null)}>
                        {t('actions.cancel')}
                      </Button>
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-auto h-6 text-[11px]"
                      onClick={() => setRestoring(c.n)}
                    >
                      {t('sessionSettings.restore')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        {error && <p className="text-red-600">{error}</p>}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
        {saved && <span className="text-[11px] text-emerald-600">{t('sessionSettings.saved')}</span>}
        <Button
          size="sm"
          disabled={!dirty}
          onClick={async () => {
            const failed = await ws.updateSession({ settings: draft });
            if (failed) setError(failed);
            else setSaved(true);
          }}
        >
          {t('actions.save')}
        </Button>
      </div>
    </aside>
  );
}
