// SPDX-License-Identifier: Apache-2.0
import type { ResourceKind } from '@crewtree/shared';
import { ProjectService } from '../projects/ProjectService.js';
import { EventBus } from '../events/EventBus.js';
import { BuiltinAgents } from './BuiltinAgents.js';
import { decodeResourceId } from './ids.js';
import { scanAgents } from './scan/agents.js';
import { scanCommands } from './scan/commands.js';
import { readText } from './scan/common.js';
import { scanMcp } from './scan/mcp.js';
import { scanMemory } from './scan/memory.js';
import { scanPlugins } from './scan/plugins.js';
import { scanSkills } from './scan/skills.js';
import type { ResourceDetail, ResourceItem } from './types.js';

export const SCANNED_KINDS: ResourceKind[] = ['agent', 'skill', 'command', 'memory', 'mcp', 'plugin'];

/**
 * Lists Claude Code resources from disk for the current project (PLAN.md 6.1). Results are cached per
 * kind and dropped by the watcher (or a write) so the UI follows CLI/editor changes within ~1 second.
 */
export class ResourceScanner {
  private static instance: ResourceScanner;
  private cache = new Map<ResourceKind, { project: string; items: ResourceItem[] }>();

  private constructor() {
    ProjectService.getInstance().onChange(() => this.invalidate('*'));
  }

  public static getInstance(): ResourceScanner {
    if (!ResourceScanner.instance) {
      ResourceScanner.instance = new ResourceScanner();
      void BuiltinAgents.getInstance().load(() => {
        ResourceScanner.instance.invalidate('agent');
        EventBus.getInstance().emitEvent({
          sessionId: '',
          type: 'resource.changed',
          payload: { kind: 'agent' },
          ts: Date.now(),
        });
      });
    }
    return ResourceScanner.instance;
  }

  public invalidate(kind: ResourceKind | '*'): void {
    if (kind === '*') this.cache.clear();
    else this.cache.delete(kind);
    // Plugins provide agents, skills, commands and MCP servers
    if (kind === 'plugin') for (const k of ['agent', 'skill', 'command', 'mcp'] as const) this.cache.delete(k);
  }

  public list(kind: ResourceKind): ResourceItem[] {
    const project = ProjectService.getInstance().currentPath();
    const cached = this.cache.get(kind);
    if (cached && cached.project === project) return cached.items;
    const items = this.scan(kind, project);
    this.cache.set(kind, { project, items });
    return items;
  }

  private scan(kind: ResourceKind, project: string): ResourceItem[] {
    switch (kind) {
      case 'agent':
        return scanAgents(project, BuiltinAgents.getInstance().list());
      case 'skill':
        return scanSkills(project);
      case 'command':
        return scanCommands(project);
      case 'memory':
        return scanMemory(project);
      case 'mcp':
        return scanMcp(project);
      case 'plugin':
        return scanPlugins(project);
    }
  }

  public find(id: string): ResourceItem | undefined {
    const { kind } = decodeResourceId(id);
    return this.list(kind).find((item) => item.id === id);
  }

  /** Item plus file content (MCP servers: the masked config instead). */
  public get(id: string): ResourceDetail {
    const item = this.find(id);
    if (!item) throw new Error('Resource not found');
    if (item.kind === 'mcp' || item.kind === 'plugin' || !item.path) return item;
    return { ...item, content: readText(item.path) };
  }
}
