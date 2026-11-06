#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import { cliVersion, files } from './layout.js';
import { health, openBrowser, readConfig, serveForeground, startServer, stopServer } from './server.js';
import { describeInstall, printUpdateNotice, rollback, update } from './update.js';
import { autostart, doctor, uninstall } from './system.js';
import { c, CliError, fail, info, ok, warn } from './ui.js';

const version = cliVersion();
const program = new Command();

/** Errors print the message, a hint and the log path instead of a stack trace. */
function action<A extends unknown[]>(fn: (...args: A) => Promise<void | number>) {
  return async (...args: A) => {
    try {
      const code = await fn(...args);
      if (typeof code === 'number') process.exitCode = code;
    } catch (err: any) {
      fail(err?.message ?? String(err));
      if (err instanceof CliError && err.hint) info(c.dim(err.hint));
      process.exitCode = 1;
    }
  };
}

function formatUptime(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

program
  .name('crewtree')
  .description('Multi-agent orchestration on top of Claude Code, with a local web UI')
  .version(version)
  .argument('[path]', 'project folder to open (default: the current folder)')
  .option('--no-open', 'start the server without opening the UI')
  .option('--browser', 'open the UI in a browser tab instead of its own app window')
  .action(
    action(async (target: string | undefined, opts: { open: boolean; browser?: boolean }) => {
      const project = path.resolve(target ?? process.cwd());
      if (!fs.existsSync(project) || !fs.statSync(project).isDirectory())
        throw new CliError(`Folder not found: ${project}`);
      let h = await health();
      if (!h) {
        process.stdout.write('Starting Crewtree… ');
        h = await startServer({ project });
        console.log(c.green(`✓ http://127.0.0.1:${h.port}`));
      }
      const { url, openedIn } = await openBrowser(project, !opts.open, opts.browser);
      ok(`Project: ${project}`);
      if (!opts.open) info(`Open: ${url}`);
      if (openedIn === 'fallback')
        info(c.dim('Opened in a browser tab: Crewtree gets its own window with Chrome, Edge, Brave or Chromium.'));
      await printUpdateNotice();
    })
  );

program
  .command('stop')
  .description('stop the server (running agents are stopped; tasks can be resumed later)')
  .action(
    action(async () => {
      if (await stopServer()) ok('Server stopped');
      else info('Server is not running');
    })
  );

program
  .command('status')
  .description('pid, port, uptime, running agents, version')
  .action(
    action(async () => {
      const h = await health();
      if (!h) {
        info(`Server is not running (last port: ${readConfig().port})`);
        return 3;
      }
      ok(
        `Running · pid ${h.pid} · http://127.0.0.1:${h.port} · up ${formatUptime(h.uptime)} · ${h.runningAgents} agent process(es) · v${h.version}`
      );
      if (h.version !== version) warn(`The CLI is v${version}; restart the server with \`crewtree stop && crewtree\``);
      await printUpdateNotice();
    })
  );

program
  .command('logs')
  .description('print the server log')
  .option('-f, --follow', 'keep printing new lines')
  .option('-n, --lines <n>', 'number of lines', '200')
  .action(
    action(async (opts: { follow?: boolean; lines: string }) => {
      const file = files.serverLog();
      if (!fs.existsSync(file)) {
        info(`No log yet (${file})`);
        return;
      }
      const text = fs.readFileSync(file, 'utf8');
      process.stdout.write(
        text
          .split('\n')
          .slice(-Number(opts.lines) - 1)
          .join('\n')
      );
      if (!opts.follow) return;
      let size = fs.statSync(file).size;
      await new Promise<void>(() => {
        fs.watchFile(file, { interval: 500 }, (cur) => {
          if (cur.size < size) size = 0; // rotated
          if (cur.size === size) return;
          const fd = fs.openSync(file, 'r');
          const buf = Buffer.alloc(cur.size - size);
          fs.readSync(fd, buf, 0, buf.length, size);
          fs.closeSync(fd);
          size = cur.size;
          process.stdout.write(buf.toString('utf8'));
        });
      });
    })
  );

program
  .command('doctor')
  .description('check Node, Claude Code, permissions, server, port, Git Bash (Windows)')
  .action(action(async () => ((await doctor(version, describeInstall())) ? 1 : 0)));

program
  .command('update')
  .description('update to the latest release, or to [version]')
  .argument('[version]', 'a release tag such as v0.2.0')
  .option('--check', 'only check whether a new version exists')
  .option('--pre', 'allow pre-releases')
  .option('--archive <file>', 'update offline from a downloaded archive (SHA256SUMS must be next to it)')
  .option('--wait', 'wait for running agents to finish first')
  .option('--force', 'update even if agents are running (their tasks become interrupted)')
  .action(action(async (v: string | undefined, opts) => update({ version: v, ...opts })));

program.command('rollback').description('go back to the previous version and its database').action(action(rollback));

program
  .command('autostart')
  .description('start Crewtree when you log in (launchd / Task Scheduler / systemd)')
  .argument('<mode>', 'on | off')
  .action(
    action(async (mode: string) => {
      if (mode !== 'on' && mode !== 'off') throw new CliError('Use: crewtree autostart on|off');
      autostart(mode);
    })
  );

// Used by autostart (launchd, systemd, Task Scheduler); not meant to be typed
program
  .command('serve', { hidden: true })
  .option('--detach', 'start in the background and return (Windows Task Scheduler)')
  .action(
    action(async (opts: { detach?: boolean }) => {
      if (!opts.detach) return serveForeground();
      if (!(await health())) await startServer();
      return 0;
    })
  );

program
  .command('uninstall')
  .description('remove Crewtree (keeps your data unless --purge)')
  .option('--purge', 'also delete ~/.crewtree (database, sessions, Crewtree agents)')
  .option('-y, --yes', 'do not ask for confirmation')
  .action(action(async (opts: { purge?: boolean; yes?: boolean }) => uninstall(opts)));

await program.parseAsync(process.argv);
