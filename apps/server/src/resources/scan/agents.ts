// SPDX-License-Identifier: Apache-2.0
import path from 'path';
import type { ResourceScope } from '@crewtree/shared';
import { getClaudeDir, getCrewtreeAgentsDir } from '../../paths.js';
import { parseAgentSnapshot, normalizeToolList } from '../../runtime/agentDefinition.js';
import { encodeResourceId } from '../ids.js';
import type { ResourceItem } from '../types.js';
import { markdownFiles, readText } from './common.js';
import { listInstalledPlugins } from './plugins.js';

export type WritableAgentScope = 'crewtree' | 'user' | 'project';

export function agentsDir(scope: WritableAgentScope, projectDir: string): string {
  if (scope === 'crewtree') return getCrewtreeAgentsDir();
  if (scope === 'user') return path.join(getClaudeDir(), 'agents');
  return path.join(projectDir, '.claude', 'agents');
}

/** Precedence for the same name (PLAN.md 6.1): Project > User > Crewtree > Plugin. */
export const AGENT_PRECEDENCE: ResourceScope[] = ['project', 'user', 'crewtree', 'plugin'];

export function agentItem(file: string, scope: ResourceScope, plugin?: string): ResourceItem | undefined {
  const content = readText(file);
  if (content === undefined) return undefined;
  const { frontmatter } = parseAgentSnapshot(content, path.basename(file, '.md'));
  const tools = normalizeToolList(frontmatter.tools);
  const key = plugin ? `${plugin}/${frontmatter.name}` : frontmatter.name;
  return {
    id: encodeResourceId('agent', scope, key),
    kind: 'agent',
    name: frontmatter.name,
    scope,
    path: file,
    description: frontmatter.description,
    readOnly: scope === 'plugin',
    plugin,
    metadata: {
      model: frontmatter.model,
      tools: tools ?? null, // null = inherits every tool
      color: frontmatter.color,
      icon: frontmatter.icon,
      canDelegate: frontmatter.canDelegate,
      delegates: frontmatter.delegates,
      role: frontmatter.role,
      skills: frontmatter.skills ?? [],
      mcpServers: frontmatter.mcpServers ?? [],
      maxTurns: frontmatter.maxTurns,
      fileName: path.basename(file),
    },
  };
}

/** Built-in agents have no file or system prompt: shown for reference, never usable as nodes (PLAN.md 6.1). */
export function builtinAgentItem(name: string, description: string, model?: string): ResourceItem {
  return {
    id: encodeResourceId('agent', 'builtin', name),
    kind: 'agent',
    name,
    scope: 'builtin',
    description,
    readOnly: true,
    metadata: { model: model ?? 'inherit', tools: null, canDelegate: false, delegates: [], skills: [], mcpServers: [] },
  };
}

export function scanAgents(projectDir: string, builtins: ResourceItem[] = []): ResourceItem[] {
  const items: ResourceItem[] = [];
  for (const scope of ['crewtree', 'user', 'project'] as const) {
    for (const { file } of markdownFiles(agentsDir(scope, projectDir))) {
      const item = agentItem(file, scope);
      if (item) items.push(item);
    }
  }
  for (const plugin of listInstalledPlugins(projectDir).filter((p) => p.enabled)) {
    for (const { file } of markdownFiles(path.join(plugin.installPath, 'agents'))) {
      const item = agentItem(file, 'plugin', plugin.id);
      if (item) items.push(item);
    }
  }
  const named = new Set(items.map((i) => i.name));
  items.push(...builtins.filter((b) => !named.has(b.name)));

  // Mark hidden duplicates with the scope that actually wins (highest precedence)
  for (const item of items) {
    if (item.scope === 'builtin') continue;
    const winner = items
      .filter((other) => other.name === item.name && other.scope !== 'builtin')
      .sort((a, b) => AGENT_PRECEDENCE.indexOf(a.scope) - AGENT_PRECEDENCE.indexOf(b.scope))[0];
    if (winner && winner !== item) item.shadowedBy = winner.scope;
  }
  return items.sort(
    (a, b) => a.name.localeCompare(b.name) || AGENT_PRECEDENCE.indexOf(a.scope) - AGENT_PRECEDENCE.indexOf(b.scope)
  );
}
