// SPDX-License-Identifier: Apache-2.0
/**
 * CliDriver — fallback driver that spawns the `claude` CLI process
 * when the @anthropic-ai/claude-agent-sdk cannot run with the `claude login` credentials.
 *
 * CLI invocation: claude -p --input-format stream-json --output-format stream-json --verbose …
 * Each message is sent as a JSON line to stdin; responses come back as JSON lines on stdout
 * (same message shape as the SDK, so the same eventNormalizer applies).
 *
 * Limitations (see capabilities): no permission callback (tools not allowed by settings are denied),
 * and in-process MCP servers cannot be passed to the CLI — orchestration tools need the
 * HTTP MCP endpoint `/mcp/:sessionAgentId` (PLAN.md 3.2), which lands with Phase 2.
 */
import { spawn, ChildProcess } from 'child_process';
import { AgentDriver, DriverCapabilities, DriverOptions } from '../AgentDriver.js';
import { RuntimeType } from '@crewtree/shared';
import { createInterface } from 'readline';

export class CliDriver implements AgentDriver {
  readonly runtime: RuntimeType = 'claude';
  readonly capabilities: DriverCapabilities = {
    supportsPreToolHook: false,
    supportsPermissionCallback: false,
    supportsStreamingInput: true,
    supportsResume: true,
    supportsModelList: false,
    supportsSkills: true,
    supportsPlugins: true,
    supportsMemoryFiles: true,
  };

  private options?: DriverOptions;
  private proc?: ChildProcess;
  private isDisposed = false;
  private sessionId?: string;

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  async init(options: DriverOptions): Promise<void> {
    this.options = options;
    this.sessionId = options.resumeSessionId;
    this.spawnProcess();
  }

  private buildArgs(options: DriverOptions): string[] {
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ];
    if (options.model) args.push('--model', options.model);
    if (options.systemPrompt) args.push('--system-prompt', options.systemPrompt);
    if (this.sessionId) args.push('--resume', this.sessionId);
    if (options.tools) args.push('--tools', options.tools.join(','));
    if (options.allowedTools?.length) args.push('--allowedTools', options.allowedTools.join(','));

    const cfg = options.claudeConfig;
    if (cfg?.settingSources) args.push('--setting-sources', cfg.settingSources.join(','));
    if (cfg?.settings) args.push('--settings', JSON.stringify(cfg.settings));
    return args;
  }

  private spawnProcess() {
    const options = this.options!;
    const proc = spawn('claude', this.buildArgs(options), {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.proc = proc;

    const rl = createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
      if (!line.trim() || this.isDisposed) return;
      try {
        const msg = JSON.parse(line);
        if (msg.session_id) this.sessionId = msg.session_id;
        options.onEvent?.(msg);
      } catch {
        // ignore non-JSON lines
      }
    });

    proc.stderr?.on('data', (data) => {
      console.error('[CliDriver] stderr:', data.toString());
    });

    proc.on('error', (err) => {
      if (this.proc !== proc || this.isDisposed) return;
      options.onEvent?.({ type: 'crewtree.error', error: `Failed to start claude CLI: ${err.message}` });
    });

    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return; // replaced by interrupt()
      this.proc = undefined;
      if (!this.isDisposed) {
        options.onEvent?.({ type: 'crewtree.error', error: `claude CLI exited (code ${code}, signal ${signal})` });
      }
    });
  }

  async sendMessage(content: string): Promise<void> {
    if (this.isDisposed) return;
    if (!this.proc) this.spawnProcess(); // respawn after interrupt, resuming the same session
    const msg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    });
    this.proc!.stdin!.write(msg + '\n');
  }

  async interrupt(): Promise<void> {
    // The CLI has no interrupt control message in -p mode: stop the process, respawn with --resume on next send.
    const proc = this.proc;
    if (!proc || this.isDisposed) return;
    this.proc = undefined;
    proc.kill('SIGINT');
    this.options?.onEvent?.({ type: 'crewtree.interrupted' });
  }

  async dispose(): Promise<void> {
    this.isDisposed = true;
    const proc = this.proc;
    this.proc = undefined;
    if (proc) {
      proc.stdin?.end();
      proc.kill();
    }
  }
}
