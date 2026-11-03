// SPDX-License-Identifier: Apache-2.0
import path from 'path';
import type { ResourceScope } from '@crewtree/shared';
import { getClaudeDir } from '../../paths.js';
import { readFrontmatter } from '../frontmatter.js';
import { encodeResourceId } from '../ids.js';
import type { ResourceItem } from '../types.js';
import { describe, markdownFiles, readText } from './common.js';
import { listInstalledPlugins } from './plugins.js';

function commandItems(dir: string, scope: ResourceScope, plugin?: string): ResourceItem[] {
  return markdownFiles(dir, true).flatMap(({ file, rel }) => {
    const content = readText(file);
    if (content === undefined) return [];
    const name = rel.replace(/\.md$/, '');
    const fm = readFrontmatter(content);
    return [
      {
        id: encodeResourceId('command', scope, plugin ? `${plugin}/${name}` : name),
        kind: 'command' as const,
        name: name.split('/').pop()!,
        scope,
        path: file,
        description: describe(content),
        readOnly: scope === 'plugin',
        plugin,
        metadata: {
          namespace: name.includes('/') ? name.split('/').slice(0, -1).join('/') : undefined,
          argumentHint: fm['argument-hint'],
          allowedTools: fm['allowed-tools'],
        },
      },
    ];
  });
}

/** Slash commands: `*.md`, subfolders are namespaces (PLAN.md 6.1). */
export function scanCommands(projectDir: string): ResourceItem[] {
  const items = [
    ...commandItems(path.join(getClaudeDir(), 'commands'), 'user'),
    ...commandItems(path.join(projectDir, '.claude', 'commands'), 'project'),
  ];
  for (const plugin of listInstalledPlugins(projectDir).filter((p) => p.enabled)) {
    items.push(...commandItems(path.join(plugin.installPath, 'commands'), 'plugin', plugin.id));
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}
