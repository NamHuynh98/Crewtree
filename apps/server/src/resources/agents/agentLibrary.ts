// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import type { AgentFrontmatter } from '@crewtree/shared';
import { ProjectService } from '../../projects/ProjectService.js';
import { parseAgentSnapshot } from '../../runtime/agentDefinition.js';
import { ResourceScanner } from '../ResourceScanner.js';
import { AGENT_PRECEDENCE, scanAgents } from '../scan/agents.js';

export type LibraryScope = 'crewtree' | 'user' | 'project' | 'plugin';

export interface LibraryAgent {
  name: string;
  scope: LibraryScope;
  path: string;
  content: string;
  frontmatter: AgentFrontmatter;
  description: string;
}

/**
 * Agents usable as session nodes: every file-backed agent, one per name by precedence
 * Project > User > Crewtree > Plugin (PLAN.md 6.1). Built-ins have no definition and are excluded.
 */
export function listLibraryAgents(projectDir?: string): LibraryAgent[] {
  const current = ProjectService.getInstance().currentPath();
  const items =
    !projectDir || path.resolve(projectDir) === current
      ? ResourceScanner.getInstance().list('agent')
      : scanAgents(path.resolve(projectDir));
  const best = new Map<string, LibraryAgent>();
  for (const item of items) {
    if (!item.path || item.scope === 'builtin') continue;
    const existing = best.get(item.name);
    if (existing && AGENT_PRECEDENCE.indexOf(existing.scope) <= AGENT_PRECEDENCE.indexOf(item.scope)) continue;
    let content: string;
    try {
      content = fs.readFileSync(item.path, 'utf8');
    } catch {
      continue;
    }
    best.set(item.name, {
      name: item.name,
      scope: item.scope as LibraryScope,
      path: item.path,
      content,
      frontmatter: parseAgentSnapshot(content, item.name).frontmatter,
      description: item.description,
    });
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findLibraryAgent(name: string, projectDir?: string): LibraryAgent | undefined {
  return listLibraryAgents(projectDir).find((a) => a.name === name);
}
