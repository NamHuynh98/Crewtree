// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { SessionAgent, Task } from '@crewtree/shared';
import { StatusDot, type StatusVisual } from '@/components/StatusBadge';

function taskVisual(status: Task['status']): StatusVisual {
  switch (status) {
    case 'running':
      return 'running';
    case 'needs_input':
      return 'approval';
    case 'done':
      return 'done';
    case 'failed':
    case 'interrupted':
      return 'error';
    default:
      return 'idle'; // queued, cancelled
  }
}

export function TaskList({
  tasks,
  agents,
  onCancel,
}: {
  tasks: Task[];
  agents: SessionAgent[];
  onCancel: (task: Task) => void;
}) {
  const { t } = useTranslation();
  const name = (id: string) => {
    const a = agents.find((x) => x.id === id);
    return a ? a.alias || a.agentName : '?';
  };
  if (tasks.length === 0) return <p className="text-[11px] text-muted-foreground">{t('tasks.empty')}</p>;
  return (
    <ul className="space-y-1.5">
      {[...tasks].reverse().map((task) => (
        <li key={task.id} className="flex items-start gap-1.5 text-[11px]">
          <StatusDot visual={taskVisual(task.status)} className="mt-px" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium" title={task.title}>
              {task.title}
            </div>
            <div className="text-muted-foreground truncate" title={task.resultSummary ?? undefined}>
              {task.isRoot ? t('tasks.fromUser') : `${name(task.fromAgentId!)} → ${name(task.toAgentId)}`} ·{' '}
              {t(`taskStatus.${task.status}`)}
              {task.status === 'needs_input' && task.question ? ` · ${task.question}` : ''}
            </div>
          </div>
          {['queued', 'running', 'needs_input'].includes(task.status) && (
            <button
              onClick={() => onCancel(task)}
              className="p-0.5 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t('tasks.cancel')}
              aria-label={t('tasks.cancel')}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
