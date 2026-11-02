// SPDX-License-Identifier: Apache-2.0
import path from 'path';
import { DEFAULT_SUPERVISOR_NAME } from '@crewtree/shared';
import { getCrewtreeAgentsDir } from '../../paths.js';
import { writeFileAtomic } from '../../lib/atomicWrite.js';
import { EventBus } from '../../events/EventBus.js';
import { ModelCatalogService, pickBestModel } from '../../models/ModelCatalogService.js';
import { LibraryAgent, listLibraryAgents } from './agentLibrary.js';

/** PLAN.md Appendix A.1 */
export function supervisorTemplate(model: string): string {
  return `---
name: ${DEFAULT_SUPERVISOR_NAME}
description: Default Crewtree supervisor. Understands the user's goal, splits it into tasks, delegates to child agents, and reports back.
role: supervisor
model: ${model}
tools: Read, Grep, Glob
canDelegate: true
delegates: "*"
color: violet
icon: crown
---
You are the Supervisor of a team of AI agents working in the same project directory.

Your job:
1. Understand the user's goal. If it is ambiguous in a way that changes the work, ask the user (ask_parent) before delegating.
2. Call list_agents to see your team. Pick agents by their descriptions. Spawn more only from your allowed list when truly needed.
3. Break the goal into tasks with clear outcomes. For every task that edits files, set \`scope\` to the files/folders it may touch.
   Never give two running tasks overlapping scopes.
4. Run independent tasks in parallel; run dependent tasks in order.
5. Use wait_for_tasks to collect results. Answer child questions with answer_child. Read full results with get_task_result only when the summary is not enough.
6. Do not do the children's work yourself. You may read files to plan and to verify.
7. When done, give the user a concise report: what was done, by whom, files changed, open issues, suggested next steps.
`;
}

let ensuring: Promise<LibraryAgent> | undefined;

/**
 * Returns the library's supervisor (`role: supervisor`); when there is none, creates
 * ~/.crewtree/agents/crewtree-supervisor.md with the best model of the account (PLAN.md 4.1).
 * An existing file — even an edited one — is never overwritten.
 */
export function ensureDefaultSupervisor(projectDir?: string): Promise<LibraryAgent> {
  const existing = listLibraryAgents(projectDir).find((a) => a.frontmatter.role === 'supervisor');
  if (existing) return Promise.resolve(existing);
  if (!ensuring) {
    ensuring = (async () => {
      const catalog = await ModelCatalogService.getInstance().getCatalog();
      const model = (catalog.source === 'account' && pickBestModel(catalog.models)) || 'opus';
      const file = path.join(getCrewtreeAgentsDir(), `${DEFAULT_SUPERVISOR_NAME}.md`);
      writeFileAtomic(file, supervisorTemplate(model));
      EventBus.getInstance().emitEvent({
        sessionId: '',
        type: 'resource.changed',
        payload: { kind: 'agent', name: DEFAULT_SUPERVISOR_NAME, action: 'created', model, path: file },
        ts: Date.now(),
      });
      console.log(`[crewtree] Created ${DEFAULT_SUPERVISOR_NAME} with ${model}`);
      return listLibraryAgents(projectDir).find((a) => a.name === DEFAULT_SUPERVISOR_NAME)!;
    })().finally(() => {
      ensuring = undefined;
    });
  }
  return ensuring;
}
