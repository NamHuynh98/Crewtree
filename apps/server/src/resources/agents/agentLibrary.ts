// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import type { AgentFrontmatter } from '@crewtree/shared';
import { getClaudeDir, getCrewtreeAgentsDir } from '../../paths.js';
import { parseAgentSnapshot } from '../../runtime/agentDefinition.js';

export type LibraryScope = 'crewtree' | 'user' | 'project';

export interface LibraryAgent {
  name: string;
  scope: LibraryScope;
  path: string;
  content: string;
  frontmatter: AgentFrontmatter;
  description: string;
}

function readDir(dir: string, scope: LibraryScope): LibraryAgent[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  return files.flatMap((file) => {
    const fullPath = path.join(dir, file);
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const { frontmatter } = parseAgentSnapshot(content, path.basename(file, '.md'));
      return [
        { name: frontmatter.name, scope, path: fullPath, content, frontmatter, description: frontmatter.description },
      ];
    } catch {
      return [];
    }
  });
}

/**
 * Agents available to sessions (PLAN.md 6.1). Same name in several scopes: Project > User > Crewtree.
 * The full ResourceScanner + watcher (plugins, built-ins, revisions) is Phase 3.
 */
export function listLibraryAgents(projectDir?: string): LibraryAgent[] {
  const byName = new Map<string, LibraryAgent>();
  const sources: Array<[string, LibraryScope]> = [
    [getCrewtreeAgentsDir(), 'crewtree'],
    [path.join(getClaudeDir(), 'agents'), 'user'],
    ...(projectDir ? ([[path.join(projectDir, '.claude', 'agents'), 'project']] as Array<[string, LibraryScope]>) : []),
  ];
  for (const [dir, scope] of sources) {
    for (const agent of readDir(dir, scope)) byName.set(agent.name, agent);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findLibraryAgent(name: string, projectDir?: string): LibraryAgent | undefined {
  return listLibraryAgents(projectDir).find((a) => a.name === name);
}
