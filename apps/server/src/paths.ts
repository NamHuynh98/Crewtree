// SPDX-License-Identifier: Apache-2.0
import os from 'os';
import path from 'path';
import fs from 'fs';

export function getHomeDir(): string {
  return os.homedir();
}

export function getCrewtreeDir(): string {
  return process.env.CREWTREE_DIR || path.join(getHomeDir(), '.crewtree');
}

export function getClaudeDir(): string {
  // Same override Claude Code itself honors
  return process.env.CLAUDE_CONFIG_DIR || path.join(getHomeDir(), '.claude');
}

export function getCrewtreeAgentsDir(): string {
  return path.join(getCrewtreeDir(), 'agents');
}

export function getDbPath(): string {
  return path.join(getCrewtreeDir(), 'crewtree.db');
}

export function getBackupsDir(): string {
  return path.join(getCrewtreeDir(), 'backups');
}

export function getUploadsDir(): string {
  return path.join(getCrewtreeDir(), 'uploads');
}

export function getSnapshotsDir(): string {
  return path.join(getCrewtreeDir(), 'snapshots');
}

export function getLogsDir(): string {
  return path.join(getCrewtreeDir(), 'logs');
}

export function getConfigPath(): string {
  return path.join(getCrewtreeDir(), 'config.json');
}

export function getPidPath(): string {
  return path.join(getCrewtreeDir(), 'crewtree.pid');
}

/** Agent processes per server (`<server pid>.json`), stopped if that server dies (runtime/agentProcesses.ts) */
export function getAgentProcessesDir(): string {
  return path.join(getCrewtreeDir(), 'agent-processes');
}

export function getShutdownTokenPath(): string {
  return path.join(getCrewtreeDir(), 'shutdown.token');
}

export function getSessionSecretPath(): string {
  return path.join(getCrewtreeDir(), 'session.secret');
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

export function ensureDirectories(): void {
  const dirs = [
    getCrewtreeDir(),
    getCrewtreeAgentsDir(),
    getBackupsDir(),
    getUploadsDir(),
    getSnapshotsDir(),
    getLogsDir(),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
}
