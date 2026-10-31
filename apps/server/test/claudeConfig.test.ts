// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildClaudeConfigOptions } from '../src/runtime/claudeConfig.js';

const all = { claudemd: true, skillsPlugins: true, hooks: true, permissions: true };

function projectWithSettings(settings: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewtree-proj-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(settings));
  return dir;
}

describe('buildClaudeConfigOptions', () => {
  it('loads everything like the CLI when all groups are on', () => {
    expect(buildClaudeConfigOptions(all, os.tmpdir())).toEqual({ warnings: [] });
  });

  it('turns hooks and CLAUDE.md off without dropping other sources', () => {
    const res = buildClaudeConfigOptions({ ...all, hooks: false, claudemd: false }, os.tmpdir());
    expect(res.settingSources).toBeUndefined();
    expect(res.settings).toMatchObject({ disableAllHooks: true, claudeMdExcludes: expect.any(Array) });
  });

  it('disables skills and every enabled plugin', () => {
    const cwd = projectWithSettings({ enabledPlugins: { 'fmt@tools': true } });
    const res = buildClaudeConfigOptions({ ...all, skillsPlugins: false }, cwd);
    expect(res.skills).toEqual([]);
    expect(res.settings).toMatchObject({ enabledPlugins: { 'fmt@tools': false } });
  });

  it('never bypasses permissions; warns when rules cannot be separated', () => {
    const res = buildClaudeConfigOptions({ ...all, permissions: false }, os.tmpdir());
    expect(res.warnings).toHaveLength(1);
    expect(JSON.stringify(res)).not.toContain('bypassPermissions');
  });

  it('drops file sources but re-adds hooks when only hooks stay on', () => {
    const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] }] };
    const cwd = projectWithSettings({ hooks, permissions: { allow: ['Bash(*)'] } });
    const res = buildClaudeConfigOptions(
      { claudemd: false, skillsPlugins: false, hooks: true, permissions: false },
      cwd
    );
    expect(res.settingSources).toEqual([]);
    expect(res.settings).toEqual({ hooks });
  });
});
