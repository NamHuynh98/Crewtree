// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Maximize2, Minimize2, Square, X } from 'lucide-react';
import type { AgentEvent, SessionAgent, Task } from '@crewtree/shared';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { StatusBadge, agentStatusKey, agentVisual } from '@/components/StatusBadge';
import { Composer } from '@/features/composer/Composer';
import { ModelPicker } from '@/features/model-picker/ModelPicker';
import { useModelCatalog } from '@/features/model-picker/ModelPicker';
import { modelLabel } from '@/features/model-picker/models';
import { useAgents } from '@/features/resources/useAgents';
import { readAgentFields } from '@/features/resources/agentFile';
import { cn } from '@/lib/utils';
import {
  applyChatEvent,
  BUSY_STATUSES,
  crewtreeTool,
  fetchChatPage,
  toolOutputText,
  toolSummary,
  type ChatMessage,
} from '../chat';
import { ChatScroll } from '../ChatScroll';
import { MessageList, type ExtraEntry } from '../MessageList';
import {
  AGENT_BAR,
  canDelegate,
  effectiveModel,
  formatDuration,
  formatTokens,
  isTerminalTask,
  snapshotFields,
} from '../agentInfo';
import type { Workspace } from '../useWorkspace';
import { ChangeList } from '../files/ChangesTab';
import { relativePath } from '@/lib/paths';

export type DrawerTab = 'activity' | 'chat' | 'tasks' | 'changes' | 'config';

interface Props {
  ws: Workspace;
  agentId: string;
  tab: DrawerTab;
  onTab: (tab: DrawerTab) => void;
  onClose: () => void;
  onOpenFile: (path: string, mode?: 'view' | 'diff') => void;
  onFocusAgent: (id: string) => void;
}

const PAGE = 200;

/** Agent detail drawer (UI-WIREFRAMES 4). */
export function AgentDrawer({ ws, agentId, tab, onTab, onClose, onOpenFile, onFocusAgent }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const agent = ws.agents.find((a) => a.id === agentId);
  const { data: catalog } = useModelCatalog();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('.ProseMirror, input, textarea')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const path = useMemo(() => {
    const chain: SessionAgent[] = [];
    for (let a = agent; a; a = a.parentId ? ws.agents.find((x) => x.id === a!.parentId) : undefined) chain.unshift(a);
    return chain;
  }, [agent, ws.agents]);

  if (!agent) return null;
  const isSupervisor = agent.id === ws.session?.supervisorAgentId;
  const stats = ws.stats[agent.id] ?? { tokens: 0, turns: 0, filesTouched: 0 };
  const busy = BUSY_STATUSES.includes(agent.status ?? 'idle');
  const fields = snapshotFields(agent);
  const name = agent.alias || agent.agentName;

  const tabs: DrawerTab[] = ['activity', 'chat', 'tasks', 'changes', 'config'];
  return (
    <aside
      className={cn(
        'absolute inset-y-0 right-0 z-30 flex flex-col border-l border-border bg-card shadow-xl',
        expanded ? 'left-0' : 'w-[min(560px,100%)]'
      )}
      aria-label={t('drawer.title', { name })}
    >
      <div className="flex items-center gap-1 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        {path.map((a, i) => (
          <span key={a.id} className="flex items-center gap-1">
            {i > 0 && <span>›</span>}
            <button
              type="button"
              className={cn('hover:text-foreground', a.id === agent.id && 'font-semibold text-foreground')}
              onClick={() => onFocusAgent(a.id)}
            >
              {a.alias || a.agentName}
            </button>
          </span>
        ))}
        <span className="ml-auto flex gap-1">
          <button
            type="button"
            className="rounded p-1 hover:bg-accent"
            onClick={() => setExpanded((v) => !v)}
            title={t('drawer.expand')}
          >
            {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          <button type="button" className="rounded p-1 hover:bg-accent" onClick={onClose} title={t('actions.close')}>
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <span className={cn('h-4 w-1 rounded', AGENT_BAR[fields.color ?? ''] ?? 'bg-primary/60')} />
        <span className="text-sm font-semibold">{name}</span>
        <StatusBadge visual={agentVisual(agent.status)} label={t(agentStatusKey(agent.status))} />
        <span className="text-muted-foreground">
          {modelLabel(effectiveModel(agent), catalog)}
          {agent.modelOverride && ' ↺'}
        </span>
        <span className="ml-auto text-muted-foreground">
          {formatTokens(stats.tokens)} tok · {t('node.turns', { count: stats.turns })}
        </span>
        {busy && (
          <Button
            size="icon"
            variant="destructive"
            className="h-6 w-6"
            title={t('chat.interrupt')}
            onClick={() => void ws.interrupt(agent.id)}
          >
            <Square />
          </Button>
        )}
      </div>
      <div className="flex gap-1 border-b border-border px-2 py-1.5">
        {tabs.map((x) => (
          <button
            key={x}
            type="button"
            onClick={() => onTab(x)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs',
              tab === x ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent'
            )}
          >
            {t(`drawer.tabs.${x}`)}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === 'activity' && <ActivityTab ws={ws} agent={agent} onOpenFile={onOpenFile} />}
        {tab === 'chat' && (
          <ChatTab
            ws={ws}
            agent={agent}
            isSupervisor={isSupervisor}
            onFocusAgent={onFocusAgent}
            onOpenFile={onOpenFile}
          />
        )}
        {tab === 'tasks' && <TasksTab ws={ws} agent={agent} />}
        {tab === 'changes' && (
          <div className="flex-1 overflow-y-auto p-3">
            <ChangeList
              sessionId={ws.session!.id}
              agentId={agent.id}
              subscribe={ws.subscribe}
              tasks={ws.tasks}
              onOpen={(p) => onOpenFile(p, 'diff')}
            />
          </div>
        )}
        {tab === 'config' && <ConfigTab ws={ws} agent={agent} isSupervisor={isSupervisor} onClose={onClose} />}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- Activity

interface ActivityRow {
  id: number | string;
  ts: number;
  kind: 'tool' | 'text' | 'error' | 'status' | 'file' | 'permission';
  event: AgentEvent;
  end?: AgentEvent;
}

function toRows(events: AgentEvent[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  const byTool = new Map<string, ActivityRow>();
  for (const e of events) {
    const p = e.payload as any;
    if (p?.parentToolUseId) continue;
    const id = e.id ?? `${e.type}-${e.ts}`;
    switch (e.type) {
      case 'agent.tool.start': {
        const row: ActivityRow = { id, ts: e.ts, kind: 'tool', event: e };
        byTool.set(p.toolUseId, row);
        rows.push(row);
        break;
      }
      case 'agent.tool.end': {
        const row = byTool.get(p.toolUseId);
        if (row) row.end = e;
        break;
      }
      case 'agent.text.done':
        rows.push({ id, ts: e.ts, kind: 'text', event: e });
        break;
      case 'agent.status':
        if (p.status === 'error' || p.status === 'throttled' || p.modelFallback)
          rows.push({ id, ts: e.ts, kind: p.status === 'error' ? 'error' : 'status', event: e });
        break;
      case 'approval.created':
        rows.push({ id, ts: e.ts, kind: 'permission', event: e });
        break;
      case 'file.touched':
        if (p.via === 'Bash') rows.push({ id, ts: e.ts, kind: 'file', event: e });
        break;
      case 'usage.updated':
        if (p.isError) rows.push({ id, ts: e.ts, kind: 'error', event: e });
        break;
    }
  }
  return rows;
}

function EditPreview({ input }: { input: any }) {
  const edits: Array<{ old_string?: string; new_string?: string }> = Array.isArray(input?.edits)
    ? input.edits
    : [input];
  return (
    <div className="mt-1 space-y-1">
      {edits.map((ed, i) => (
        <pre
          key={i}
          className="max-h-48 overflow-auto rounded border border-border bg-background p-1.5 font-mono text-[10px] leading-4"
        >
          {(ed.old_string ?? '')
            .split('\n')
            .filter((l, idx, arr) => l || idx < arr.length - 1)
            .map((l, j) => (
              <div key={`o${j}`} className="bg-red-500/10 text-red-700 dark:text-red-300">
                - {l}
              </div>
            ))}
          {(ed.new_string ?? input?.content ?? '')
            .split('\n')
            .slice(0, 60)
            .map((l: string, j: number) => (
              <div key={`n${j}`} className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                + {l}
              </div>
            ))}
        </pre>
      ))}
    </div>
  );
}

function ActivityTab({
  ws,
  agent,
  onOpenFile,
}: {
  ws: Workspace;
  agent: SessionAgent;
  onOpenFile: (p: string, mode?: 'view' | 'diff') => void;
}) {
  const { t, i18n } = useTranslation();
  const { subscribe } = ws;
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [filter, setFilter] = useState({ text: true, tools: true, errorsOnly: false });
  const [now, setNow] = useState(Date.now());
  const sessionId = ws.session!.id;
  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    let cancelled = false;
    api<AgentEvent[]>(`/api/sessions/${sessionId}/events?agent=${agent.id}&before=999999999999&limit=${PAGE}`)
      .then((rows) => {
        if (cancelled) return;
        setEvents(rows);
        setHasOlder(rows.length === PAGE);
      })
      .catch(() => undefined);
    const off = subscribe((e) => {
      if (e.sessionAgentId === agent.id && e.type !== 'agent.text.delta') setEvents((prev) => [...prev, e]);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [sessionId, agent.id, subscribe]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView();
  }, [events]);

  const loadOlder = async () => {
    const first = events.find((e) => e.id)?.id;
    if (!first) return;
    const older = await api<AgentEvent[]>(
      `/api/sessions/${sessionId}/events?agent=${agent.id}&before=${first}&limit=${PAGE}`
    );
    stick.current = false;
    setEvents((prev) => [...older, ...prev]);
    setHasOlder(older.length === PAGE);
  };

  const rows = toRows(events).filter((r) => {
    if (filter.errorsOnly) return r.kind === 'error' || (r.kind === 'tool' && (r.end?.payload as any)?.isError);
    if (r.kind === 'text') return filter.text;
    if (r.kind === 'tool' || r.kind === 'file') return filter.tools;
    return true;
  });
  const time = (ts: number) =>
    new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' }).format(new Date(ts));

  return (
    <>
      <div
        className="flex-1 space-y-1 overflow-y-auto p-3 text-xs"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {hasOlder && (
          <button
            type="button"
            className="mb-2 text-[11px] text-primary hover:underline"
            onClick={() => void loadOlder()}
          >
            {t('drawer.loadOlder')}
          </button>
        )}
        {rows.length === 0 && <p className="text-muted-foreground">{t('drawer.noActivity')}</p>}
        {rows.map((r) => {
          const p = r.event.payload as any;
          if (r.kind === 'text')
            return (
              <div key={r.id} className="flex gap-2">
                <span className="w-14 shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">{time(r.ts)}</span>
                <span className="line-clamp-3 italic text-muted-foreground">“{p.text}”</span>
              </div>
            );
          if (r.kind === 'tool') {
            const endP = r.end?.payload as any;
            const isEdit = ['Edit', 'MultiEdit', 'Write'].includes(p.tool);
            const filePath =
              typeof p.input?.file_path === 'string' ? relativePath(ws.session!.cwd, p.input.file_path) : undefined;
            const orchestration = crewtreeTool(p.tool);
            return (
              <details key={r.id} className="group">
                <summary className="flex cursor-pointer list-none items-center gap-2">
                  <span className="w-14 shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">
                    {time(r.ts)}
                  </span>
                  <span
                    className={cn(
                      'shrink-0',
                      !r.end ? 'animate-spin text-primary' : endP?.isError ? 'text-red-500' : 'text-muted-foreground'
                    )}
                  >
                    {!r.end ? '⟳' : endP?.isError ? '✕' : '▸'}
                  </span>
                  <span className="shrink-0 font-medium">{orchestration ? `⚙ ${orchestration}` : p.tool}</span>
                  {filePath ? (
                    <button
                      type="button"
                      className="truncate font-mono text-[11px] text-primary hover:underline"
                      onClick={(e) => {
                        e.preventDefault();
                        onOpenFile(filePath, isEdit ? 'diff' : 'view');
                      }}
                    >
                      {filePath}
                    </button>
                  ) : (
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                      {toolSummary(p.tool, p.input)}
                    </span>
                  )}
                  {!r.end && (
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                      {t('drawer.runningFor', { time: formatDuration(now - r.ts) })}
                    </span>
                  )}
                </summary>
                <div className="ml-16 mt-1">
                  {isEdit ? (
                    <EditPreview input={p.input} />
                  ) : (
                    <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted p-1.5 font-mono text-[10px]">
                      {JSON.stringify(p.input, null, 2)}
                    </pre>
                  )}
                  {r.end && (
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-1.5 font-mono text-[10px]">
                      {toolOutputText(endP?.output).slice(0, 4000)}
                    </pre>
                  )}
                </div>
              </details>
            );
          }
          if (r.kind === 'file')
            return (
              <div key={r.id} className="flex gap-2">
                <span className="w-14 shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">{time(r.ts)}</span>
                <span>
                  ✎{' '}
                  <button
                    type="button"
                    className="font-mono text-primary hover:underline"
                    onClick={() => onOpenFile(p.path, 'diff')}
                  >
                    {p.path}
                  </button>{' '}
                  <span className="text-muted-foreground">{t('changes.viaBash')}</span>
                </span>
              </div>
            );
          if (r.kind === 'permission')
            return (
              <div key={r.id} className="flex gap-2 text-amber-700 dark:text-amber-400">
                <span className="w-14 shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">{time(r.ts)}</span>
                <span>⚑ {t('node.needsApproval', { tool: p.tool })}</span>
              </div>
            );
          return (
            <div
              key={r.id}
              className={cn(
                'flex gap-2',
                r.kind === 'error' ? 'text-red-600 dark:text-red-400' : 'text-violet-600 dark:text-violet-300'
              )}
            >
              <span className="w-14 shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">{time(r.ts)}</span>
              <span>
                ⚠{' '}
                {p.modelFallback
                  ? t('drawer.modelFallback', { from: p.modelFallback.from, to: p.modelFallback.to })
                  : (p.error ??
                    (p.status === 'throttled' ? t('drawer.throttled') : (p.subtype ?? t('chat.turnEnded'))))}
              </span>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-1.5 text-[11px]">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={filter.text}
            onChange={(e) => setFilter((f) => ({ ...f, text: e.target.checked }))}
          />
          {t('drawer.filterText')}
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={filter.tools}
            onChange={(e) => setFilter((f) => ({ ...f, tools: e.target.checked }))}
          />
          {t('drawer.filterTools')}
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={filter.errorsOnly}
            onChange={(e) => setFilter((f) => ({ ...f, errorsOnly: e.target.checked }))}
          />
          {t('drawer.errorsOnly')}
        </label>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Chat

function ChatTab({
  ws,
  agent,
  isSupervisor,
  onFocusAgent,
  onOpenFile,
}: {
  ws: Workspace;
  agent: SessionAgent;
  isSupervisor: boolean;
  onFocusAgent: (id: string) => void;
  onOpenFile: (p: string, mode?: 'view' | 'diff') => void;
}) {
  const { t } = useTranslation();
  const { subscribe } = ws;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const cursor = useRef<number | undefined>(undefined);
  const sessionId = ws.session!.id;

  useEffect(() => {
    if (isSupervisor) return;
    let cancelled = false;
    setMessages([]);
    setHasOlder(false);
    fetchChatPage(sessionId, agent.id)
      .then((page) => {
        if (cancelled) return;
        cursor.current = page.cursor;
        setHasOlder(page.hasOlder);
        // Live events that arrived while loading stay after the history
        setMessages((live) => [...page.messages, ...live]);
      })
      .catch(() => undefined);
    const off = subscribe((e) => {
      // message.updated (queued → delivered) carries no agent id; it only matches this chat's message ids
      if (e.sessionAgentId === agent.id || e.type === 'message.updated') setMessages((prev) => applyChatEvent(prev, e));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [sessionId, agent.id, isSupervisor, subscribe]);

  const shown = isSupervisor ? ws.chat : messages;
  const shownHasOlder = isSupervisor ? ws.chatHasOlder : hasOlder;
  const loadOlder = async () => {
    if (isSupervisor) return ws.loadOlderChat();
    if (!cursor.current) return;
    const page = await fetchChatPage(sessionId, agent.id, cursor.current);
    cursor.current = page.cursor;
    setHasOlder(page.hasOlder);
    setMessages((prev) => [...page.messages, ...prev]);
  };
  // Older tasks belong with older messages: not shown until that page is loaded
  const oldestShown = shownHasOlder ? (shown.find((m) => m.ts)?.ts ?? 0) : 0;

  // Tasks from the parent read as messages from it (UI-WIREFRAMES 4 Chat)
  const extra: ExtraEntry[] = ws.tasks
    .filter((x) => x.toAgentId === agent.id && x.fromAgentId && x.createdAt >= oldestShown)
    .map((x) => {
      const from = ws.agents.find((a) => a.id === x.fromAgentId);
      return {
        id: `task-${x.id}`,
        ts: x.createdAt,
        from: from ? from.alias || from.agentName : '?',
        content: `${x.title}\n${x.instructions}${x.scope.length ? `\n${t('drawer.scope')}: ${x.scope.join(', ')}` : ''}`,
      };
    });

  const name = agent.alias || agent.agentName;
  const send = useCallback(
    (payload: Parameters<Workspace['sendMessage']>[0]) => ws.sendMessage(payload, agent.id),
    [ws, agent.id]
  );
  return (
    <>
      <ChatScroll
        firstKey={shown[0]?.id}
        lastKey={shown[shown.length - 1]?.id}
        dep={[shown, extra.length]}
        hasOlder={shownHasOlder}
        onLoadOlder={loadOlder}
      >
        <MessageList
          messages={shown}
          agents={ws.agents}
          agentName={name}
          extra={extra}
          onFocusAgent={onFocusAgent}
          onOpenFile={(p) => onOpenFile(p)}
          onInterrupt={() => void ws.interrupt(agent.id)}
        />
      </ChatScroll>
      <div className="border-t border-border p-2">
        <Composer
          ctx={{ sessionId }}
          agents={ws.agents.map((a) => a.alias || a.agentName)}
          target={name}
          placeholder={t('chat.placeholder', { name })}
          busy={BUSY_STATUSES.includes(agent.status ?? 'idle')}
          onStop={() => void ws.interrupt(agent.id)}
          onSend={send}
        />
        {!isSupervisor && <p className="mt-1 text-[10px] text-muted-foreground">{t('drawer.parentNotified')}</p>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Tasks

function TaskRow({ task, ws }: { task: Task; ws: Workspace }) {
  const { t } = useTranslation();
  const [full, setFull] = useState<string | null>(null);
  const from = task.fromAgentId ? ws.agents.find((a) => a.id === task.fromAgentId) : undefined;
  const end = task.endedAt ?? Date.now();
  return (
    <li className="space-y-1 rounded-md border border-border p-2 text-xs">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            task.status === 'done' ? 'text-emerald-500' : isTerminalTask(task) ? 'text-red-500' : 'text-blue-500'
          )}
        >
          {task.status === 'done' ? '✓' : isTerminalTask(task) ? '✕' : '●'}
        </span>
        <span className="font-medium">{task.title}</span>
        <span className="text-muted-foreground">
          {from ? t('drawer.fromAgent', { name: from.alias || from.agentName }) : t('drawer.fromYou')}
        </span>
        {task.startedAt && (
          <span className="ml-auto text-muted-foreground tabular-nums">{formatDuration(end - task.startedAt)}</span>
        )}
      </div>
      {task.scope.length > 0 && (
        <div className="font-mono text-[10px] text-muted-foreground">
          {t('drawer.scope')}: {task.scope.join(', ')}
        </div>
      )}
      {task.question && task.status === 'needs_input' && (
        <div className="text-amber-700 dark:text-amber-400">? {task.question}</div>
      )}
      {task.resultSummary && (
        <div className="text-muted-foreground">
          {t('drawer.result')}: {task.resultSummary}
        </div>
      )}
      {full && (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted p-1.5 text-[10px]">{full}</pre>
      )}
      <div className="flex gap-2">
        {!isTerminalTask(task) && (
          <button
            type="button"
            className="text-[11px] text-red-600 hover:underline"
            onClick={() => void ws.cancelTask(task.id)}
          >
            {t('tasks.cancel')}
          </button>
        )}
        {task.resultDetails && !full && (
          <button
            type="button"
            className="text-[11px] text-primary hover:underline"
            onClick={() => setFull(task.resultDetails ?? '')}
          >
            {t('drawer.showFull')}
          </button>
        )}
      </div>
    </li>
  );
}

function TasksTab({ ws, agent }: { ws: Workspace; agent: SessionAgent }) {
  const { t } = useTranslation();
  const mine = ws.tasks.filter((x) => x.toAgentId === agent.id).sort((a, b) => b.createdAt - a.createdAt);
  return (
    <ul className="flex-1 space-y-2 overflow-y-auto p-3">
      {mine.length === 0 && <li className="text-xs text-muted-foreground">{t('tasks.empty')}</li>}
      {mine.map((x) => (
        <TaskRow key={x.id} task={x} ws={ws} />
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- Config

function ConfigTab({
  ws,
  agent,
  isSupervisor,
  onClose,
}: {
  ws: Workspace;
  agent: SessionAgent;
  isSupervisor: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: library = [] } = useAgents();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { fields, body } = useMemo(() => readAgentFields(agent.snapshot), [agent.snapshot]);
  const libraryItem = library.find((a) => a.name === agent.agentName && a.scope === agent.scope);
  const delegates = canDelegate(agent, isSupervisor);
  const row = 'flex items-center gap-2 py-1';

  return (
    <div className="flex-1 space-y-1 overflow-y-auto p-3 text-xs">
      <div className={row}>
        <span className="w-24 text-muted-foreground">{t('drawer.agent')}</span>
        <span className="font-medium">{agent.agentName}</span>
        <span className="text-muted-foreground">({t(`scope.${agent.scope}`)})</span>
        {libraryItem && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-6 text-[11px]"
            onClick={() => navigate(`/agents/${libraryItem.id}`)}
          >
            {t('drawer.openInEditor')}
          </Button>
        )}
      </div>
      <div className={row}>
        <span className="w-24 shrink-0 text-muted-foreground">{t('editor.model')}</span>
        <div className="min-w-0 flex-1">
          <ModelPicker
            value={effectiveModel(agent)}
            onChange={(model) => void ws.updateAgent(agent.id, { modelOverride: model ?? null })}
          />
        </div>
        {agent.modelOverride && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[11px]"
            onClick={() => void ws.updateAgent(agent.id, { modelOverride: null })}
          >
            {t('drawer.resetOverride')}
          </Button>
        )}
      </div>
      <p className="pl-24 text-[10px] text-muted-foreground">{t('drawer.overrideHint')}</p>
      {!isSupervisor && (
        <div className={row}>
          <span className="w-24 text-muted-foreground">{t('editor.delegation')}</span>
          <span>{delegates ? t('drawer.on') : t('drawer.off')}</span>
          {agent.canDelegateOverride != null && <span className="text-muted-foreground">↺</span>}
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-6 text-[11px]"
            onClick={() =>
              void ws.updateAgent(agent.id, {
                canDelegateOverride: agent.canDelegateOverride != null ? null : !fields.canDelegate,
              })
            }
          >
            {agent.canDelegateOverride != null
              ? t('drawer.resetOverride')
              : delegates
                ? t('drawer.disableForSession')
                : t('drawer.enableForSession')}
          </Button>
        </div>
      )}
      <div className={row}>
        <span className="w-24 shrink-0 text-muted-foreground">{t('editor.tools')}</span>
        <span className="font-mono">{fields.tools ? fields.tools.join(', ') || '—' : t('agentsPage.allTools')}</span>
      </div>
      <div className={row}>
        <span className="w-24 shrink-0 text-muted-foreground">{t('skills')} · MCP</span>
        <span>
          {fields.skills.join(', ') || '—'} · {fields.mcpServers.join(', ') || '—'}
        </span>
      </div>
      <details className="pt-1">
        <summary className="cursor-pointer text-muted-foreground">{t('drawer.systemPrompt')}</summary>
        <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[10px]">
          {body}
        </pre>
      </details>
      {!isSupervisor && (
        <div className="flex justify-end gap-2 pt-3">
          {confirmRemove ? (
            <>
              <span className="self-center text-[11px] text-red-600">{t('drawer.removeConfirm')}</span>
              <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => setConfirmRemove(false)}>
                {t('actions.cancel')}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="h-7 text-[11px]"
                onClick={async () => {
                  if (!(await ws.removeAgent(agent.id))) onClose();
                }}
              >
                {t('drawer.remove')}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px] text-red-600"
              onClick={() => setConfirmRemove(true)}
            >
              {t('drawer.remove')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
