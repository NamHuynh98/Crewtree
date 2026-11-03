// SPDX-License-Identifier: Apache-2.0
import crypto from 'crypto';
import path from 'path';
import { watch, type FSWatcher } from 'chokidar';
import type { ResourceKind } from '@crewtree/shared';
import { EventBus } from '../events/EventBus.js';
import { ProjectService } from '../projects/ProjectService.js';
import { getClaudeDir, getCrewtreeAgentsDir, normalizePath } from '../paths.js';
import { ResourceScanner } from './ResourceScanner.js';
import { readText } from './scan/common.js';
import { autoMemoryDir } from './scan/memory.js';
import { claudeJsonPath } from './scan/mcp.js';

const DEBOUNCE_MS = 300;

/**
 * Watches the resource locations of PLAN.md 6.1 and announces `resource.changed` per kind, so files
 * edited from the CLI or an editor show up on the web within about a second.
 */
export class ResourceWatcher {
  private static instance: ResourceWatcher;
  private watcher?: FSWatcher;
  private timers = new Map<string, NodeJS.Timeout>();
  private claudeJsonHash?: string;

  public static getInstance(): ResourceWatcher {
    if (!ResourceWatcher.instance) ResourceWatcher.instance = new ResourceWatcher();
    return ResourceWatcher.instance;
  }

  private paths(project: string) {
    const claude = getClaudeDir();
    return [
      getCrewtreeAgentsDir(),
      path.join(claude, 'agents'),
      path.join(claude, 'skills'),
      path.join(claude, 'commands'),
      path.join(claude, 'CLAUDE.md'),
      path.join(claude, 'settings.json'),
      path.join(claude, 'plugins', 'installed_plugins.json'),
      claudeJsonPath(),
      path.join(project, '.claude'),
      path.join(project, 'CLAUDE.md'),
      path.join(project, 'CLAUDE.local.md'),
      path.join(project, '.mcp.json'),
      autoMemoryDir(project),
    ];
  }

  /** Which resource kind a changed path belongs to. */
  public static kindOf(file: string, project: string): ResourceKind | undefined {
    const p = normalizePath(file);
    const claude = normalizePath(getClaudeDir());
    if (p.startsWith(normalizePath(getCrewtreeAgentsDir())) || /\/\.claude\/agents(\/|$)/.test(p)) return 'agent';
    if (/\/\.claude\/skills(\/|$)/.test(p) || p.startsWith(`${claude}/skills`)) return 'skill';
    if (/\/\.claude\/commands(\/|$)/.test(p) || p.startsWith(`${claude}/commands`)) return 'command';
    if (p.endsWith('/installed_plugins.json') || /\/settings(\.local)?\.json$/.test(p)) return 'plugin';
    if (p.endsWith('.mcp.json') || p === normalizePath(claudeJsonPath())) return 'mcp';
    if (/CLAUDE(\.local)?\.md$/.test(p) || p.startsWith(normalizePath(autoMemoryDir(project)))) return 'memory';
    return undefined;
  }

  public start(): void {
    this.stop();
    const project = ProjectService.getInstance().currentPath();
    this.claudeJsonHash = this.mcpHash();
    this.watcher = watch(this.paths(project), {
      ignoreInitial: true,
      depth: 4,
      followSymlinks: true,
      ignored: (p: string) => /node_modules|\.git\//.test(p),
    });
    const onChange = (file: string) => {
      // ~/.claude.json is rewritten constantly by Claude Code: only its MCP part matters here
      if (normalizePath(file) === normalizePath(claudeJsonPath())) {
        const hash = this.mcpHash();
        if (hash === this.claudeJsonHash) return;
        this.claudeJsonHash = hash;
      }
      const kind = ResourceWatcher.kindOf(file, project);
      if (kind) this.schedule(kind);
    };
    this.watcher
      .on('add', onChange)
      .on('change', onChange)
      .on('unlink', onChange)
      .on('addDir', onChange)
      .on('unlinkDir', onChange);
    this.watcher.on('error', (err) => console.warn('[ResourceWatcher]', err));
  }

  private mcpHash(): string {
    try {
      const data = JSON.parse(readText(claudeJsonPath()) ?? '{}');
      const relevant = {
        user: data.mcpServers,
        projects: Object.fromEntries(
          Object.entries(data.projects ?? {}).map(([k, v]: [string, any]) => [k, v?.mcpServers])
        ),
      };
      return crypto.createHash('sha1').update(JSON.stringify(relevant)).digest('hex');
    } catch {
      return '';
    }
  }

  private schedule(kind: ResourceKind) {
    clearTimeout(this.timers.get(kind));
    this.timers.set(
      kind,
      setTimeout(() => {
        this.timers.delete(kind);
        ResourceScanner.getInstance().invalidate(kind);
        EventBus.getInstance().emitEvent({
          sessionId: '',
          type: 'resource.changed',
          payload: { kind, source: 'watcher' },
          ts: Date.now(),
        });
      }, DEBOUNCE_MS)
    );
  }

  public async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    const w = this.watcher;
    this.watcher = undefined;
    await w?.close();
  }
}
