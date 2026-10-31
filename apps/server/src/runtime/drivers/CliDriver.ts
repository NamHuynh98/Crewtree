// SPDX-License-Identifier: Apache-2.0
/**
 * CliDriver — fallback driver that spawns the `claude` CLI process
 * when the @anthropic-ai/claude-agent-sdk is unavailable or credentials
 * are not accessible via the SDK.
 *
 * CLI invocation: claude -p --input-format stream-json --output-format stream-json
 *
 * Each message is sent as a JSON line to stdin; responses come back as JSON lines on stdout.
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
    supportsResume: false,
    supportsModelList: false,
    supportsSkills: false,
    supportsPlugins: false,
    supportsMemoryFiles: false,
  };

  private options?: DriverOptions;
  private proc?: ChildProcess;
  private isDisposed = false;

  async init(options: DriverOptions): Promise<void> {
    this.options = options;

    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json'];
    if (options.model) args.push('--model', options.model);
    if (options.systemPrompt) args.push('--system-prompt', options.systemPrompt);

    this.proc = spawn('claude', args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (!this.proc.stdout) return;

    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      if (!line.trim() || this.isDisposed) return;
      try {
        const msg = JSON.parse(line);
        options.onEvent?.(msg);
      } catch {
        // ignore non-JSON lines
      }
    });

    this.proc.stderr?.on('data', (data) => {
      console.error('[CliDriver] stderr:', data.toString());
    });

    this.proc.on('exit', (code) => {
      if (!this.isDisposed) {
        console.warn(`[CliDriver] Process exited with code ${code}`);
      }
    });
  }

  async sendMessage(content: string): Promise<void> {
    if (this.isDisposed || !this.proc?.stdin) return;
    const msg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
    });
    this.proc.stdin.write(msg + '\n');
  }

  async interrupt(): Promise<void> {
    if (this.proc && !this.isDisposed) {
      this.proc.kill('SIGINT');
    }
  }

  async dispose(): Promise<void> {
    this.isDisposed = true;
    if (this.proc) {
      this.proc.stdin?.end();
      this.proc.kill();
      this.proc = undefined;
    }
  }
}
