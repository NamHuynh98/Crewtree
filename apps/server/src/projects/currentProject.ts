// SPDX-License-Identifier: Apache-2.0
import path from 'path';
import { getHomeDir, normalizePath } from '../paths.js';

/**
 * Project the server was opened for: `crewtree [path]` (CREWTREE_PROJECT), else the directory the command was
 * run from. `pnpm --filter … dev` runs inside apps/server, so prefer INIT_CWD (where pnpm was invoked).
 * The project switcher (Phase 3) replaces this with the projects table.
 */
export function getCurrentProjectPath(): string {
  return path.resolve(process.env.CREWTREE_PROJECT || process.env.INIT_CWD || process.cwd());
}

export function getCurrentProject() {
  const projectPath = getCurrentProjectPath();
  return {
    path: normalizePath(projectPath),
    name: path.basename(projectPath),
    homeDir: normalizePath(getHomeDir()),
  };
}
