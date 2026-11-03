// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Task } from '@crewtree/shared';
import { api } from '@/lib/api';
import type { WorkspaceListener } from '../useWorkspace';

export interface FileChange {
  path: string;
  ops: string[];
  agents: Array<{ id: string; name: string }>;
  taskIds: string[];
  viaBash: boolean;
  firstTs: number;
  lastTs: number;
  status: 'added' | 'modified' | 'deleted';
  added: number;
  removed: number;
}

/** Session (or one agent's) changed files, refreshed when agents touch files. */
export function useChanges(sessionId: string, subscribe: (l: WorkspaceListener) => () => void, agentId?: string) {
  const [changes, setChanges] = useState<FileChange[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const load = useCallback(() => {
    api<FileChange[]>(`/api/sessions/${sessionId}/changes${agentId ? `?agent=${agentId}` : ''}`)
      .then(setChanges)
      .catch(() => setChanges([]));
  }, [sessionId, agentId]);
  useEffect(() => {
    load();
    const off = subscribe((e) => {
      if (e.type !== 'file.touched' || (agentId && e.sessionAgentId !== agentId)) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(load, 800);
    });
    return () => {
      off();
      clearTimeout(timer.current);
    };
  }, [load, subscribe, agentId]);
  return changes;
}

const STATUS_LETTER = { added: 'A', modified: 'M', deleted: 'D' } as const;

export function ChangeList({
  sessionId,
  agentId,
  subscribe,
  tasks,
  onOpen,
}: {
  sessionId: string;
  agentId?: string;
  subscribe: (l: WorkspaceListener) => () => void;
  tasks: Task[];
  onOpen: (path: string) => void;
}) {
  const { t } = useTranslation();
  const changes = useChanges(sessionId, subscribe, agentId);
  if (!changes) return <p className="text-xs text-muted-foreground">{t('composer.loading')}</p>;
  if (!changes.length) return <p className="text-xs text-muted-foreground">{t('changes.empty')}</p>;
  const added = changes.reduce((n, c) => n + c.added, 0);
  const removed = changes.reduce((n, c) => n + c.removed, 0);
  return (
    <div className="space-y-2 text-xs">
      <div className="text-muted-foreground">
        {t('changes.summary', { count: changes.length })} · <span className="text-emerald-600">+{added}</span>{' '}
        <span className="text-red-600">−{removed}</span>
      </div>
      <ul className="divide-y divide-border rounded-md border border-border">
        {changes.map((c) => {
          const task = tasks.find((x) => c.taskIds.includes(x.id));
          return (
            <li key={c.path}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent"
                onClick={() => onOpen(c.path)}
              >
                <span
                  className={`w-3 font-mono text-[10px] font-semibold ${c.status === 'added' ? 'text-emerald-600' : c.status === 'deleted' ? 'text-red-600' : 'text-amber-600'}`}
                  title={t(`changes.status.${c.status}`)}
                >
                  {STATUS_LETTER[c.status]}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono">{c.path}</span>
                <span className="shrink-0 tabular-nums">
                  <span className="text-emerald-600">+{c.added}</span>{' '}
                  <span className="text-red-600">−{c.removed}</span>
                </span>
                {!agentId && (
                  <span className="w-24 shrink-0 truncate text-right text-muted-foreground">
                    {c.agents.map((a) => a.name).join(', ')}
                  </span>
                )}
                {task && (
                  <span className="w-28 shrink-0 truncate text-right text-muted-foreground">
                    {t('changes.task', { title: task.title })}
                  </span>
                )}
                {c.viaBash && (
                  <span className="shrink-0 rounded border border-border px-1 text-[9px] text-muted-foreground">
                    {t('changes.viaBash')}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
