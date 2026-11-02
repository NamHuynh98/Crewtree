// SPDX-License-Identifier: Apache-2.0
import path from 'path';
import type { SessionAgent } from '@crewtree/shared';
import type { DriverToolHooks } from './AgentDriver.js';
import type { TaskManager } from './TaskManager.js';
import { FileLockManager } from '../files/FileLockManager.js';
import { FileActivity } from '../files/FileActivity.js';
import { isInScope } from '../files/scope.js';
import { FILE_EDIT_TOOLS, filePathOf, relativeToCwd } from '../approvals/permissionPatterns.js';
import { EventBus } from '../events/EventBus.js';

export interface ToolHookContext {
  sessionId: string;
  agent: SessionAgent;
  cwd: string;
  taskManager: TaskManager;
}

/** Edits flagged as leaving the task scope, so canUseTool can label the approval request. */
const outsideScope = new Set<string>();
const snapshots = new Map<string, string>(); // toolUseId -> snapshot path

export function isOutsideScopeRequest(agentId: string, toolName: string, input: any, cwd: string): boolean {
  const file = filePathOf(input);
  return !!file && FILE_EDIT_TOOLS.has(toolName) && outsideScope.has(`${agentId}:${path.resolve(cwd, file)}`);
}

/**
 * PreToolUse / PostToolUse hooks (PLAN.md 5). They run for every tool call, even ones settings.json
 * already allows, so locks and scope checks cannot be skipped:
 * - another agent's lease on the file → deny and raise `file.conflict`
 * - edit outside the task scope → `ask`, which forces an Approval request labelled `outside_scope`
 * - snapshot before Edit/Write, file_touches after; Bash start/end for attributing other changes
 */
export function createToolHooks(ctx: ToolHookContext): DriverToolHooks {
  const { sessionId, agent, cwd, taskManager } = ctx;
  const files = FileActivity.getInstance();
  const locks = FileLockManager.getInstance();

  return {
    preToolUse: async (toolName, input, toolUseId) => {
      const task = taskManager.currentTask(agent.id);
      if (toolName === 'Bash') {
        files.bashStarted(sessionId, agent.id, task?.id);
        return {};
      }
      const filePath = filePathOf(input);
      if (!FILE_EDIT_TOOLS.has(toolName) || !filePath) return {};

      const abs = path.resolve(cwd, filePath);
      const rel = relativeToCwd(abs, cwd);
      const lock = locks.acquire(abs, {
        sessionId,
        sessionAgentId: agent.id,
        agentName: agent.alias || agent.agentName,
        taskId: task?.id,
        taskTitle: task?.title,
      });
      if (!lock.ok) {
        const holder = lock.holder;
        EventBus.getInstance().emitEvent({
          sessionId,
          sessionAgentId: agent.id,
          type: 'file.conflict',
          payload: {
            path: rel,
            agentId: agent.id,
            agent: agent.alias || agent.agentName,
            holderAgentId: holder.sessionAgentId,
            holder: holder.agentName,
            holderTask: holder.taskTitle,
          },
          ts: Date.now(),
        });
        return {
          decision: 'deny',
          reason:
            `${rel} is locked by ${holder.agentName}` +
            (holder.taskTitle ? ` (task: ${holder.taskTitle})` : '') +
            '. Do not edit it; report the conflict with ask_parent.',
        };
      }

      const key = `${agent.id}:${abs}`;
      outsideScope.delete(key);
      // Only delegated tasks have a scope; a user chatting with the agent directly is in control
      if (task && !task.isRoot && task.fromAgentId && !isInScope(rel, task.scope)) {
        outsideScope.add(key);
        if (toolUseId) {
          const snap = files.snapshotBeforeEdit(sessionId, abs);
          if (snap) snapshots.set(toolUseId, snap);
        }
        return { decision: 'ask', reason: `${rel} is outside the task scope (${task.scope.join(', ') || 'none'})` };
      }
      const snap = files.snapshotBeforeEdit(sessionId, abs);
      if (snap && toolUseId) snapshots.set(toolUseId, snap);
      return {};
    },

    postToolUse: async (toolName, input, _response, toolUseId) => {
      if (toolName === 'Bash') {
        files.bashEnded(agent.id);
        return;
      }
      const filePath = filePathOf(input);
      if (!FILE_EDIT_TOOLS.has(toolName) || !filePath) return;
      const abs = path.resolve(cwd, filePath);
      outsideScope.delete(`${agent.id}:${abs}`);
      const snapshotPath = toolUseId ? snapshots.get(toolUseId) : undefined;
      if (toolUseId) snapshots.delete(toolUseId);
      files.recordTouch({
        sessionId,
        sessionAgentId: agent.id,
        taskId: taskManager.currentTask(agent.id)?.id,
        absPath: abs,
        cwd,
        op: toolName === 'Write' ? 'write' : 'edit',
        snapshotPath,
      });
    },
  };
}
