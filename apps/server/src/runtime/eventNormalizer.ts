// SPDX-License-Identifier: Apache-2.0
import { AgentEvent } from '@crewtree/shared';

export interface NormalizerContext {
  sessionId: string;
  sessionAgentId: string;
}

export class EventNormalizer {
  private accumulatedText = '';

  constructor(private ctx: NormalizerContext) {}

  public normalize(rawMessage: any): AgentEvent[] {
    const events: AgentEvent[] = [];
    const now = Date.now();

    if (!rawMessage || typeof rawMessage !== 'object') {
      return events;
    }

    // Assistant messages (contain text blocks, tool_use blocks, usage)
    if (rawMessage.type === 'assistant' && rawMessage.message) {
      const content = rawMessage.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            this.accumulatedText += block.text;
            events.push({
              sessionId: this.ctx.sessionId,
              sessionAgentId: this.ctx.sessionAgentId,
              type: 'agent.text.delta',
              payload: { text: block.text },
              ts: now,
            });
          } else if (block.type === 'tool_use') {
            events.push({
              sessionId: this.ctx.sessionId,
              sessionAgentId: this.ctx.sessionAgentId,
              type: 'agent.tool.start',
              payload: {
                tool: block.name,
                toolUseId: block.id,
                input: block.input,
              },
              ts: now,
            });
          }
        }
      }

      // Usage update
      if (rawMessage.message.usage) {
        const u = rawMessage.message.usage;
        events.push({
          sessionId: this.ctx.sessionId,
          sessionAgentId: this.ctx.sessionAgentId,
          type: 'usage.updated',
          payload: {
            inputTokens: u.input_tokens || 0,
            outputTokens: u.output_tokens || 0,
            cacheReadTokens: u.cache_read_input_tokens || 0,
            cacheCreationTokens: u.cache_creation_input_tokens || 0,
          },
          ts: now,
        });
      }
    }

    // User message containing tool results
    if (rawMessage.type === 'user' && rawMessage.message?.content) {
      const content = rawMessage.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            events.push({
              sessionId: this.ctx.sessionId,
              sessionAgentId: this.ctx.sessionAgentId,
              type: 'agent.tool.end',
              payload: {
                toolUseId: block.tool_use_id,
                output: block.content,
                isError: block.is_error || false,
              },
              ts: now,
            });
          }
        }
      }
    }

    // Rate limit events from the SDK
    if (rawMessage.type === 'rate_limit_event') {
      const retryAfterMs = (rawMessage.retry_after_seconds || 60) * 1000;
      events.push({
        sessionId: this.ctx.sessionId,
        sessionAgentId: this.ctx.sessionAgentId,
        type: 'agent.status',
        payload: { status: 'throttled', retryAfterMs },
        ts: now,
      });
    }

    // System message: contains session_id
    if (rawMessage.type === 'system' && rawMessage.session_id) {
      events.push({
        sessionId: this.ctx.sessionId,
        sessionAgentId: this.ctx.sessionAgentId,
        type: 'agent.status',
        payload: { status: 'running', sdkSessionId: rawMessage.session_id },
        ts: now,
      });
    }

    return events;
  }

  public flushTextDone(): AgentEvent | null {
    if (!this.accumulatedText) return null;
    const finalEvent: AgentEvent = {
      sessionId: this.ctx.sessionId,
      sessionAgentId: this.ctx.sessionAgentId,
      type: 'agent.text.done',
      payload: { text: this.accumulatedText },
      ts: Date.now(),
    };
    this.accumulatedText = '';
    return finalEvent;
  }
}
