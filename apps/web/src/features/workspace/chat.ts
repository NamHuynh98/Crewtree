// SPDX-License-Identifier: Apache-2.0
import type { AgentEvent } from '@crewtree/shared';
import { api } from '@/lib/api';

export interface ToolCall {
  tool: string;
  toolUseId: string;
  input: any;
  output?: any;
  isError?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts?: number;
  /** System notices are translated at render time */
  i18nKey?: string;
  i18nArgs?: Record<string, string>;
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
  /** Optimistic user message not yet confirmed by message.created */
  pending?: boolean;
  messageId?: string;
  /** Waiting for the agent to finish its turn (PLAN.md 4.3) */
  queued?: boolean;
}

let keySeq = 0;
export const nextKey = (prefix = 'msg') => `${prefix}-${++keySeq}`;

export const BUSY_STATUSES = ['running', 'queued', 'waiting_input', 'waiting_children', 'throttled'];

/**
 * Folds one event of an agent into its chat (Supervisor main chat, node chat in the drawer).
 * `history`: replaying persisted events, so queued markers and status notices of the past are skipped.
 */
export function applyChatEvent(prev: ChatMessage[], event: AgentEvent, history = false): ChatMessage[] {
  const p = (event.payload ?? {}) as any;

  if (event.type === 'message.created' && p.role === 'user') {
    const text = p.text ?? '';
    const queued = p.delivery === 'queued' && !history;
    // The server sends the composed text (chips expanded): match the oldest pending message
    const pendingIdx = prev.findIndex((m) => m.pending && m.role === 'user');
    if (pendingIdx >= 0) {
      return prev.map((m, i) =>
        i === pendingIdx ? { ...m, content: text, pending: false, messageId: p.messageId, queued, ts: event.ts } : m
      );
    }
    return [
      ...prev,
      { id: p.messageId ?? nextKey('user'), messageId: p.messageId, role: 'user', content: text, queued, ts: event.ts },
    ];
  }

  if (event.type === 'message.updated') {
    return prev.map((m) => (m.messageId === p.messageId ? { ...m, queued: p.delivery === 'queued' } : m));
  }

  if (event.type === 'usage.updated' && p.isError) {
    return [...prev, { id: nextKey('ended'), role: 'system', content: '', i18nKey: 'chat.turnEnded', ts: event.ts }];
  }

  if (event.type === 'agent.status' && p.status === 'error' && !history) {
    return [
      ...prev,
      {
        id: nextKey(),
        role: 'system',
        content: p.error ?? '',
        i18nKey: 'chat.agentError',
        i18nArgs: { error: p.error ?? '' },
        ts: event.ts,
      },
    ];
  }

  // Output of Claude Code's own subagents (Task tool) is not part of this agent's chat
  if (p.parentToolUseId) return prev;
  const last = prev[prev.length - 1];

  switch (event.type) {
    case 'agent.text.delta':
      if (last?.role === 'assistant' && last.isStreaming) {
        return [...prev.slice(0, -1), { ...last, content: last.content + (p.text || '') }];
      }
      return [...prev, { id: nextKey(), role: 'assistant', content: p.text || '', isStreaming: true, ts: event.ts }];
    case 'agent.text.done':
      if (last?.role === 'assistant' && last.isStreaming) {
        return [...prev.slice(0, -1), { ...last, isStreaming: false, content: p.text || last.content }];
      }
      return [...prev, { id: nextKey('done'), role: 'assistant', content: p.text || '', ts: event.ts }];
    case 'agent.tool.start': {
      const call: ToolCall = { tool: p.tool, toolUseId: p.toolUseId, input: p.input };
      if (last?.role === 'assistant')
        return [...prev.slice(0, -1), { ...last, toolCalls: [...(last.toolCalls || []), call] }];
      return [...prev, { id: nextKey(), role: 'assistant', content: '', toolCalls: [call], ts: event.ts }];
    }
    case 'agent.tool.end':
      return prev.map((m) =>
        m.toolCalls?.some((tc) => tc.toolUseId === p.toolUseId)
          ? {
              ...m,
              toolCalls: m.toolCalls.map((tc) =>
                tc.toolUseId === p.toolUseId ? { ...tc, output: p.output, isError: p.isError } : tc
              ),
            }
          : m
      );
    default:
      return prev;
  }
}

/** `mcp__crewtree__delegate_task` → `delegate_task` */
export function crewtreeTool(tool: string): string | null {
  return tool.startsWith('mcp__crewtree__') ? tool.slice('mcp__crewtree__'.length) : null;
}

export function toolOutputText(output: unknown): string {
  if (output === undefined || output === null) return '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map((b: any) => (typeof b === 'string' ? b : (b?.text ?? ''))).join('');
  return JSON.stringify(output, null, 2);
}

/** One-line summary of a tool call for node activity lines and Activity rows. */
export function toolSummary(tool: string, input: any): string {
  const orchestration = crewtreeTool(tool);
  if (orchestration) {
    if (orchestration === 'delegate_task') return String(input?.title ?? '');
    if (orchestration === 'wait_for_tasks') return `${(input?.taskIds ?? []).length || ''} tasks`;
    return input?.title ?? input?.summary ?? input?.question ?? '';
  }
  if (!input || typeof input !== 'object') return '';
  if (tool === 'Bash') return String(input.command ?? '');
  if (input.file_path) return String(input.file_path);
  if (input.pattern) return String(input.pattern);
  if (input.url) return String(input.url);
  if (input.query) return String(input.query);
  if (input.description) return String(input.description);
  return '';
}

/** Event types a chat is built from; the rest (status, files, usage ticks) stay out of chat pages */
export const CHAT_EVENT_TYPES = [
  'message.created',
  'message.updated',
  'usage.updated',
  'agent.text.done',
  'agent.tool.start',
  'agent.tool.end',
];
export const CHAT_PAGE_SIZE = 300;

export interface ChatPage {
  messages: ChatMessage[];
  /** Id of the oldest event in the page: the next page is `before` it */
  cursor?: number;
  hasOlder: boolean;
}

/**
 * One page of an agent's chat history, newest first (a long session no longer loads everything).
 * A page starts at a user message when it can, so a tool call and its result never sit on two pages.
 */
export async function fetchChatPage(
  sessionId: string,
  agentId: string,
  before = Number.MAX_SAFE_INTEGER
): Promise<ChatPage> {
  const events = await api<AgentEvent[]>(
    `/api/sessions/${sessionId}/events?agent=${agentId}&before=${before}&limit=${CHAT_PAGE_SIZE}&types=${CHAT_EVENT_TYPES.join(',')}`
  );
  const hasOlder = events.length === CHAT_PAGE_SIZE;
  let start = 0;
  if (hasOlder) {
    const turn = events.findIndex((e) => e.type === 'message.created' && (e.payload as any)?.role === 'user');
    if (turn > 0) start = turn;
  }
  const page = events.slice(start);
  let messages: ChatMessage[] = [];
  for (const e of page) messages = applyChatEvent(messages, e, true);
  return { messages, cursor: page[0]?.id, hasOlder };
}
