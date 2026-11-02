// SPDX-License-Identifier: Apache-2.0
import { AgentDriver, DriverCapabilities, DriverOptions } from '../AgentDriver.js';
import { RuntimeType } from '@crewtree/shared';
import { nanoid } from 'nanoid';

/** What a scripted fake agent can do during one turn. */
export interface FakeTurnApi {
  /** Assistant text, streamed as two deltas then a completed block */
  text(text: string): Promise<void>;
  /** Calls a Crewtree orchestration tool (mcp__crewtree__*) and returns its text result */
  callTool(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  /** Uses a built-in tool (Edit, Bash…): PreToolUse hook → permission (canUseTool) → PostToolUse hook */
  useTool(
    name: string,
    input: Record<string, unknown>,
    output?: string
  ): Promise<{ allowed: boolean; reason?: string }>;
  /** The message that started this turn */
  readonly content: string;
  readonly turn: number;
}

/**
 * A scenario either returns raw SDK-shaped messages (emitted in order, nothing added) or drives the turn
 * through the api; a `result` message is then emitted when it resolves.
 */
export type FakeScenario = (content: string, sessionId: string, api: FakeTurnApi) => any[] | Promise<void>;

/** Emits SDK-shaped messages so the real eventNormalizer/AgentRuntime pipeline runs without tokens (PLAN.md 18). */
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

class Interrupted extends Error {}

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
  private queue: string[] = [];
  private busy = false;
  private turn = 0;
  /** Turn whose messages may still be emitted; an interrupted turn keeps running silently. */
  private activeTurn = 0;
  private drainGen = 0;

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

  private emit(turn: number, msg: any): boolean {
    if (this.isDisposed || turn !== this.activeTurn) return false;
    this.lastInitOptions?.onEvent?.(msg);
    return true;
  }

  private delay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.stepMs));
  }

  /** Like the SDK's streaming input: messages sent during a turn are processed after it. */
  async sendMessage(content: string): Promise<void> {
    if (this.isDisposed) return;
    this.queue.push(content);
    if (!this.busy) void this.drain();
  }

  private async drain() {
    const gen = ++this.drainGen;
    this.busy = true;
    while (this.queue.length && !this.isDisposed) {
      const content = this.queue.shift()!;
      const turn = ++this.turn;
      this.activeTurn = turn;
      await this.runTurn(turn, content);
      if (this.activeTurn !== turn) return; // interrupted: interrupt() already ended the turn
    }
    if (this.drainGen === gen) this.busy = false;
  }

  private async runTurn(turn: number, content: string) {
    const sid = this.sessionId!;
    const out = this.scenario(content, sid, this.api(turn, content));
    if (Array.isArray(out)) {
      for (const msg of out) {
        await this.delay();
        if (!this.emit(turn, msg)) return;
      }
      return;
    }
    // Mark it handled right away: an interrupted turn may reject before we reach `await`
    out.catch(() => undefined);
    try {
      await this.delay();
      this.emit(turn, { type: 'system', subtype: 'init', session_id: sid });
      await out;
      this.emitResult(turn, false);
    } catch (err) {
      if (!(err instanceof Interrupted)) this.emit(turn, { type: 'crewtree.error', error: (err as Error).message });
    }
  }

  private emitResult(turn: number, isError: boolean) {
    this.emit(turn, {
      type: 'result',
      subtype: isError ? 'error_during_execution' : 'success',
      session_id: this.sessionId,
      is_error: isError,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
    });
  }

  private api(turn: number, content: string): FakeTurnApi {
    const sid = () => this.sessionId;
    const live = async () => {
      await this.delay();
      if (this.isDisposed || this.activeTurn !== turn) throw new Interrupted();
    };
    const assistant = (block: any) =>
      this.emit(turn, {
        type: 'assistant',
        session_id: sid(),
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [block] },
      });
    const toolResult = (id: string, text: string, isError: boolean) =>
      this.emit(turn, {
        type: 'user',
        session_id: sid(),
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }],
        },
      });

    return {
      content,
      turn,
      text: async (text: string) => {
        await live();
        const half = Math.ceil(text.length / 2);
        for (const chunk of [text.slice(0, half), text.slice(half)]) {
          this.emit(turn, {
            type: 'stream_event',
            session_id: sid(),
            parent_tool_use_id: null,
            event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } },
          });
        }
        assistant({ type: 'text', text });
      },
      callTool: async (name, args = {}) => {
        await live();
        const bound = this.lastInitOptions?.boundTools?.find((t) => t.name === name);
        const id = `toolu_${nanoid(8)}`;
        assistant({ type: 'tool_use', id, name: `mcp__crewtree__${name}`, input: args });
        if (!bound) {
          toolResult(id, `No such tool: ${name}`, true);
          return { text: `No such tool: ${name}`, isError: true };
        }
        const res = await bound.run(args);
        const text = res.content.map((c) => c.text).join('\n');
        if (this.activeTurn !== turn) throw new Interrupted();
        toolResult(id, text, !!res.isError);
        return { text, isError: !!res.isError };
      },
      useTool: async (name, input, output = 'ok') => {
        await live();
        const opts = this.lastInitOptions!;
        const id = `toolu_${nanoid(8)}`;
        assistant({ type: 'tool_use', id, name, input });
        const pre = (await opts.hooks?.preToolUse?.(name, input, id)) ?? {};
        let allowed = pre.decision !== 'deny';
        let reason = pre.reason;
        // Like Claude Code with no allow rule in settings: anything the hook did not allow asks canUseTool
        if (allowed && pre.decision !== 'allow' && opts.canUseTool) {
          const decision = await opts.canUseTool(name, input);
          allowed = decision.allow;
          reason = decision.reason;
        }
        if (this.activeTurn !== turn) throw new Interrupted();
        if (!allowed) {
          toolResult(id, reason ?? 'Denied', true);
          return { allowed, reason };
        }
        await opts.hooks?.postToolUse?.(name, input, output, id);
        toolResult(id, output, false);
        return { allowed: true };
      },
    };
  }

  /** Ends the current turn right away (result with is_error), like the SDK's interrupt. */
  async interrupt(): Promise<void> {
    if (!this.busy) return;
    const turn = this.activeTurn;
    this.queue = [];
    this.emitResult(turn, true);
    this.activeTurn = 0;
    this.busy = false;
  }

  async dispose(): Promise<void> {
    this.isDisposed = true;
    this.queue = [];
  }
}
