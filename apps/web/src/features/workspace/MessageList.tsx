// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import { CheckCircle2, ChevronRight, Loader2, Wrench, XCircle } from 'lucide-react';
import type { SessionAgent } from '@crewtree/shared';
import { Markdown } from '@/components/Markdown';
import { UserMessageText } from '@/features/composer/MessageText';
import { crewtreeTool, toolOutputText, toolSummary, type ChatMessage, type ToolCall } from './chat';

function findAgent(agents: SessionAgent[], ref: unknown): SessionAgent | undefined {
  if (typeof ref !== 'string') return undefined;
  return agents.find((a) => a.id === ref || a.alias === ref || a.agentName === ref);
}

/** Orchestration calls as compact chips (`▸ delegated to analyst`); click focuses that node. */
function OrchestrationChip({
  call,
  agents,
  onFocusAgent,
}: {
  call: ToolCall;
  agents: SessionAgent[];
  onFocusAgent?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const name = crewtreeTool(call.tool)!;
  const target = findAgent(agents, call.input?.agentId ?? call.input?.agentName ?? call.input?.alias);
  const targetName = target ? target.alias || target.agentName : (call.input?.agentId ?? call.input?.agentName ?? '');
  const label =
    name === 'delegate_task'
      ? t('chat.delegatedTo', { name: targetName, title: call.input?.title ?? '' })
      : name === 'spawn_agent'
        ? t('chat.spawned', { name: call.input?.alias ?? call.input?.agentName ?? '' })
        : name === 'wait_for_tasks'
          ? call.interrupted
            ? t('chat.waitInterrupted')
            : call.output === undefined
              ? t('chat.waitingResults')
              : t('chat.resultsReceived')
          : name === 'answer_child' || name === 'message_agent'
            ? t('chat.messaged', { name: targetName })
            : name === 'complete_task'
              ? t('chat.completed')
              : name === 'ask_parent'
                ? t('chat.askedParent')
                : name;
  const output = toolOutputText(call.output);
  return (
    <details className="group text-[11px]">
      <summary
        className="flex cursor-pointer list-none items-center gap-1 text-primary hover:underline"
        onClick={(e) => {
          if (target && onFocusAgent) {
            e.preventDefault();
            onFocusAgent(target.id);
          }
        }}
      >
        {name === 'wait_for_tasks' && call.output === undefined && !call.interrupted ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : call.isError || call.interrupted ? (
          <XCircle className="h-3 w-3 text-red-500" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span className="truncate">{label}</span>
      </summary>
      {output && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/5 p-1.5 font-mono text-[10px] dark:bg-white/5">
          {output}
        </pre>
      )}
    </details>
  );
}

function ToolChip({ call, onOpenFile }: { call: ToolCall; onOpenFile?: (path: string) => void }) {
  const { t } = useTranslation();
  const summary = toolSummary(call.tool, call.input);
  const filePath = typeof call.input?.file_path === 'string' ? (call.input.file_path as string) : undefined;
  return (
    <details
      className={`rounded-md border px-2 py-1 font-mono text-[11px] ${
        call.isError || call.interrupted
          ? 'border-red-200 bg-red-50 text-red-600 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400'
          : call.output !== undefined
            ? 'border-border bg-black/[0.03] dark:bg-white/[0.03]'
            : 'border-border bg-black/5 text-muted-foreground dark:bg-white/5'
      }`}
    >
      <summary className="flex cursor-pointer select-none list-none items-center gap-1.5">
        {call.isError || call.interrupted ? (
          <XCircle className="h-3 w-3 shrink-0 text-red-400" />
        ) : call.output !== undefined ? (
          <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
        ) : (
          <Wrench className="h-3 w-3 shrink-0 animate-pulse text-primary" />
        )}
        <span className="font-semibold">{call.tool}</span>
        {filePath && onOpenFile ? (
          <button
            type="button"
            className="truncate text-left text-primary hover:underline"
            onClick={(e) => {
              e.preventDefault();
              onOpenFile(filePath);
            }}
          >
            {summary}
          </button>
        ) : (
          <span className="truncate text-muted-foreground">{summary}</span>
        )}
        <span className="ml-auto shrink-0 text-[10px] opacity-60">{t('chat.toolDetails')}</span>
      </summary>
      <div className="mt-1.5 space-y-1 border-t border-black/10 pt-1.5 text-[10px] dark:border-white/10">
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap">{JSON.stringify(call.input, null, 2)}</pre>
        {call.output !== undefined && (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap border-t border-black/5 pt-1 dark:border-white/5">
            {toolOutputText(call.output)}
          </pre>
        )}
      </div>
    </details>
  );
}

export interface ExtraEntry {
  id: string;
  ts: number;
  /** e.g. a task from the parent, shown as a message from that agent */
  from: string;
  content: string;
}

/** Chat transcript of an agent: user/parent messages, markdown answers, tool chips (UI-WIREFRAMES 2, 4). */
export function MessageList({
  messages,
  agents,
  agentName,
  extra = [],
  onFocusAgent,
  onOpenFile,
  onInterrupt,
}: {
  messages: ChatMessage[];
  agents: SessionAgent[];
  agentName: string;
  extra?: ExtraEntry[];
  onFocusAgent?: (id: string) => void;
  onOpenFile?: (path: string) => void;
  onInterrupt?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const time = (ts?: number) =>
    ts ? new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' }).format(new Date(ts)) : '';

  // Interleave task messages from the parent by time; messages without a time keep their order
  const rows: Array<{ kind: 'msg'; m: ChatMessage } | { kind: 'extra'; e: ExtraEntry }> = [];
  const pending = [...extra].sort((a, b) => a.ts - b.ts);
  for (const m of messages) {
    while (pending.length && m.ts && pending[0].ts <= m.ts) rows.push({ kind: 'extra', e: pending.shift()! });
    rows.push({ kind: 'msg', m });
  }
  for (const e of pending) rows.push({ kind: 'extra', e });

  return (
    <div className="space-y-3">
      {rows.map((row) => {
        if (row.kind === 'extra') {
          return (
            <div key={row.e.id} className="flex flex-col items-start">
              <div className="mb-0.5 text-[10px] text-muted-foreground">
                {t('chat.fromParent', { name: row.e.from })} · {time(row.e.ts)}
              </div>
              <div className="max-w-[90%] whitespace-pre-wrap rounded-lg border border-dashed border-border bg-card px-3 py-2 text-xs">
                {row.e.content}
              </div>
            </div>
          );
        }
        const m = row.m;
        if (m.role === 'system') {
          return (
            <div key={m.id} className="text-center text-[11px] italic text-muted-foreground">
              {m.i18nKey ? t(m.i18nKey, m.i18nArgs) : m.content}
            </div>
          );
        }
        const orchestration = (m.toolCalls ?? []).filter((c) => crewtreeTool(c.tool));
        const tools = (m.toolCalls ?? []).filter((c) => !crewtreeTool(c.tool));
        return (
          <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
            <div className="mb-0.5 text-[10px] text-muted-foreground">
              {m.role === 'user' ? t('chat.you') : agentName} {time(m.ts)}
            </div>
            <div
              className={`max-w-[92%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
                m.role === 'user'
                  ? 'rounded-br-sm bg-primary text-primary-foreground'
                  : 'rounded-bl-sm border border-border bg-muted text-foreground'
              } ${m.pending ? 'opacity-70' : ''}`}
            >
              {m.content &&
                (m.role === 'assistant' ? <Markdown>{m.content}</Markdown> : <UserMessageText text={m.content} />)}
              {m.isStreaming && (
                <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-primary" />
              )}
              {m.queued && (
                <div className="mt-1 flex items-center gap-2 text-[10px] uppercase tracking-wider opacity-80">
                  {t('chat.queued')}
                  {onInterrupt && (
                    <button
                      type="button"
                      className="rounded border border-current px-1.5 py-px normal-case tracking-normal"
                      onClick={onInterrupt}
                    >
                      {t('chat.interruptAndSendNow')}
                    </button>
                  )}
                </div>
              )}
              {orchestration.length > 0 && (
                <div className={`space-y-0.5 ${m.content ? 'mt-2' : ''}`}>
                  {orchestration.map((c) => (
                    <OrchestrationChip key={c.toolUseId} call={c} agents={agents} onFocusAgent={onFocusAgent} />
                  ))}
                </div>
              )}
              {tools.length > 0 && (
                <div className={`space-y-1 ${m.content || orchestration.length ? 'mt-2' : ''}`}>
                  {tools.map((c) => (
                    <ToolChip key={c.toolUseId} call={c} onOpenFile={onOpenFile} />
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
