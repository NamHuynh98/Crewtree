// SPDX-License-Identifier: Apache-2.0
import { query, Query } from '@anthropic-ai/claude-agent-sdk';
import { AgentDriver, DriverCapabilities, DriverOptions } from '../AgentDriver.js';
import { RuntimeType } from '@crewtree/shared';

export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private done = false;

  push(value: T) {
    if (this.done) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  close() {
    this.done = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      resolver?.({ value: undefined as any, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          const value = this.queue.shift()!;
          return Promise.resolve({ value, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as any, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined as any, done: true });
      },
    };
  }
}

export class SdkDriver implements AgentDriver {
  readonly runtime: RuntimeType = 'claude';
  readonly capabilities: DriverCapabilities = {
    supportsPreToolHook: true,
    supportsPermissionCallback: true,
    supportsStreamingInput: true,
    supportsResume: true,
    supportsModelList: true,
    supportsSkills: true,
    supportsPlugins: true,
    supportsMemoryFiles: true,
  };

  private options?: DriverOptions;
  private inputQueue = new AsyncQueue<any>();
  private queryInstance?: Query;
  private isDisposed = false;
  private sdkSessionId?: string;

  public getSessionId(): string | undefined {
    return this.sdkSessionId;
  }

  async init(options: DriverOptions): Promise<void> {
    this.options = options;

    const queryOptions: any = {
      cwd: options.cwd,
      systemPrompt: options.systemPrompt,
      model: options.model,
      allowedTools: options.allowedTools,
      resume: options.resumeSessionId,
      canUseTool: async (toolName: string, input: any) => {
        if (options.canUseTool) {
          const res = await options.canUseTool(toolName, input);
          return res.allow ? { behavior: 'allow' } : { behavior: 'deny', message: res.reason || 'Denied by user' };
        }
        return { behavior: 'allow' };
      },
    };

    if (options.mcpServers) {
      queryOptions.mcpServers = options.mcpServers;
    }

    if (options.configGroups) {
      if (options.configGroups.claudemd === false) {
        queryOptions.settingSources = [];
      }
      if (options.configGroups.skillsPlugins === false) {
        queryOptions.skills = [];
      }
      if (options.configGroups.permissions === false) {
        queryOptions.permissionMode = 'bypassPermissions';
        queryOptions.allowDangerouslySkipPermissions = true;
      }
    }

    try {
      this.queryInstance = query({
        prompt: this.inputQueue,
        options: queryOptions,
      });

      // Start consuming the event stream in background
      this.consumeStream().catch((err) => {
        console.error(`[SdkDriver] Error in stream for agent ${options.sessionAgentId}:`, err);
        options.onEvent?.({
          type: 'agent.status',
          payload: { status: 'error', error: err.message },
        });
      });
    } catch (err: any) {
      console.error('[SdkDriver] Failed to initialize query:', err);
      throw err;
    }
  }

  private async consumeStream(): Promise<void> {
    if (!this.queryInstance) return;

    for await (const message of this.queryInstance) {
      if (this.isDisposed) break;

      // Extract SDK session ID if not yet captured
      if (!this.sdkSessionId && (message as any).session_id) {
        this.sdkSessionId = (message as any).session_id;
      }

      this.options?.onEvent?.(message);
    }
  }

  async sendMessage(content: string): Promise<void> {
    if (this.isDisposed) return;
    this.inputQueue.push({
      type: 'user',
      message: {
        role: 'user',
        content,
      },
    });
  }

  async interrupt(): Promise<void> {
    if (this.queryInstance && !this.isDisposed) {
      await this.queryInstance.interrupt();
    }
  }

  async dispose(): Promise<void> {
    this.isDisposed = true;
    this.inputQueue.close();
    if (this.queryInstance) {
      this.queryInstance.close();
    }
  }
}
