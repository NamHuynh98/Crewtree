// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Crown, X } from 'lucide-react';
import { SessionSettingsSchema, type AppSettings, type SessionSettings } from '@crewtree/shared';
import { api } from '@/lib/api';
import { shortenPath } from '@/lib/paths';
import { Button } from '@/components/ui/button';
import { ModelPicker, useModelCatalog } from '@/features/model-picker/ModelPicker';
import { modelLabel } from '@/features/model-picker/models';
import type { ResourceItem } from '@/features/resources/types';
import { useAgents } from '@/pages/AgentsPage';
import { SessionSettingsFields } from '@/features/workspace/SessionSettingsPanel';
import { AddAgentsDialog, sessionCandidates, type ParentOption } from './AddAgentsDialog';

interface TreeNode {
  key: string;
  agentName: string;
  alias: string;
  /** key of the parent node; undefined = Supervisor */
  parent?: string;
  model?: string;
}

interface ProjectsResponse {
  current: { path: string; homeDir: string };
  recent: Array<{ path: string }>;
}

const SUPERVISOR = '__supervisor__';
let seq = 0;

/** New session dialog (UI-WIREFRAMES 1): name, cwd, Supervisor + model, initial tree, advanced settings. */
export function NewSessionDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const { data: library = [] } = useAgents();
  const { data: catalog } = useModelCatalog();
  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<ProjectsResponse>('/api/projects'),
  });
  const { data: app } = useQuery({ queryKey: ['settings'], queryFn: () => api<AppSettings>('/api/settings') });

  const [title, setTitle] = useState('');
  const [cwd, setCwd] = useState('');
  const [supervisorName, setSupervisorName] = useState('');
  const [supervisorModel, setSupervisorModel] = useState<string | undefined>(undefined);
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [adding, setAdding] = useState<{ parent: string } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [settings, setSettings] = useState<SessionSettings | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cwd && projects?.current.path) setCwd(projects.current.path);
  }, [projects, cwd]);
  useEffect(() => {
    if (app && !settings)
      setSettings(SessionSettingsSchema.parse({ idleSuspendMinutes: app.limits.defaults.idleSuspendMinutes }));
  }, [app, settings]);

  const candidates = useMemo(() => sessionCandidates(library), [library]);
  const supervisors = candidates.filter((a) => a.metadata.canDelegate);
  useEffect(() => {
    if (supervisorName || !library.length) return;
    // crewtree-supervisor (or any role: supervisor agent) is the default; the server creates it when missing
    const preferred =
      supervisors.find((a) => a.name === 'crewtree-supervisor') ??
      supervisors.find((a) => a.metadata.role === 'supervisor');
    if (preferred) setSupervisorName(preferred.name);
  }, [library, supervisors, supervisorName]);

  const byName = (name: string): ResourceItem | undefined => candidates.find((a) => a.name === name);
  const supervisorItem = byName(supervisorName);

  const parents: ParentOption[] = [
    { value: SUPERVISOR, label: supervisorName || 'Supervisor', delegates: supervisorItem?.metadata.delegates ?? '*' },
    ...nodes
      .filter((n) => byName(n.agentName)?.metadata.canDelegate)
      .map((n) => ({ value: n.key, label: n.alias, delegates: byName(n.agentName)?.metadata.delegates ?? '*' })),
  ];

  const add = (names: string[], parent: string) =>
    setNodes((prev) => {
      const next = [...prev];
      const taken = new Set([...next.map((n) => n.alias), 'Supervisor']);
      for (const name of names) {
        let alias = name;
        for (let i = 2; taken.has(alias); i++) alias = `${name}-${i}`;
        taken.add(alias);
        next.push({ key: `n${++seq}`, agentName: name, alias, parent: parent === SUPERVISOR ? undefined : parent });
      }
      return next;
    });

  const remove = (key: string) =>
    setNodes((prev) => {
      const drop = new Set([key]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of prev) {
          if (n.parent && drop.has(n.parent) && !drop.has(n.key)) {
            drop.add(n.key);
            grew = true;
          }
        }
      }
      return prev.filter((n) => !drop.has(n.key));
    });

  const create = async () => {
    setError(null);
    setCreating(true);
    try {
      // Parents first: the server resolves `parent` against agents already inserted
      const ordered: TreeNode[] = [];
      const visit = (parent?: string) => {
        for (const n of nodes.filter((x) => x.parent === parent)) {
          ordered.push(n);
          visit(n.key);
        }
      };
      visit(undefined);
      const aliasOf = (key?: string) => nodes.find((n) => n.key === key)?.alias;
      const res = await api<{ session: { id: string } }>('/api/sessions', {
        body: {
          title: title.trim() || t('newSession.defaultTitle'),
          cwd,
          supervisorName: supervisorName || undefined,
          supervisorModel,
          settings,
          agents: ordered.map((n) => ({
            agentName: n.agentName,
            alias: n.alias,
            parent: aliasOf(n.parent),
            model: n.model,
          })),
        },
      });
      onCreated(res.session.id);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const renderNodes = (parent: string | undefined, depth: number): React.ReactNode =>
    nodes
      .filter((n) => n.parent === parent)
      .map((n) => {
        const item = byName(n.agentName);
        return (
          <div key={n.key}>
            <div className="flex items-center gap-2 py-0.5" style={{ paddingLeft: 8 + depth * 16 }}>
              <span className="text-muted-foreground">└</span>
              <span className="font-medium">{n.alias}</span>
              {item?.metadata.canDelegate && (
                <span className="text-[10px] text-primary">({t('addAgents.delegates')})</span>
              )}
              <select
                value={n.model ?? ''}
                onChange={(e) =>
                  setNodes((prev) =>
                    prev.map((x) => (x.key === n.key ? { ...x, model: e.target.value || undefined } : x))
                  )
                }
                className="ml-auto rounded border border-input bg-background px-1 py-0.5 text-[11px]"
                aria-label={t('editor.model')}
              >
                <option value="">
                  {t('newSession.agentDefault', { model: modelLabel(item?.metadata.model, catalog) })}
                </option>
                {(catalog?.models ?? []).map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.displayName}
                  </option>
                ))}
              </select>
              {item?.metadata.canDelegate ? (
                <button
                  type="button"
                  className="text-[11px] text-primary hover:underline"
                  onClick={() => setAdding({ parent: n.key })}
                >
                  {t('newSession.addChild')}
                </button>
              ) : (
                <span className="w-[52px]" />
              )}
              <button
                type="button"
                onClick={() => remove(n.key)}
                aria-label={t('newSession.remove', { name: n.alias })}
              >
                <X className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
              </button>
            </div>
            {renderNodes(n.key, depth + 1)}
          </div>
        );
      });

  const cwdOptions = [
    ...new Set([projects?.current.path, ...(projects?.recent.map((r) => r.path) ?? [])].filter(Boolean)),
  ] as string[];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onMouseDown={onClose}>
      <div
        className="flex max-h-full w-full max-w-2xl flex-col rounded-lg border border-border bg-card shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t('newSession.title')}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <span className="text-sm font-semibold">{t('newSession.title')}</span>
          <button onClick={onClose} aria-label={t('actions.cancel')}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4 text-xs">
          <label className="flex items-center gap-3">
            <span className="w-32 shrink-0 text-muted-foreground">{t('newSession.name')}</span>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('sessionsPage.titlePlaceholder')}
              className="flex-1 rounded-md border border-input bg-background px-2.5 py-1.5"
            />
          </label>
          <label className="flex items-center gap-3">
            <span className="w-32 shrink-0 text-muted-foreground">{t('newSession.cwd')}</span>
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              list="crewtree-cwds"
              className="flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 font-mono"
            />
            <datalist id="crewtree-cwds">
              {cwdOptions.map((p) => (
                <option key={p} value={p}>
                  {shortenPath(p, projects?.current.homeDir)}
                </option>
              ))}
            </datalist>
          </label>
          <div className="flex items-center gap-3">
            <span className="w-32 shrink-0 text-muted-foreground">{t('newSession.supervisor')}</span>
            <select
              value={supervisorName}
              onChange={(e) => setSupervisorName(e.target.value)}
              className="flex-1 rounded-md border border-input bg-background px-2 py-1.5"
            >
              {!supervisors.some((a) => a.name === 'crewtree-supervisor') && (
                <option value="">crewtree-supervisor</option>
              )}
              {supervisors.map((a) => (
                <option key={a.id} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
            <div className="w-56">
              <ModelPicker value={supervisorModel ?? supervisorItem?.metadata.model} onChange={setSupervisorModel} />
            </div>
          </div>

          <div className="space-y-1">
            <div className="text-muted-foreground">{t('newSession.tree')}</div>
            <div className="rounded-md border border-border bg-background p-2">
              <div className="flex items-center gap-1.5 py-0.5 pl-2 font-medium">
                <Crown className="h-3.5 w-3.5 text-primary" />
                {supervisorName || 'crewtree-supervisor'}
              </div>
              {renderNodes(undefined, 1)}
              {nodes.length === 0 && (
                <p className="py-1 pl-6 text-[11px] text-muted-foreground">{t('newSession.treeEmpty')}</p>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              onClick={() => setAdding({ parent: SUPERVISOR })}
            >
              {t('newSession.addAgent')}
            </Button>
          </div>

          <button
            type="button"
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
            onClick={() => setAdvanced((v) => !v)}
          >
            {advanced ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {t('newSession.advanced')}
          </button>
          {advanced && settings && (
            <div className="rounded-md border border-border p-3">
              <SessionSettingsFields
                value={settings}
                onChange={setSettings}
                globalMaxConcurrent={app?.limits.defaults.maxConcurrentAgents}
              />
            </div>
          )}
          {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button size="sm" disabled={creating || !cwd} onClick={() => void create()}>
            {creating ? t('newSession.creating') : t('newSession.create')}
          </Button>
        </div>
      </div>
      {adding && (
        <AddAgentsDialog
          agents={library}
          parents={parents}
          defaultParent={adding.parent}
          onAdd={add}
          onClose={() => setAdding(null)}
        />
      )}
    </div>
  );
}
