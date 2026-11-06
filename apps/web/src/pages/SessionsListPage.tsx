// SPDX-License-Identifier: Apache-2.0
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldAlert } from 'lucide-react';
import type { Session, SessionAgent } from '@crewtree/shared';
import { useShell } from '@/app/shell';
import { api, ApiError } from '@/lib/api';
import { shortenPath } from '@/lib/paths';
import { Button } from '@/components/ui/button';
import { StatusDot, sessionVisual } from '@/components/StatusBadge';
import { formatTokens } from '@/lib/format';

// Opened on demand: it carries the agent picker and the session settings form
const NewSessionDialog = lazy(() =>
  import('@/features/sessions/NewSessionDialog').then((m) => ({ default: m.NewSessionDialog }))
);

type SessionRow = Session & { activity?: 'running' | 'idle'; agentCount: number; levels: number; lastActiveAt: number };

function useRelativeTime() {
  const { i18n } = useTranslation();
  const rtf = useMemo(() => new Intl.RelativeTimeFormat(i18n.language, { numeric: 'auto' }), [i18n.language]);
  return (ts: number) => {
    const diff = (ts - Date.now()) / 1000;
    const abs = Math.abs(diff);
    if (abs < 60) return rtf.format(Math.round(diff), 'second');
    if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
    return rtf.format(Math.round(diff / 86400), 'day');
  };
}

/** Sessions page (UI-WIREFRAMES 0). */
export function SessionsListPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { project } = useShell();
  const relative = useRelativeTime();
  const [searchParams, setSearchParams] = useSearchParams();
  const [creating, setCreating] = useState(() => searchParams.get('new') === '1');
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setCreating(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [projectFilter, setProjectFilter] = useState('all');
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: sessions = [], error: loadError } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api<SessionRow[]>('/api/sessions'),
    refetchInterval: 10_000,
  });
  const authRequired = loadError instanceof ApiError && loadError.status === 401;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['sessions'] });

  const cwds = [...new Set(sessions.map((s) => s.cwd))];
  const shown = sessions.filter(
    (s) =>
      (status === 'all' || (status === 'running' ? s.activity === 'running' : s.status === status)) &&
      (projectFilter === 'all' || s.cwd === projectFilter) &&
      s.title.toLowerCase().includes(query.toLowerCase())
  );

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err: any) {
      setError(err.message);
    }
  };

  /** Same tree, settings and models in a fresh session (no history). */
  const duplicate = (id: string) =>
    act(async () => {
      const detail = await api<{ session: Session; agents: SessionAgent[] }>(`/api/sessions/${id}`);
      const supervisor = detail.agents.find((a) => a.id === detail.session.supervisorAgentId);
      const byId = new Map(detail.agents.map((a) => [a.id, a]));
      const ordered = detail.agents.filter((a) => a.id !== supervisor?.id).sort((a, b) => a.depth - b.depth);
      const res = await api<{ session: { id: string } }>('/api/sessions', {
        body: {
          title: t('sessionsPage.copyOf', { title: detail.session.title }),
          cwd: detail.session.cwd,
          supervisorName: supervisor?.agentName,
          supervisorModel: supervisor?.modelOverride ?? undefined,
          settings: detail.session.settings,
          agents: ordered.map((a) => {
            const parent = a.parentId ? byId.get(a.parentId) : undefined;
            return {
              agentName: a.agentName,
              alias: a.alias ?? undefined,
              parent: parent && parent.id !== supervisor?.id ? parent.alias || parent.agentName : undefined,
              model: a.modelOverride ?? undefined,
            };
          }),
        },
      });
      navigate(`/sessions/${res.session.id}`);
    });

  const statusLabel = (s: SessionRow) =>
    s.activity === 'running' ? t('status.running') : t(`sessionStatus.${s.status}`);

  return (
    <main className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="flex items-center gap-3 border-b border-border pb-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight">{t('sessions')}</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('sessionsPage.subtitle')}</p>
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('sessionsPage.search')}
            className="ml-auto w-56 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs"
          />
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus />
            {t('actions.newSession')}
          </Button>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t('sessionsPage.filter')}</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1"
          >
            <option value="all">{t('sessionsPage.allStatuses')}</option>
            <option value="running">{t('status.running')}</option>
            {['active', 'paused', 'completed', 'stopped', 'error'].map((s) => (
              <option key={s} value={s}>
                {t(`sessionStatus.${s}`)}
              </option>
            ))}
          </select>
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="max-w-xs rounded-md border border-input bg-background px-2 py-1"
          >
            <option value="all">{t('sessionsPage.allProjects')}</option>
            {cwds.map((c) => (
              <option key={c} value={c}>
                {shortenPath(c, project?.homeDir)}
              </option>
            ))}
          </select>
        </div>

        {authRequired && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-400">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            {t('auth.notSignedIn')}
          </div>
        )}
        {error && <p className="text-xs text-red-600">{error}</p>}

        {!authRequired && sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card/40 p-10 text-center">
            <h3 className="text-sm font-semibold">{t('sessionsPage.emptyTitle')}</h3>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">{t('sessionsPage.emptyBody')}</p>
            <Button size="sm" variant="link" className="mt-3" onClick={() => setCreating(true)}>
              <Plus />
              {t('actions.newSession')}
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {shown.map((s) => (
              <li key={s.id} className="group flex items-center gap-3 px-3.5 py-2.5 text-xs hover:bg-accent/40">
                <StatusDot visual={sessionVisual(s.status, s.activity)} />
                <div className="min-w-0 flex-1 cursor-pointer" onClick={() => navigate(`/sessions/${s.id}`)}>
                  {renaming?.id === s.id ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void act(() =>
                          api(`/api/sessions/${s.id}`, { method: 'PATCH', body: { title: renaming.title } })
                        ).then(() => setRenaming(null));
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        autoFocus
                        value={renaming.title}
                        onChange={(e) => setRenaming({ id: s.id, title: e.target.value })}
                        onBlur={() => setRenaming(null)}
                        onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)}
                        className="w-full rounded border border-input bg-background px-1.5 py-0.5 text-sm"
                      />
                    </form>
                  ) : (
                    <div className="truncate text-sm font-semibold">{s.title}</div>
                  )}
                  <div className="truncate font-mono text-[11px] text-muted-foreground">
                    {shortenPath(s.cwd, project?.homeDir)}
                  </div>
                </div>
                <span className="w-36 shrink-0 text-muted-foreground">
                  {t('sessionsPage.agents', { count: s.agentCount })}
                  {s.levels > 1 && ` · ${t('sessionsPage.levels', { count: s.levels })}`}
                </span>
                <span className="w-20 shrink-0">{statusLabel(s)}</span>
                <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                  {s.totalTokens ? `${formatTokens(s.totalTokens)} tok` : '—'}
                </span>
                <span className="w-24 shrink-0 text-right text-muted-foreground">{relative(s.lastActiveAt)}</span>
                <span className="flex w-[260px] shrink-0 justify-end gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
                  {deleting === s.id ? (
                    <>
                      <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setDeleting(null)}>
                        {t('actions.cancel')}
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-6 text-[11px]"
                        onClick={() =>
                          void act(() => api(`/api/sessions/${s.id}`, { method: 'DELETE' })).then(() =>
                            setDeleting(null)
                          )
                        }
                      >
                        {t('sessionsPage.confirmDelete')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[11px]"
                        onClick={() => navigate(`/sessions/${s.id}`)}
                      >
                        {t('actions.open')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-[11px]"
                        onClick={() => setRenaming({ id: s.id, title: s.title })}
                      >
                        {t('sessionsPage.rename')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-[11px]"
                        onClick={() => void duplicate(s.id)}
                      >
                        {t('actions.duplicate')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-[11px] text-red-600"
                        onClick={() => setDeleting(s.id)}
                      >
                        {t('actions.delete')}
                      </Button>
                    </>
                  )}
                </span>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="p-4 text-center text-xs text-muted-foreground">{t('sessionsPage.noMatch')}</li>
            )}
          </ul>
        )}
      </div>
      {creating && (
        <Suspense fallback={null}>
          <NewSessionDialog
            onClose={() => setCreating(false)}
            onCreated={(id) => {
              setCreating(false);
              void refresh();
              navigate(`/sessions/${id}`);
            }}
          />
        </Suspense>
      )}
    </main>
  );
}
