#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { Command } from 'commander';
import open from 'open';
import fs from 'fs';
import path from 'path';
import os from 'os';

const program = new Command();

function getCrewtreeDir(): string {
  return process.env.CREWTREE_DIR || path.join(os.homedir(), '.crewtree');
}

program
  .name('crewtree')
  .description('Multi-agent orchestration system on top of Claude Code')
  .version('0.1.0')
  .argument('[targetPath]', 'Target project directory to open')
  .action(async (targetPath) => {
    const cwd = targetPath ? path.resolve(targetPath) : process.cwd();
    console.log(`🌲 Launching Crewtree for project: ${cwd}`);

    // Check if server is running
    try {
      const res = await fetch('http://127.0.0.1:4317/api/health');
      if (res.ok) {
        console.log('✅ Server already running. Opening web browser...');
        await open('http://127.0.0.1:4317');
        return;
      }
    } catch {
      console.log('ℹ️ Server is not running. Please start the server using: pnpm dev');
    }
  });

program
  .command('status')
  .description('Check server status')
  .action(async () => {
    try {
      const res = await fetch('http://127.0.0.1:4317/api/health');
      if (res.ok) {
        const data = await res.json();
        console.log(
          `✅ Crewtree Server is running (PID: ${data.pid}, Uptime: ${Math.round(data.uptime)}s, Version: ${data.version})`
        );
      } else {
        console.log('❌ Server returned non-200 response.');
      }
    } catch {
      console.log('⭕ Server is offline.');
    }
  });

program
  .command('stop')
  .description('Stop running server')
  .action(async () => {
    const tokenPath = path.join(getCrewtreeDir(), 'shutdown.token');
    if (!fs.existsSync(tokenPath)) {
      console.log('❌ No active shutdown token found.');
      return;
    }
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    try {
      const res = await fetch('http://127.0.0.1:4317/api/shutdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        console.log('✅ Server stopped successfully.');
      } else {
        console.log('❌ Failed to stop server:', await res.text());
      }
    } catch (err: any) {
      console.log('❌ Could not connect to server:', err.message);
    }
  });

program
  .command('doctor')
  .description('Check environment, node, claude credentials and permissions')
  .action(async () => {
    console.log('🔍 Running Crewtree Doctor...\n');
    console.log(`Node version: ${process.version}`);
    console.log(`Platform: ${process.platform} (${process.arch})`);

    const claudeDir = path.join(os.homedir(), '.claude');
    if (fs.existsSync(claudeDir)) {
      console.log(`✅ Claude Code directory found: ${claudeDir}`);
    } else {
      console.log(`⚠️ Claude Code directory not found at ${claudeDir}`);
    }

    const crewtreeDir = getCrewtreeDir();
    console.log(`Crewtree data directory: ${crewtreeDir}`);
    try {
      fs.mkdirSync(crewtreeDir, { recursive: true });
      fs.accessSync(crewtreeDir, fs.constants.W_OK);
      console.log(`✅ Crewtree directory is writable`);
    } catch (e: any) {
      console.log(`❌ Crewtree directory error: ${e.message}`);
    }
  });

program.parse(process.argv);
