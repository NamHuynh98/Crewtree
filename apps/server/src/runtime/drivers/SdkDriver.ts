// SPDX-License-Identifier: Apache-2.0
import { query, Query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentDriver, DriverCapabilities, DriverOptions, DriverToolHooks } from '../AgentDriver.js';
import { RuntimeType } from '@crewtree/shared';
import { toUserContent } from '../../uploads/composeMessage.js';

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

  get pending(): number {
    return this.queue.length;
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

/** Wait time for a hook in seconds; approvals happen in canUseTool, hooks only answer locally. */
const HOOK_TIMEOUT_SEC = 60;

function toSdkHooks(hooks: DriverToolHooks): Options['hooks'] {
  const result: NonNullable<Options['hooks']> = {};
  if (hooks.preToolUse) {
    const pre = hooks.preToolUse;
    result.PreToolUse = [
      {
        timeout: HOOK_TIMEOUT_SEC,
        hooks: [
          async (input) => {
            if (input.hook_event_name !== 'PreToolUse') return {};
            const decision = await pre(input.tool_name, input.tool_input, input.tool_use_id);
            if (!decision.decision) return {};
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: decision.decision,
                permissionDecisionReason: decision.reason,
              },
            };
          },
        ],
      },
    ];
  }
  if (hooks.postToolUse) {
    const post = hooks.postToolUse;
    result.PostToolUse = [
      {
        timeout: HOOK_TIMEOUT_SEC,
        hooks: [
          async (input) => {
            if (input.hook_event_name === 'PostToolUse') {
              await post(input.tool_name, input.tool_input, input.tool_response, input.tool_use_id);
            }
            return {};
          },
        ],
      },
    ];
  }
  return result;
}

/** Attachment markers become image/document blocks (PLAN.md 8). */
function userMessage(content: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: toUserContent(content) },
    parent_tool_use_id: null,
  } as SDKUserMessage;
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
  private queryOptions?: Options;
  private inputQueue = new AsyncQueue<SDKUserMessage>();
  private queryInstance?: Query;
  private abortController = new AbortController();
  private isDisposed = false;
  private sdkSessionId?: string;
  private receivedAnyMessage = false;
  private lastSentContent?: string;

  public getSessionId(): string | undefined {
    return this.sdkSessionId;
  }

  async init(options: DriverOptions): Promise<void> {
    this.options = options;
    this.sdkSessionId = options.resumeSessionId;

    const queryOptions: Options = {
      cwd: options.cwd,
      systemPrompt: options.systemPrompt,
      model: options.model,
      tools: options.tools,
      allowedTools: options.allowedTools,
      resume: options.resumeSessionId,
      includePartialMessages: true,
      abortController: this.abortController,
      canUseTool: async (toolName, input) => {
        if (!options.canUseTool) return { behavior: 'allow', updatedInput: input };
        const res = await options.canUseTool(toolName, input);
        return res.allow
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: res.reason || 'Denied by user' };
      },
    };

    if (options.mcpServers) queryOptions.mcpServers = options.mcpServers;
    if (options.maxTurns) queryOptions.maxTurns = options.maxTurns;
    if (options.permissionMode) queryOptions.permissionMode = options.permissionMode;
    if (options.hooks) queryOptions.hooks = toSdkHooks(options.hooks);

    const cfg = options.claudeConfig;
    if (cfg?.settingSources) queryOptions.settingSources = cfg.settingSources;
    if (cfg?.settings) queryOptions.settings = cfg.settings as Options['settings'];
    if (cfg?.skills) queryOptions.skills = cfg.skills;

    this.queryOptions = queryOptions;
    this.startQuery(queryOptions);
  }

  private startQuery(queryOptions: Options) {
    this.queryInstance = query({ prompt: this.inputQueue, options: queryOptions });
    this.consumeStream().catch((err) => this.emitError(err));
  }

  private emitError(err: any) {
    if (this.isDisposed) return;
    console.error(`[SdkDriver] Stream error for agent ${this.options?.sessionAgentId}:`, err);
    this.options?.onEvent?.({ type: 'crewtree.error', error: err?.message ?? String(err) });
  }

  private async consumeStream(): Promise<void> {
    const current = this.queryInstance;
    if (!current) return;

    try {
      for await (const message of current) {
        if (this.isDisposed) break;
        this.receivedAnyMessage = true;
        if ((message as any).session_id) {
          this.sdkSessionId = (message as any).session_id;
        }
        this.options?.onEvent?.(message);
      }
      if (!this.isDisposed && current === this.queryInstance) {
        this.emitError(new Error('Claude Code process exited unexpectedly'));
      }
    } catch (err: any) {
      if (this.isDisposed) return;

      // Resuming an expired/missing session: start a clean session and replay the last message.
      if (
        this.queryOptions?.resume &&
        !this.receivedAnyMessage &&
        /No conversation found with session ID/i.test(err?.message ?? '')
      ) {
        console.warn(`[SdkDriver] Resume session "${this.queryOptions.resume}" not found. Starting a clean session.`);
        this.sdkSessionId = undefined;
        this.queryOptions = { ...this.queryOptions, resume: undefined };
        if (this.lastSentContent !== undefined && this.inputQueue.pending === 0)
          this.inputQueue.push(userMessage(this.lastSentContent));
        this.startQuery(this.queryOptions);
        return;
      }

      throw err;
    }
  }

  async sendMessage(content: string): Promise<void> {
    if (this.isDisposed) return;
    this.lastSentContent = content;
    this.inputQueue.push(userMessage(content));
  }

  async setModel(model: string | undefined): Promise<void> {
    if (this.queryInstance && !this.isDisposed) await this.queryInstance.setModel(model);
  }

  async interrupt(): Promise<void> {
    if (this.queryInstance && !this.isDisposed) {
      await this.queryInstance.interrupt();
    }
  }

  async dispose(): Promise<void> {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.inputQueue.close();
    this.queryInstance?.close();
    this.abortController.abort();
  }
}
