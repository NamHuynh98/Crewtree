// SPDX-License-Identifier: Apache-2.0
import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Bot, ChevronsDownUp, ChevronsUpDown, Crown, MessageSquare, PanelRight, Wrench } from 'lucide-react';
import type { ModelCatalog } from '@/features/resources/types';
import { modelAvailable, modelLabel } from '@/features/model-picker/models';
import { StatusDot, agentVisual } from '@/components/StatusBadge';
import { cn } from '@/lib/utils';
import {
  AGENT_BAR,
  effectiveModel,
  formatDuration,
  formatTokens,
  isTerminalTask,
  snapshotFields,
  type NodeInfo,
} from '../agentInfo';
import { crewtreeTool, toolSummary } from '../chat';

export interface AgentNodeData extends Record<string, unknown> {
  info: NodeInfo;
  catalog?: ModelCatalog;
  collapsed: boolean;
  hiddenSummary?: { agents: number; running: number };
  runningCount: number;
  highlighted: boolean;
  conflict: boolean;
  onOpen: (id: string, tab?: 'activity' | 'chat') => void;
  onToggleCollapse: (id: string) => void;
  onApprove: (approvalId: string, allow: boolean) => void;
  onModelClick: (id: string, anchor: DOMRect) => void;
}

export type AgentFlowNode = Node<AgentNodeData, 'agent'>;

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** Node anatomy of UI-WIREFRAMES 2: colour bar, status, model, activity, task, children, counters. */
function AgentNodeView({ id, data, selected }: NodeProps<AgentFlowNode>) {
  const { t } = useTranslation();
  const { info, catalog } = data;
  const { agent, stats, task, children, approval, question } = info;
  const status = agent.status ?? 'idle';
  const fields = snapshotFields(agent);
  const model = effectiveModel(agent);
  const unavailable = modelAvailable(model, catalog) === false;
  const running = status === 'running';
  const now = useNow(running || status === 'throttled' || (!!task && !isTerminalTask(task)));
  const name = agent.alias || agent.agentName;

  let line: React.ReactNode = null;
  if (approval)
    line = (
      <span className="text-amber-700 dark:text-amber-400">{t('node.needsApproval', { tool: approval.tool })}</span>
    );
  else if (status === 'throttled' && stats.throttledUntil)
    line = (
      <span className="text-violet-600 dark:text-violet-300">
        {t('node.rateLimited', { seconds: Math.max(0, Math.ceil((stats.throttledUntil - now) / 1000)) })}
      </span>
    );
  else if (status === 'queued') line = <span>{t('node.queued', { count: data.runningCount })}</span>;
  else if (status === 'needs_input' || question)
    line = (
      <span className="text-amber-700 dark:text-amber-400">
        {info.isSupervisor ? t('node.needsYourInput') : t('node.questionFor', { parent: info.parentName ?? '' })}
      </span>
    );
  else if (status === 'waiting_children' && children)
    line = <span>{t('node.waitingChildren', { done: children.done, total: children.total })}</span>;
  else if (status === 'suspended') line = <span>{t('node.suspended')}</span>;
  else if (status === 'error') line = <span className="text-red-600 dark:text-red-400">{t('node.error')}</span>;
  else if (running && stats.lastTool) {
    const orchestration = crewtreeTool(stats.lastTool.tool);
    line = (
      <span className="flex min-w-0 items-center gap-1">
        <Wrench className="h-3 w-3 shrink-0" />
        <span className="shrink-0">{orchestration ?? stats.lastTool.tool}</span>
        <span className="truncate text-muted-foreground">
          · {toolSummary(stats.lastTool.tool, stats.lastTool.input)}
        </span>
      </span>
    );
  } else if (running) line = <span>{t('node.thinking')}</span>;

  const lastTaskBadge =
    task && isTerminalTask(task) ? (
      <span
        className={cn(
          'rounded px-1 text-[10px]',
          task.status === 'done' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
        )}
      >
        {task.status === 'done'
          ? `✓ ${t('node.task')} ${task.startedAt && task.endedAt ? formatDuration(task.endedAt - task.startedAt) : ''}`
          : `✕ ${t(`taskStatus.${task.status}`)}`}
      </span>
    ) : null;

  return (
    <div
      className={cn(
        'group relative w-[248px] overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm transition',
        running && 'border-blue-300 shadow-blue-100 dark:border-blue-800 dark:shadow-none',
        status === 'error' && 'border-red-300 dark:border-red-800',
        (approval || status === 'waiting_input') && 'border-amber-300 dark:border-amber-700',
        status === 'queued' && 'border-dashed',
        status === 'suspended' && 'opacity-60',
        selected && 'ring-2 ring-primary',
        data.highlighted && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
        data.conflict && 'ring-2 ring-red-500',
        agent.spawnedBy === 'agent' && 'animate-in fade-in zoom-in-95 duration-500'
      )}
      onDoubleClick={() => data.onOpen(id)}
    >
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-0 !bg-border" />
      <div className={cn('absolute inset-y-0 left-0 w-1', AGENT_BAR[fields.color ?? ''] ?? 'bg-primary/60')} />
      <div className="space-y-1 py-2 pl-3 pr-2.5 text-[11px]">
        <div className="flex items-center gap-1.5">
          {info.isSupervisor ? (
            <Crown className="h-3.5 w-3.5 text-primary" />
          ) : (
            <Bot className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span className="truncate text-xs font-semibold">{name}</span>

          <span
            className="ml-auto"
            title={t(`status.${status.replace(/_(\w)/g, (_: string, c: string) => c.toUpperCase())}`)}
          >
            <StatusDot visual={agentVisual(status)} className={status === 'queued' ? 'opacity-60' : undefined} />
          </span>
        </div>
        <button
          type="button"
          className="nodrag flex items-center gap-1 rounded text-[10px] text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            data.onModelClick(id, (e.currentTarget as HTMLElement).getBoundingClientRect());
          }}
          title={t('node.changeModel')}
        >
          {modelLabel(model, catalog)}
          {agent.modelOverride && <span title={t('node.override')}>↺</span>}
          {unavailable && (
            <span className="text-amber-600" title={t('models.unavailable')}>
              ⚠
            </span>
          )}
          {info.spawnedByName && (
            <span className="ml-1 italic">· {t('node.spawnedBy', { name: info.spawnedByName })}</span>
          )}
        </button>
        <div className="border-t border-border pt-1">
          <div className="min-h-[16px] truncate">{line}</div>
          {task && !isTerminalTask(task) && (
            <div className="flex items-center gap-1 text-muted-foreground">
              <span className="truncate">
                {t('node.task')}: {task.title}
              </span>
              {task.startedAt && (
                <span className="ml-auto shrink-0 tabular-nums">{formatDuration(now - task.startedAt)}</span>
              )}
            </div>
          )}
          {lastTaskBadge && <div>{lastTaskBadge}</div>}
          {data.collapsed && data.hiddenSummary && (
            <div className="text-[10px] text-primary">
              {t('node.collapsed', { count: data.hiddenSummary.agents, running: data.hiddenSummary.running })}
            </div>
          )}
        </div>
        {approval && (
          <div className="nodrag flex gap-1 pt-0.5">
            <button
              type="button"
              className="rounded bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground"
              onClick={(e) => {
                e.stopPropagation();
                data.onApprove(approval.id, true);
              }}
            >
              {t('node.allow')}
            </button>
            <button
              type="button"
              className="rounded border border-border px-1.5 py-0.5 text-[10px]"
              onClick={(e) => {
                e.stopPropagation();
                data.onApprove(approval.id, false);
              }}
            >
              {t('node.deny')}
            </button>
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation();
                data.onOpen(id);
              }}
            >
              {t('node.details')}
            </button>
          </div>
        )}
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <span>
            {formatTokens(stats.tokens)} tok · {t('node.turns', { count: stats.turns })}
            {stats.filesTouched > 0 && ` · ${t('node.files', { count: stats.filesTouched })}`}
          </span>
          <span className="nodrag ml-auto flex gap-0.5 opacity-0 transition group-hover:opacity-100">
            <button
              type="button"
              className="rounded p-0.5 hover:bg-accent"
              title={t('node.chat')}
              onClick={(e) => {
                e.stopPropagation();
                data.onOpen(id, 'chat');
              }}
            >
              <MessageSquare className="h-3 w-3" />
            </button>
            <button
              type="button"
              className="rounded p-0.5 hover:bg-accent"
              title={t('node.details')}
              onClick={(e) => {
                e.stopPropagation();
                data.onOpen(id);
              }}
            >
              <PanelRight className="h-3 w-3" />
            </button>
            {info.childCount > 0 && (
              <button
                type="button"
                className="rounded p-0.5 hover:bg-accent"
                title={data.collapsed ? t('node.expand') : t('node.collapse')}
                onClick={(e) => {
                  e.stopPropagation();
                  data.onToggleCollapse(id);
                }}
              >
                {data.collapsed ? <ChevronsUpDown className="h-3 w-3" /> : <ChevronsDownUp className="h-3 w-3" />}
              </button>
            )}
          </span>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-0 !bg-border" />
    </div>
  );
}

export const AgentNode = memo(AgentNodeView);
