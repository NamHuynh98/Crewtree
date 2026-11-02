// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import { Bot } from 'lucide-react';
import type { SessionAgent, Task } from '@crewtree/shared';
import { StatusBadge, agentStatusKey, agentVisual } from '@/components/StatusBadge';

interface Props {
  agents: SessionAgent[];
  tasks: Task[];
  supervisorId?: string;
}

/** Indented agent tree of the dev test page; the React Flow canvas of UI-WIREFRAMES 2 is Phase 5. */
export function AgentTree({ agents, tasks, supervisorId }: Props) {
  const { t } = useTranslation();
  const byParent = new Map<string | null, SessionAgent[]>();
  for (const a of agents) {
    const key = a.parentId ?? null;
    byParent.set(key, [...(byParent.get(key) ?? []), a]);
  }
  const name = (id?: string | null) => {
    const a = agents.find((x) => x.id === id);
    return a ? a.alias || a.agentName : '';
  };

  const render = (agent: SessionAgent) => {
    const current = tasks.find(
      (task) => task.toAgentId === agent.id && (task.status === 'running' || task.status === 'needs_input')
    );
    const queued = tasks.filter((task) => task.toAgentId === agent.id && task.status === 'queued').length;
    const children = byParent.get(agent.id) ?? [];
    return (
      <li key={agent.id}>
        <div
          className={`p-2.5 rounded-lg border border-border bg-card shadow-sm ${agent.status === 'suspended' ? 'opacity-70' : ''}`}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Bot className="w-4 h-4 text-primary shrink-0" />
              <span className="font-semibold text-xs truncate">{agent.alias || agent.agentName}</span>
              {agent.id === supervisorId && <span className="text-[10px] text-primary">◆</span>}
            </div>
            <StatusBadge visual={agentVisual(agent.status)} label={t(agentStatusKey(agent.status))} />
          </div>
          {current && (
            <div className="mt-1.5 text-[11px] text-muted-foreground truncate" title={current.title}>
              {t('tree.task')}: {current.title}
            </div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
            <span className="rounded border border-border px-1.5 py-px">{t(`scope.${agent.scope}`)}</span>
            {queued > 0 && <span>{t('tree.queuedTasks', { count: queued })}</span>}
            {agent.spawnedBy === 'agent' && <span>{t('tree.spawnedBy', { name: name(agent.parentId) })}</span>}
            {agent.status === 'suspended' && <span>{t('workspace.suspendedHint')}</span>}
          </div>
        </div>
        {children.length > 0 && (
          <ul className="mt-2 ml-3 pl-3 border-l border-border space-y-2">{children.map(render)}</ul>
        )}
      </li>
    );
  };

  return <ul className="space-y-2">{(byParent.get(null) ?? []).map(render)}</ul>;
}
