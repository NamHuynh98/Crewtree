// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { appDir, binPath, crewtreeDir, currentLink, files, isInstalled, isWindows, serverEntry } from './layout.js';
import { health, stopServer } from './server.js';
import { c, CliError, confirm, fail, info, ok, warn } from './ui.js';

const LAUNCHD_LABEL = 'dev.crewtree.server';
const TASK_NAME = 'Crewtree';

function launchdPlist(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

/** The server entry through `current`, so updates apply without touching autostart. */
function autostartEntry(): string {
  return isInstalled() ? serverEntry(currentLink()) : serverEntry();
}

function run(cmd: string, args: string[]) {
  return spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', shell: false });
}

export function autostartEnabled(): boolean {
  if (process.platform === 'darwin') return fs.existsSync(launchdPlist());
  if (isWindows) return run('schtasks', ['/Query', '/TN', TASK_NAME]).status === 0;
  return false;
}

/** `crewtree autostart on|off`: launchd (macOS) / Task Scheduler at logon (Windows), PLAN.md 16.3. */
export function autostart(mode: 'on' | 'off') {
  if (process.platform === 'darwin') {
    const plist = launchdPlist();
    const uid = process.getuid?.() ?? 0;
    if (mode === 'off') {
      run('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]);
      fs.rmSync(plist, { force: true });
      ok('Autostart off');
      return;
    }
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.mkdirSync(files.logs(), { recursive: true });
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    fs.writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(process.execPath)}</string><string>${esc(autostartEntry())}</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>NODE_ENV</key><string>production</string><key>PATH</key><string>${esc(process.env.PATH ?? '')}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${esc(files.serverLog())}</string>
  <key>StandardErrorPath</key><string>${esc(files.serverLog())}</string>
</dict>
</plist>
`
    );
    run('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]);
    const res = run('launchctl', ['bootstrap', `gui/${uid}`, plist]);
    if (res.status !== 0)
      warn(`launchctl: ${res.stderr.trim() || 'could not load the agent now; it starts at next login'}`);
    ok(`Autostart on (${plist})`);
    return;
  }
  if (isWindows) {
    if (mode === 'off') {
      run('schtasks', ['/Delete', '/F', '/TN', TASK_NAME]);
      ok('Autostart off');
      return;
    }
    const tr = `"${process.execPath}" "${autostartEntry()}"`;
    const res = run('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', TASK_NAME, '/TR', tr]);
    if (res.status !== 0) throw new CliError(`schtasks failed: ${(res.stderr || res.stdout).trim()}`);
    ok('Autostart on (Task Scheduler: Crewtree, at logon)');
    return;
  }
  throw new CliError('Autostart is supported on macOS and Windows (Linux arrives later)');
}

/** `crewtree uninstall [--purge]`: lists what goes, asks, keeps data unless --purge (PLAN.md 16.3). */
export async function uninstall(opts: { purge?: boolean; yes?: boolean }) {
  const items: string[] = [];
  if (fs.existsSync(appDir())) items.push(`${appDir()}  (installed versions)`);
  if (fs.existsSync(binPath())) items.push(`${binPath()}  (crewtree command)`);
  if (autostartEnabled())
    items.push(process.platform === 'darwin' ? launchdPlist() : 'Task Scheduler entry "Crewtree"');
  if (opts.purge) items.push(`${crewtreeDir()}  (database, sessions, Crewtree agents, uploads, logs)`);
  if (!items.length) {
    ok('Nothing to uninstall');
    return;
  }
  console.log('This removes:');
  for (const i of items) info(`- ${i}`);
  if (!opts.purge)
    info(c.dim(`Your data in ${crewtreeDir()} is kept (use --purge to remove it). ~/.claude is never touched.`));
  if (!opts.yes && !(await confirm('Continue?'))) {
    fail('Cancelled');
    return;
  }
  if (await health()) await stopServer();
  if (autostartEnabled()) autostart('off');
  fs.rmSync(binPath(), { force: true });
  fs.rmSync(appDir(), { recursive: true, force: true });
  if (opts.purge) fs.rmSync(crewtreeDir(), { recursive: true, force: true });
  ok('Crewtree was uninstalled');
  if (isWindows) info(`Remove ${path.dirname(binPath())} from your user PATH if you added it.`);
  else info(`Remove the PATH line for ~/.local/bin from your shell profile if you added it only for Crewtree.`);
}

// ---------------------------------------------------------------- doctor

function which(cmd: string): string | undefined {
  const res = isWindows ? run('where', [cmd]) : run('/usr/bin/env', ['which', cmd]);
  return res.status === 0 ? res.stdout.split(/\r?\n/)[0].trim() : undefined;
}

function gitBash(): string | undefined {
  const candidates = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean) as string[];
  return candidates.find((p) => fs.existsSync(p));
}

function writable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** `crewtree doctor`: environment, server, port, permissions, Git Bash on Windows (PLAN.md 16.3). */
export async function doctor(version: string, installLabel: string): Promise<number> {
  let problems = 0;
  const bad = (msg: string, hint?: string) => {
    problems++;
    fail(msg);
    if (hint) info(c.dim(hint));
  };
  console.log(c.bold(`Crewtree v${version}`) + c.dim(` · ${installLabel}`));
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) ok(`Node ${process.version} (${process.platform}-${process.arch})`);
  else bad(`Node ${process.version}: Crewtree needs Node 22 or newer`, 'Install Node 22 LTS from https://nodejs.org');

  const claude = which(isWindows ? 'claude.cmd' : 'claude') ?? which('claude');
  if (claude) {
    const v = run(claude, ['--version']);
    ok(`Claude Code ${v.stdout.trim() || ''} (${claude})`);
  } else
    bad(
      'Claude Code is not on PATH',
      'Install it: https://docs.claude.com/claude-code, then run `claude` once to log in'
    );

  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  if (writable(claudeDir)) ok(`Writable: ${claudeDir}`);
  else bad(`Not writable: ${claudeDir}`);
  if (writable(crewtreeDir())) ok(`Writable: ${crewtreeDir()}`);
  else bad(`Not writable: ${crewtreeDir()}`);

  if (isWindows) {
    const bash = gitBash();
    if (bash) ok(`Git Bash: ${bash}`);
    else
      bad(
        'Git Bash not found: Claude Code needs it for the Bash tool on Windows',
        'Install Git for Windows or set CLAUDE_CODE_GIT_BASH_PATH'
      );
  }

  const h = await health();
  if (h) {
    ok(`Server running: pid ${h.pid}, http://127.0.0.1:${h.port}, v${h.version}, ${h.runningAgents} agent process(es)`);
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}/api/claude/status`, { signal: AbortSignal.timeout(3000) });
      if (res.status === 401) info(c.dim('Claude Code login: open the UI to see it (Settings → Account)'));
    } catch {
      // optional
    }
  } else warn('Server is not running (start it with `crewtree`)');

  if (isInstalled()) {
    const onPath = which('crewtree');
    if (onPath) ok(`crewtree on PATH: ${onPath}`);
    else warn(`crewtree is not on PATH; add ${path.dirname(binPath())} to PATH`);
  }
  console.log(problems ? c.red(`\n${problems} problem(s) found`) : c.green('\nAll checks passed'));
  return problems;
}
