// SPDX-License-Identifier: Apache-2.0
import type { Approval, SessionAgent, Task } from '@crewtree/shared';
import { readAgentFields } from '@/features/resources/agentFile';
import { formatTokens } from '@/lib/format';
import type { AgentStats } from './useWorkspace';

const TERMINAL = new Set(['done', 'failed', 'cancelled', 'interrupted']);
export const isTerminalTask = (t: Task) => TERMINAL.has(t.status);

const fieldsCache = new Map<string, ReturnType<typeof readAgentFields>['fields']>();

/** Frontmatter of the agent's snapshot (model, color, canDelegate, tools…), cached per snapshot text. */
export function snapshotFields(agent: SessionAgent) {
  let fields = fieldsCache.get(agent.snapshot);
  if (!fields) {
    fields = readAgentFields(agent.snapshot).fields;
    if (fieldsCache.size > 200) fieldsCache.clear();
    fieldsCache.set(agent.snapshot, fields);
  }
  return fields;
}

export function effectiveModel(agent: SessionAgent): string | undefined {
  return agent.modelOverride || snapshotFields(agent).model || undefined;
}

export function canDelegate(agent: SessionAgent, isSupervisor: boolean): boolean {
  if (isSupervisor) return true;
  return agent.canDelegateOverride ?? snapshotFields(agent).canDelegate;
}

export interface NodeInfo {
  agent: SessionAgent;
  isSupervisor: boolean;
  stats: AgentStats;
  /** The task the agent works on, else its most recent one */
  task?: Task;
  /** Children of the current task: finished / total */
  children?: { done: number; total: number };
  /** Pending permission request of this agent */
  approval?: Approval;
  /** Its task waits for an answer from its parent */
  question?: Task;
  parentName?: string;
  spawnedByName?: string;
  childCount: number;
}

export function buildNodeInfo(
  agents: SessionAgent[],
  tasks: Task[],
  approvals: Approval[],
  stats: Record<string, AgentStats>,
  supervisorId: string | undefined
): Map<string, NodeInfo> {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const out = new Map<string, NodeInfo>();
  for (const agent of agents) {
    const mine = tasks.filter((t) => t.toAgentId === agent.id).sort((a, b) => b.createdAt - a.createdAt);
    const task = mine.find((t) => !isTerminalTask(t)) ?? mine[0];
    let children: NodeInfo['children'];
    if (task && !isTerminalTask(task)) {
      const sub = tasks.filter((t) => t.parentTaskId === task.id && t.fromAgentId === agent.id);
      if (sub.length) children = { done: sub.filter(isTerminalTask).length, total: sub.length };
    }
    const parent = agent.parentId ? byId.get(agent.parentId) : undefined;
    out.set(agent.id, {
      agent,
      isSupervisor: agent.id === supervisorId,
      stats: stats[agent.id] ?? { tokens: 0, turns: 0, filesTouched: 0 },
      task,
      children,
      approval: approvals.find((a) => a.sessionAgentId === agent.id),
      question: mine.find((t) => t.status === 'needs_input'),
      parentName: parent ? parent.alias || parent.agentName : undefined,
      spawnedByName: agent.spawnedBy === 'agent' && parent ? parent.alias || parent.agentName : undefined,
      childCount: agents.filter((a) => a.parentId === agent.id).length,
    });
  }
  return out;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export { formatTokens };

export const AGENT_BAR: Record<string, string> = {
  violet: 'bg-violet-500',
  blue: 'bg-blue-500',
  cyan: 'bg-cyan-500',
  green: 'bg-emerald-500',
  yellow: 'bg-yellow-500',
  orange: 'bg-orange-500',
  red: 'bg-red-500',
  pink: 'bg-pink-500',
};
