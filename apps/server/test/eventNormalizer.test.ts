// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { EventNormalizer, countedTokens } from '../src/runtime/eventNormalizer.js';

const normalizer = new EventNormalizer({ sessionId: 's1', sessionAgentId: 'a1' });

describe('EventNormalizer', () => {
  it('maps stream_event text deltas to agent.text.delta', () => {
    const [evt] = normalizer.normalize({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
    });
    expect(evt).toMatchObject({
      type: 'agent.text.delta',
      sessionId: 's1',
      sessionAgentId: 'a1',
      payload: { text: 'Hi' },
    });
  });

  it('ignores non-text stream events', () => {
    expect(
      normalizer.normalize({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta' } },
      })
    ).toEqual([]);
  });

  it('maps completed assistant blocks to text.done and tool.start', () => {
    const events = normalizer.normalize({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Reading file' },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.ts' } },
        ],
      },
    });
    expect(events.map((e) => e.type)).toEqual(['agent.text.done', 'agent.tool.start']);
    expect(events[1].payload).toMatchObject({ tool: 'Read', toolUseId: 'tu1' });
  });

  it('maps tool results to agent.tool.end', () => {
    const [evt] = normalizer.normalize({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok', is_error: true }] },
    });
    expect(evt).toMatchObject({ type: 'agent.tool.end', payload: { toolUseId: 'tu1', output: 'ok', isError: true } });
  });

  it('emits final turn usage from the result message only', () => {
    const [evt] = normalizer.normalize({
      type: 'result',
      subtype: 'success',
      num_turns: 2,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 3 },
    });
    expect(evt.type).toBe('usage.updated');
    expect(evt.payload).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 1000, numTurns: 2 });
    expect(countedTokens(evt.payload as any)).toBe(15);
  });

  it('leaves status signals (rate limits, init) to AgentRuntime', () => {
    expect(normalizer.normalize({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } })).toEqual([]);
    expect(normalizer.normalize({ type: 'system', subtype: 'init', session_id: 'x' })).toEqual([]);
  });
});
