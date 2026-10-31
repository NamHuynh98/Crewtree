// SPDX-License-Identifier: Apache-2.0
import { AgentEvent } from '@crewtree/shared';

export interface NormalizerContext {
  sessionId: string;
  sessionAgentId: string;
}

/**
 * Turns Claude Code SDK / CLI stream-json messages into AgentEvents.
 *
 * - `stream_event` text deltas → `agent.text.delta` (live typing; never persisted)
 * - `assistant` messages carry one completed content block each → `agent.text.done` / `agent.tool.start`
 * - `user` tool results → `agent.tool.end`
 * - `result` (end of turn) → `usage.updated` with the turn's final usage
 *
 * Status changes (running/idle/throttled/error) are owned by AgentRuntime, not emitted here.
 */
export class EventNormalizer {
  constructor(private ctx: NormalizerContext) {}

  private event(type: AgentEvent['type'], payload: Record<string, any>): AgentEvent {
    return {
      sessionId: this.ctx.sessionId,
      sessionAgentId: this.ctx.sessionAgentId,
      type,
      payload,
      ts: Date.now(),
    };
  }

  public normalize(raw: any): AgentEvent[] {
    if (!raw || typeof raw !== 'object') return [];
    const events: AgentEvent[] = [];
    const parentToolUseId = raw.parent_tool_use_id ?? null;

    switch (raw.type) {
      case 'stream_event': {
        const e = raw.event;
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
          events.push(this.event('agent.text.delta', { text: e.delta.text, parentToolUseId }));
        }
        break;
      }

      case 'assistant': {
        const content = raw.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            events.push(this.event('agent.text.done', { text: block.text, parentToolUseId }));
          } else if (block.type === 'tool_use') {
            events.push(
              this.event('agent.tool.start', {
                tool: block.name,
                toolUseId: block.id,
                input: block.input,
                parentToolUseId,
              })
            );
          }
        }
        break;
      }

      case 'user': {
        const content = raw.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block.type === 'tool_result') {
            events.push(
              this.event('agent.tool.end', {
                toolUseId: block.tool_use_id,
                output: block.content,
                isError: block.is_error || false,
                parentToolUseId,
              })
            );
          }
        }
        break;
      }

      case 'result': {
        const u = raw.usage ?? {};
        events.push(
          this.event('usage.updated', {
            inputTokens: u.input_tokens || 0,
            outputTokens: u.output_tokens || 0,
            cacheReadTokens: u.cache_read_input_tokens || 0,
            cacheCreationTokens: u.cache_creation_input_tokens || 0,
            numTurns: raw.num_turns || 0,
            isError: raw.is_error || false,
            subtype: raw.subtype,
          })
        );
        break;
      }
    }

    return events;
  }
}

/** Tokens counted against limits: input + output, never cache reads (PLAN.md 3.3). */
export function countedTokens(usage: { inputTokens: number; outputTokens: number }): number {
  return usage.inputTokens + usage.outputTokens;
}
