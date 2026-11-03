// SPDX-License-Identifier: Apache-2.0
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { toUserContent } from '../uploads/composeMessage.js';

export interface GenerateRequest {
  systemPrompt: string;
  /** May contain attachment markers; images/PDFs are sent as content blocks */
  prompt: string;
  model?: string;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

/** One model call without tools (PLAN.md 6.4). Swappable so tests and FakeDriver mode run offline. */
export interface TextGenerator {
  generate(req: GenerateRequest): Promise<string>;
}

async function* single(content: string): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: toUserContent(content) },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

export class SdkTextGenerator implements TextGenerator {
  async generate(req: GenerateRequest): Promise<string> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    req.signal?.addEventListener('abort', onAbort);
    const q = query({
      prompt: single(req.prompt),
      options: {
        systemPrompt: req.systemPrompt,
        model: req.model,
        tools: [],
        settingSources: [],
        maxTurns: 1,
        includePartialMessages: true,
        abortController,
      },
    });
    let streamed = '';
    try {
      for await (const msg of q as AsyncIterable<any>) {
        if (msg.type === 'stream_event') {
          const e = msg.event;
          if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
            streamed += e.delta.text;
            req.onDelta?.(e.delta.text);
          }
        } else if (msg.type === 'result') {
          if (msg.is_error || msg.subtype !== 'success') {
            throw new Error(msg.result || (msg.errors ?? []).join('; ') || `Generation failed (${msg.subtype})`);
          }
          return typeof msg.result === 'string' && msg.result ? msg.result : streamed;
        }
      }
      if (req.signal?.aborted) throw new Error('Generation cancelled');
      return streamed;
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
      q.close();
    }
  }
}

/** Offline generator (CREWTREE_DRIVER=fake and tests): streams a canned answer built by `respond`. */
export class FakeTextGenerator implements TextGenerator {
  constructor(private respond: (req: GenerateRequest) => string) {}

  async generate(req: GenerateRequest): Promise<string> {
    const text = this.respond(req);
    for (let i = 0; i < text.length; i += 40) {
      if (req.signal?.aborted) throw new Error('Generation cancelled');
      req.onDelta?.(text.slice(i, i + 40));
      await new Promise((r) => setTimeout(r, 5));
    }
    return text;
  }
}
