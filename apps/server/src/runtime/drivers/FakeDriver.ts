// SPDX-License-Identifier: Apache-2.0
import { AgentDriver, DriverCapabilities, DriverOptions } from '../AgentDriver.js';
import { RuntimeType } from '@crewtree/shared';
import { nanoid } from 'nanoid';

/** Builds the SDK-shaped messages for one turn, given the user message and the session id. */
export type FakeScenario = (content: string, sessionId: string) => any[];

/**
 * Emits SDK-shaped messages (system init → stream_event deltas → assistant → result) so the real
 * eventNormalizer/AgentRuntime pipeline is exercised without spending tokens (PLAN.md 18).
 */
export const echoScenario: FakeScenario = (content, sessionId) => {
  const text = `[FakeDriver] Received: ${content}`;
  const half = Math.ceil(text.length / 2);
  return [
    { type: 'system', subtype: 'init', session_id: sessionId },
    ...[text.slice(0, half), text.slice(half)].map((chunk) => ({
      type: 'stream_event',
      session_id: sessionId,
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } },
    })),
    {
      type: 'assistant',
      session_id: sessionId,
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
    {
      type: 'result',
      subtype: 'success',
      session_id: sessionId,
      is_error: false,
      num_turns: 1,
      result: text,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
    },
  ];
};

export class FakeDriver implements AgentDriver {
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

  /** Options of the last init(), exposed for tests. */
  public lastInitOptions?: DriverOptions;
  private isDisposed = false;
  private sessionId?: string;
  private timers = new Set<NodeJS.Timeout>();

  constructor(
    private scenario: FakeScenario = echoScenario,
    private stepMs = 5
  ) {}

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  async init(options: DriverOptions): Promise<void> {
    this.lastInitOptions = options;
    this.sessionId = options.resumeSessionId ?? `fake-${nanoid(8)}`;
  }

  async sendMessage(content: string): Promise<void> {
    if (this.isDisposed) return;
    const messages = this.scenario(content, this.sessionId!);
    messages.forEach((msg, i) => {
      const timer = setTimeout(
        () => {
          this.timers.delete(timer);
          if (!this.isDisposed) this.lastInitOptions?.onEvent?.(msg);
        },
        this.stepMs * (i + 1)
      );
      this.timers.add(timer);
    });
  }

  async interrupt(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.lastInitOptions?.onEvent?.({
      type: 'result',
      subtype: 'error_during_execution',
      session_id: this.sessionId,
      is_error: true,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  }

  async dispose(): Promise<void> {
    this.isDisposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
