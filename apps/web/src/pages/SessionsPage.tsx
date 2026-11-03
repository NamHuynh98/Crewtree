// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useShell } from '@/app/shell';
import { shortenPath } from '@/lib/paths';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  ShieldAlert,
  Plus,
  Play,
  ArrowLeft,
  Send,
  Loader2,
  Wrench,
  Coins,
  CheckCircle2,
  XCircle,
  Code2,
  Square,
  Pause,
} from 'lucide-react';
import type { Approval, Session, SessionAgent, AgentEvent, Task } from '@crewtree/shared';
import { StatusBadge, StatusDot, sessionVisual } from '@/components/StatusBadge';
import { Markdown } from '@/components/Markdown';
import { AgentTree } from '@/components/workspace/AgentTree';
import { TaskList } from '@/components/workspace/TaskList';
import { ApprovalList, ApprovalDecisionInput } from '@/components/workspace/ApprovalList';
import { Button } from '@/components/ui/button';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** System notices are translated at render time */
  i18nKey?: string;
  i18nArgs?: Record<string, string>;
  toolCalls?: Array<{ tool: string; toolUseId: string; input: any; output?: any; isError?: boolean }>;
  isStreaming?: boolean;
  /** Optimistic user message not yet confirmed by message.created */
  pending?: boolean;
  messageId?: string;
  /** Waiting for the agent to finish its turn (PLAN.md 4.3) */
  queued?: boolean;
}

interface LibraryAgentInfo {
  name: string;
  scope: string;
  description: string;
  canDelegate: boolean;
}

type SessionListItem = Session & { activity?: 'running' | 'idle' };

const BUSY_STATUSES = ['running', 'queued', 'waiting_input', 'waiting_children', 'throttled'];

interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

// Unique React keys for chat messages (several can be created in the same millisecond during replay)
let keySeq = 0;
const nextKey = (prefix = 'msg') => `${prefix}-${++keySeq}`;

export function SessionsPage() {
  const { t, i18n } = useTranslation();
  const { project, refreshApprovals: loadPendingApprovals } = useShell();
  const navigate = useNavigate();

  // Sessions & Selection
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const selectedSessionId = useParams().id ?? null;
  const setSelectedSessionId = (id: string | null) => navigate(id ? `/sessions/${id}` : '/');
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [agents, setAgents] = useState<SessionAgent[]>([]);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [newSessionTitle, setNewSessionTitle] = useState('');

  // Chat & Realtime State
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [throttledRetryMs, setThrottledRetryMs] = useState<number | null>(null);
  const [usageStats, setUsageStats] = useState<UsageStats>({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
  const [showRawEventLog, setShowRawEventLog] = useState(false);
  const [rawEvents, setRawEvents] = useState<AgentEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  // Last persisted event id per session, used to replay missed events on reconnect
  const lastEventIdsRef = useRef<Record<string, number>>({});
  // Phase 2: the tree, its tasks and approvals
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sessionApprovals, setSessionApprovals] = useState<Approval[]>([]);
  const [library, setLibrary] = useState<LibraryAgentInfo[]>([]);
  const [addAgentName, setAddAgentName] = useState('');
  const [addAgentParent, setAddAgentParent] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const supervisorIdRef = useRef<string | undefined>(undefined);
  const sessionTitleRef = useRef<string>('');

  // Load server health & sessions
  const loadSessions = () => {
    fetch('/api/sessions')
      .then((res) => {
        setAuthRequired(res.status === 401);
        return res.json();
      })
      .then((data) => setSessions(Array.isArray(data) ? data : []))
      .catch((err) => console.error('Failed to load sessions', err));
  };

  useEffect(() => {
    loadSessions();
  }, []);

  // Tree, tasks, approvals and session state: events of every agent (live only; history comes from the API)
  const handleTreeEvent = useCallback(
    (event: AgentEvent) => {
      const p = event.payload as any;
      switch (event.type) {
        case 'agent.status':
          setAgents((prev) => prev.map((a) => (a.id === event.sessionAgentId ? { ...a, status: p.status } : a)));
          break;
        case 'agent.spawned':
          setAgents((prev) => (prev.some((a) => a.id === p.agent.id) ? prev : [...prev, p.agent]));
          break;
        case 'agent.removed':
          setAgents((prev) => prev.filter((a) => a.id !== p.agentId));
          break;
        case 'task.created':
        case 'task.updated':
          setTasks((prev) =>
            prev.some((x) => x.id === p.id) ? prev.map((x) => (x.id === p.id ? p : x)) : [...prev, p]
          );
          break;
        case 'approval.created':
          setSessionApprovals((prev) => (prev.some((a) => a.id === p.id) ? prev : [...prev, p]));
          loadPendingApprovals();
          // Browser notification when the user is not looking (PLAN.md 10)
          if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            const agent = agentsRef.current.find((a) => a.id === p.sessionAgentId);
            new Notification(t('approvals.notificationTitle', { agent: agent?.alias || agent?.agentName || '' }), {
              body: t('approvals.notificationBody', { tool: p.tool, session: sessionTitleRef.current }),
            });
          }
          break;
        case 'approval.resolved':
          setSessionApprovals((prev) => prev.filter((a) => a.id !== p.id));
          loadPendingApprovals();
          break;
        case 'session.status':
          setCurrentSession((prev) => (prev ? { ...prev, status: p.status } : prev));
          break;
        case 'usage.updated':
          // Session total: every agent's turns (input + output, no cache reads)
          setUsageStats((prev) => ({
            inputTokens: prev.inputTokens + (p.inputTokens || 0),
            outputTokens: prev.outputTokens + (p.outputTokens || 0),
            cacheReadTokens: prev.cacheReadTokens + (p.cacheReadTokens || 0),
            cacheCreationTokens: prev.cacheCreationTokens + (p.cacheCreationTokens || 0),
          }));
          break;
        case 'message.updated':
          setMessages((prev) =>
            prev.map((m) => (m.messageId === p.messageId ? { ...m, queued: p.delivery === 'queued' } : m))
          );
          break;
      }
    },
    [loadPendingApprovals, t]
  );

  // Main chat: the Supervisor's own events
  // `history`: replaying persisted events — status and usage are already reflected in the loaded session
  const handleAgentEvent = useCallback((event: AgentEvent, opts: { history?: boolean } = {}) => {
    if (opts.history && event.type === 'agent.status') return;

    if (event.type === 'message.created' && event.payload?.role === 'user') {
      const text = event.payload.text ?? '';
      const messageId = event.payload.messageId as string | undefined;
      const queued = event.payload.delivery === 'queued' && !opts.history;
      setMessages((prev) => {
        const pendingIdx = prev.findIndex((m) => m.pending && m.role === 'user' && m.content === text);
        if (pendingIdx >= 0) {
          return prev.map((m, i) => (i === pendingIdx ? { ...m, pending: false, messageId, queued } : m));
        }
        return [...prev, { id: messageId ?? nextKey('user'), messageId, role: 'user', content: text, queued }];
      });
      return;
    }

    if (event.type === 'usage.updated' && event.payload?.isError) {
      setMessages((prev) => [
        ...prev,
        { id: nextKey('ended'), role: 'system', content: '', i18nKey: 'chat.turnEnded' },
      ]);
    }

    if (event.type === 'agent.status') {
      const status = event.payload?.status;
      setIsStreaming(BUSY_STATUSES.includes(status));
      setThrottledRetryMs(status === 'throttled' ? (event.payload?.retryAfterMs ?? 60000) : null);
      if (status === 'error') {
        setMessages((prev) => [
          ...prev,
          {
            id: nextKey(),
            role: 'system',
            content: event.payload?.error ?? '',
            i18nKey: 'chat.agentError',
            i18nArgs: { error: event.payload?.error ?? '' },
          },
        ]);
      }
    }

    // Output of Claude Code's own subagents (Task tool) is not part of this agent's chat
    if (event.payload?.parentToolUseId) return;

    if (event.type === 'agent.text.delta') {
      const deltaText = event.payload?.text || '';
      setMessages((prev) => {
        const lastMsg = prev[prev.length - 1];
        if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isStreaming) {
          return [...prev.slice(0, -1), { ...lastMsg, content: lastMsg.content + deltaText }];
        } else {
          return [...prev, { id: nextKey(), role: 'assistant', content: deltaText, isStreaming: true }];
        }
      });
    }

    if (event.type === 'agent.text.done') {
      // A text block is complete: finalize the streaming message, or add it if no deltas arrived
      setMessages((prev) => {
        const lastMsg = prev[prev.length - 1];
        if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isStreaming) {
          return [
            ...prev.slice(0, -1),
            { ...lastMsg, isStreaming: false, content: event.payload?.text || lastMsg.content },
          ];
        }
        return [...prev, { id: nextKey('done'), role: 'assistant', content: event.payload?.text || '' }];
      });
    }

    if (event.type === 'agent.tool.start') {
      const { tool, toolUseId, input } = event.payload;
      setMessages((prev) => {
        const lastMsg = prev[prev.length - 1];
        const newTool = { tool, toolUseId, input };
        if (lastMsg && lastMsg.role === 'assistant') {
          return [...prev.slice(0, -1), { ...lastMsg, toolCalls: [...(lastMsg.toolCalls || []), newTool] }];
        } else {
          return [...prev, { id: nextKey(), role: 'assistant', content: '', toolCalls: [newTool] }];
        }
      });
    }

    if (event.type === 'agent.tool.end') {
      const { toolUseId, output, isError } = event.payload;
      setMessages((prev) =>
        prev.map((m) => ({
          ...m,
          toolCalls: m.toolCalls?.map((tc) => (tc.toolUseId === toolUseId ? { ...tc, output, isError } : tc)),
        }))
      );
    }
  }, []);

  const agentsRef = useRef<SessionAgent[]>([]);
  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  // When a session is selected, load its details & connect WS
  useEffect(() => {
    if (!selectedSessionId) {
      setCurrentSession(null);
      setAgents([]);
      setMessages([]);
      setUsageStats({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
      setThrottledRetryMs(null);
      setRawEvents([]);
      setTasks([]);
      setSessionApprovals([]);
      supervisorIdRef.current = undefined;
      return;
    }

    // WebSocket for this session; reconnects with backoff and replays events after lastEventId
    const sessionId = selectedSessionId;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let closedByEffect = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const connect = () => {
      const lastEvt = lastEventIdsRef.current[sessionId];
      const wsUrl = `${protocol}//${window.location.host}/ws?sessionId=${sessionId}${lastEvt ? `&lastEventId=${lastEvt}` : ''}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
      };

      ws.onmessage = (event) => {
        try {
          const agentEvent: AgentEvent = JSON.parse(event.data);
          if (!agentEvent.sessionId) return; // connected / pong
          if (agentEvent.id) lastEventIdsRef.current[sessionId] = agentEvent.id;
          setRawEvents((prev) => [agentEvent, ...prev.slice(0, 49)]);
          handleTreeEvent(agentEvent);
          if (agentEvent.sessionAgentId === supervisorIdRef.current) handleAgentEvent(agentEvent);
        } catch (err) {
          console.error('Failed to parse WS event', err);
        }
      };

      ws.onclose = () => {
        if (closedByEffect) return;
        const delay = Math.min(500 * 2 ** attempt++, 10_000);
        retryTimer = setTimeout(connect, delay);
      };
    };

    // Rebuild the chat (text + tool calls) from persisted events, then go live from the last event id
    (async () => {
      try {
        const [detail, events] = await Promise.all([
          fetch(`/api/sessions/${sessionId}`).then((res) => res.json()),
          fetch(`/api/sessions/${sessionId}/events?after=0&limit=2000`).then((res) => res.json()),
        ]);
        if (closedByEffect) return;
        supervisorIdRef.current = detail.session.supervisorAgentId;
        sessionTitleRef.current = detail.session.title;
        setCurrentSession(detail.session);
        setAgents(detail.agents);
        setTasks(detail.tasks ?? []);
        setSessionApprovals(detail.approvals ?? []);
        setMessages([]);
        setUsageStats({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
        for (const evt of events as AgentEvent[]) {
          if (evt.sessionAgentId !== detail.session.supervisorAgentId) continue;
          handleAgentEvent(evt, { history: true });
          if (evt.id) lastEventIdsRef.current[sessionId] = evt.id;
        }
        const supervisor = (detail.agents as SessionAgent[]).find((a) => a.id === detail.session.supervisorAgentId);
        setIsStreaming(BUSY_STATUSES.includes(supervisor?.status ?? 'idle'));
      } catch (err) {
        console.error('Failed to load session', err);
      }
      if (!closedByEffect) connect();
    })();

    return () => {
      closedByEffect = true;
      if (retryTimer) clearTimeout(retryTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [selectedSessionId, handleAgentEvent, handleTreeEvent]);

  // Library agents for "Add agent"
  useEffect(() => {
    if (!selectedSessionId) return;
    fetch('/api/resources/agents')
      .then((res) => (res.ok ? res.json() : []))
      .then((rows) => setLibrary(Array.isArray(rows) ? rows : []))
      .catch(() => undefined);
  }, [selectedSessionId]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleCreateSession = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSessionTitle.trim()) return;

    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newSessionTitle.trim() }),
      });
      const data = await res.json();
      setNewSessionTitle('');
      setIsCreatingSession(false);
      loadSessions();
      setSelectedSessionId(data.session.id);
    } catch (err) {
      console.error('Failed to create session', err);
    }
  };

  const handleInterrupt = async () => {
    if (!selectedSessionId || !currentSession) return;
    try {
      await fetch(`/api/sessions/${selectedSessionId}/agents/${currentSession.supervisorAgentId}/interrupt`, {
        method: 'POST',
      });
    } catch (err) {
      console.error('Failed to interrupt agent', err);
    }
  };

  /** Messages to a busy Supervisor are queued; `interrupt` stops its turn first (PLAN.md 4.3). */
  const sendMessage = async (mode: 'queue' | 'interrupt') => {
    if (!inputMessage.trim() || !selectedSessionId) return;
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();

    const userText = inputMessage.trim();
    setInputMessage('');
    setActionError(null);
    setMessages((prev) => [...prev, { id: nextKey(), role: 'user', content: userText, pending: true }]);
    try {
      const res = await fetch(`/api/sessions/${selectedSessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: userText, mode }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setActionError(body.error ?? res.statusText);
        setMessages((prev) => prev.filter((m) => !(m.pending && m.content === userText)));
      }
    } catch (err) {
      console.error('Failed to send message', err);
    }
  };

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    void sendMessage('queue');
  };

  const postAction = async (url: string, body?: unknown): Promise<string | null> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return data.error ?? res.statusText;
  };

  const decideApproval = (id: string, decision: ApprovalDecisionInput) => postAction(`/api/approvals/${id}`, decision);

  const sessionAction = async (action: 'pause' | 'resume' | 'stop') => {
    if (!selectedSessionId) return;
    setActionError(await postAction(`/api/sessions/${selectedSessionId}/${action}`));
  };

  const cancelTask = async (task: Task) => {
    if (!selectedSessionId) return;
    setActionError(
      await postAction(`/api/sessions/${selectedSessionId}/tasks/${task.id}/cancel`, {
        reason: 'Cancelled by the user',
      })
    );
  };

  const addAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSessionId || !addAgentName) return;
    const error = await postAction(`/api/sessions/${selectedSessionId}/agents`, {
      agentName: addAgentName,
      parentId: addAgentParent || undefined,
    });
    setActionError(error);
    if (!error) setAddAgentName('');
  };

  const supervisor = agents.find((a) => a.id === currentSession?.supervisorAgentId);
  const supervisorName = supervisor?.alias || supervisor?.agentName || 'Supervisor';
  const workspaceBusy = agents.some((a) => BUSY_STATUSES.includes(a.status ?? 'idle'));
  const rootQuestion = tasks.find((task) => task.isRoot && task.status === 'needs_input');

  return (
    <>
      {!selectedSessionId ? (
        /* SESSIONS LIST VIEW */
        <main className="flex-1 p-6 overflow-y-auto">
          <div className="max-w-4xl mx-auto space-y-6">
            <div className="flex items-center justify-between pb-4 border-b border-border">
              <div>
                <h1 className="text-xl font-bold tracking-tight">{t('sessions')}</h1>
                <p className="text-xs text-muted-foreground mt-0.5">{t('sessionsPage.subtitle')}</p>
              </div>
              <Button size="sm" onClick={() => setIsCreatingSession(true)}>
                <Plus />
                {t('actions.newSession')}
              </Button>
            </div>

            {/* Create session (the full dialog of UI-WIREFRAMES 1 arrives in Phase 5) */}
            {isCreatingSession && (
              <form
                onSubmit={handleCreateSession}
                className="p-4 rounded-lg border border-primary/30 bg-primary/5 space-y-3"
              >
                <h3 className="text-sm font-semibold">{t('sessionsPage.newTitle')}</h3>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder={t('sessionsPage.titlePlaceholder')}
                    value={newSessionTitle}
                    onChange={(e) => setNewSessionTitle(e.target.value)}
                    className="flex-1 px-3 py-1.5 text-xs rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                    autoFocus
                  />
                  <Button type="submit" size="sm">
                    {t('actions.create')}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setIsCreatingSession(false)}>
                    {t('actions.cancel')}
                  </Button>
                </div>
              </form>
            )}

            {authRequired && (
              <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
                <ShieldAlert className="w-4 h-4 shrink-0" />
                <span>{t('auth.notSignedIn')}</span>
              </div>
            )}

            {/* Sessions list */}
            {authRequired ? null : sessions.length === 0 ? (
              <div className="border border-dashed border-border rounded-lg p-10 text-center flex flex-col items-center justify-center bg-card/40">
                <h3 className="text-sm font-semibold">{t('sessionsPage.emptyTitle')}</h3>
                <p className="text-xs text-muted-foreground max-w-sm mt-1">{t('sessionsPage.emptyBody')}</p>
                <Button size="sm" variant="link" className="mt-3" onClick={() => setIsCreatingSession(true)}>
                  <Plus />
                  {t('actions.newSession')}
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {sessions.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => setSelectedSessionId(s.id)}
                    className="p-3.5 rounded-lg border border-border bg-card hover:border-primary/60 cursor-pointer flex items-center justify-between transition shadow-sm"
                  >
                    <div className="flex items-center gap-3">
                      <StatusDot visual={sessionVisual(s.status, s.activity)} />
                      <div>
                        <div className="font-semibold text-sm">{s.title}</div>
                        <div className="text-[11px] text-muted-foreground mt-0.5 font-mono">
                          {shortenPath(s.cwd, project?.homeDir)}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <span>{new Intl.DateTimeFormat(i18n.language).format(new Date(s.updatedAt))}</span>
                      <Button size="sm" variant="outline" className="h-7">
                        {t('actions.open')}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </main>
      ) : (
        /* ACTIVE SESSION WORKSPACE VIEW (dev test page; the canvas layout of UI-WIREFRAMES 2 is Phase 5) */
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Session Workspace Header */}
          <div className="h-11 border-b border-border px-4 flex items-center justify-between bg-card select-none">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setSelectedSessionId(null)}
                className="p-1 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                title={t('workspace.back')}
                aria-label={t('workspace.back')}
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <div className="font-semibold text-sm">{currentSession?.title}</div>
              {currentSession && (
                <StatusBadge
                  visual={sessionVisual(currentSession.status, workspaceBusy ? 'running' : 'idle')}
                  label={workspaceBusy ? t('status.running') : t(`sessionStatus.${currentSession.status}`)}
                />
              )}
              {currentSession && (
                <span className="text-xs text-muted-foreground font-mono">
                  {shortenPath(currentSession.cwd, project?.homeDir)}
                </span>
              )}
            </div>

            <div className="text-xs text-muted-foreground flex items-center gap-3">
              <span>{t('workspace.agentCount', { count: agents.length })}</span>
              <span>·</span>
              <span className="flex items-center gap-1">
                <Coins className="w-3 h-3" />
                {t('workspace.tokens', {
                  count: (currentSession?.totalTokens ?? 0) + usageStats.inputTokens + usageStats.outputTokens,
                })}
              </span>
              {throttledRetryMs !== null && (
                <span className="flex items-center gap-1 text-violet-500 font-medium">
                  <StatusDot visual="throttled" />
                  {t('workspace.rateLimited', { seconds: Math.ceil(throttledRetryMs / 1000) })}
                </span>
              )}
              {currentSession?.status === 'paused' ? (
                <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => sessionAction('resume')}>
                  <Play />
                  {t('session.resume')}
                </Button>
              ) : (
                <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => sessionAction('pause')}>
                  <Pause />
                  {t('session.pause')}
                </Button>
              )}
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => sessionAction('stop')}>
                <Square />
                {t('session.stop')}
              </Button>
              <Button
                size="sm"
                variant={showRawEventLog ? 'secondary' : 'outline'}
                className="h-7 text-[11px]"
                onClick={() => setShowRawEventLog((v) => !v)}
              >
                <Code2 />
                {t('workspace.eventLog')}
              </Button>
            </div>
          </div>

          <div className="flex-1 flex overflow-hidden">
            {/* Agents pane */}
            <div className="w-72 border-r border-border bg-muted/30 p-4 flex flex-col overflow-y-auto">
              <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase mb-3">
                {t('workspace.agentTree')}
              </div>
              <AgentTree agents={agents} tasks={tasks} supervisorId={currentSession?.supervisorAgentId} />

              <form onSubmit={addAgent} className="mt-3 space-y-1.5">
                <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                  {t('tree.addAgent')}
                </div>
                <select
                  value={addAgentName}
                  onChange={(e) => setAddAgentName(e.target.value)}
                  className="w-full px-2 py-1 text-[11px] rounded-md border border-input bg-background"
                  aria-label={t('tree.addAgent')}
                >
                  <option value="">{t('tree.pickAgent')}</option>
                  {library
                    .filter((a) => a.name !== supervisor?.agentName)
                    .map((a) => (
                      <option key={a.name} value={a.name} title={a.description}>
                        {a.name} ({t(`scope.${a.scope}`)})
                      </option>
                    ))}
                </select>
                <div className="flex gap-1.5">
                  <select
                    value={addAgentParent}
                    onChange={(e) => setAddAgentParent(e.target.value)}
                    className="flex-1 min-w-0 px-2 py-1 text-[11px] rounded-md border border-input bg-background"
                    aria-label={t('tree.parent')}
                  >
                    {agents.map((a) => (
                      <option key={a.id} value={a.id === currentSession?.supervisorAgentId ? '' : a.id}>
                        {t('tree.parent')}: {a.alias || a.agentName}
                      </option>
                    ))}
                  </select>
                  <Button type="submit" size="sm" className="h-7 text-[11px]" disabled={!addAgentName}>
                    <Plus />
                  </Button>
                </div>
              </form>

              <div className="mt-4 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase mb-2">
                {t('tasks.title')}
              </div>
              <TaskList tasks={tasks} agents={agents} onCancel={cancelTask} />
            </div>

            {/* Chat & Stream Pane */}
            <div className="flex-1 flex flex-col overflow-hidden bg-background">
              <div className="flex-1 p-4 overflow-y-auto space-y-4">
                {messages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-muted-foreground text-xs">
                    <Bot className="w-8 h-8 mb-2 opacity-50 text-primary" />
                    <p>{t('workspace.emptyChatTitle')}</p>
                    <p className="text-[11px] mt-0.5">{t('workspace.emptyChatBody')}</p>
                  </div>
                ) : (
                  messages.map((m) => (
                    <div
                      key={m.id}
                      className={`flex flex-col ${m.role === 'user' ? 'items-end' : m.role === 'system' ? 'items-center' : 'items-start'}`}
                    >
                      {m.role === 'system' ? (
                        <div className="text-[11px] text-muted-foreground italic py-1">
                          {m.i18nKey ? t(m.i18nKey, m.i18nArgs) : m.content}
                        </div>
                      ) : (
                        <div
                          className={`max-w-[80%] rounded-lg px-4 py-2.5 text-xs leading-relaxed ${
                            m.role === 'user'
                              ? 'bg-primary text-primary-foreground rounded-br-sm'
                              : 'bg-muted text-foreground rounded-bl-sm border border-border'
                          }`}
                        >
                          {m.content &&
                            (m.role === 'assistant' ? (
                              <Markdown>{m.content}</Markdown>
                            ) : (
                              <div className="whitespace-pre-wrap">{m.content}</div>
                            ))}
                          {m.queued && (
                            <div className="mt-1 text-[10px] uppercase tracking-wider opacity-75">
                              {t('chat.queued')}
                            </div>
                          )}
                          {m.isStreaming && (
                            <span className="inline-block w-1.5 h-3.5 bg-primary rounded-sm ml-0.5 animate-pulse" />
                          )}
                          {/* Tool chips */}
                          {m.toolCalls && m.toolCalls.length > 0 && (
                            <div className={`space-y-1 ${m.content ? 'mt-2' : ''}`}>
                              {m.toolCalls.map((tc, idx) => (
                                <details
                                  key={idx}
                                  className={`px-2 py-1.5 rounded-md text-[11px] font-mono border ${
                                    tc.isError
                                      ? 'bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border-red-200 dark:border-red-900/50'
                                      : tc.output !== undefined
                                        ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900/50'
                                        : 'bg-black/5 dark:bg-white/5 text-muted-foreground border-border'
                                  }`}
                                >
                                  <summary className="cursor-pointer select-none flex items-center gap-1.5 list-none">
                                    {tc.isError ? (
                                      <XCircle className="w-3 h-3 text-red-400 shrink-0" />
                                    ) : tc.output !== undefined ? (
                                      <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                                    ) : (
                                      <Wrench className="w-3 h-3 animate-pulse text-primary shrink-0" />
                                    )}
                                    <span className="font-semibold">{tc.tool}</span>
                                    <span className="text-[10px] opacity-60 ml-auto">{t('chat.toolDetails')}</span>
                                  </summary>
                                  <div className="mt-2 pt-1.5 border-t border-black/10 dark:border-white/10 space-y-1 text-[10px]">
                                    {tc.input && (
                                      <div>
                                        <div className="text-[9px] uppercase tracking-wider opacity-60 font-sans font-semibold">
                                          {t('chat.toolInput')}
                                        </div>
                                        <pre className="overflow-x-auto whitespace-pre-wrap max-h-32">
                                          {JSON.stringify(tc.input, null, 2)}
                                        </pre>
                                      </div>
                                    )}
                                    {tc.output !== undefined && (
                                      <div className="mt-1 pt-1 border-t border-black/5 dark:border-white/5">
                                        <div className="text-[9px] uppercase tracking-wider opacity-60 font-sans font-semibold">
                                          {t('chat.toolOutput')}
                                        </div>
                                        <pre className="overflow-x-auto whitespace-pre-wrap max-h-32">
                                          {typeof tc.output === 'string'
                                            ? tc.output
                                            : JSON.stringify(tc.output, null, 2)}
                                        </pre>
                                      </div>
                                    )}
                                  </div>
                                </details>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))
                )}

                {isStreaming && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                    <span>{t('chat.thinking', { name: supervisorName })}</span>
                  </div>
                )}

                <div ref={chatBottomRef} />
              </div>

              {(sessionApprovals.length > 0 || rootQuestion || actionError) && (
                <div className="border-t border-border bg-card/60 p-3 space-y-2 max-h-[45%] overflow-y-auto">
                  {actionError && <p className="text-[11px] text-red-600 dark:text-red-400">{actionError}</p>}
                  {rootQuestion && (
                    <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/20 p-2.5 text-xs">
                      <div className="font-semibold flex items-center gap-1.5">
                        <span className="text-amber-500">⚑</span>
                        {t('session.needsInput')}
                      </div>
                      <p className="mt-1 whitespace-pre-wrap">{rootQuestion.question}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">{t('session.answerHint')}</p>
                    </div>
                  )}
                  {sessionApprovals.length > 0 && (
                    <>
                      <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                        {t('approvals.title')}
                      </div>
                      <ApprovalList approvals={sessionApprovals} agents={agents} onDecide={decideApproval} />
                    </>
                  )}
                </div>
              )}

              {/* Input Bar (the shared Composer of UI-WIREFRAMES 3 arrives in Phase 4) */}
              <form onSubmit={handleSendMessage} className="p-3 border-t border-border bg-card flex items-center gap-2">
                <input
                  type="text"
                  value={inputMessage}
                  onChange={(e) => setInputMessage(e.target.value)}
                  placeholder={t('chat.placeholder', { name: supervisorName })}
                  className="flex-1 px-3 py-2 text-xs rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                />
                <Button
                  type="submit"
                  size="icon"
                  disabled={!inputMessage.trim()}
                  title={t('chat.send')}
                  aria-label={t('chat.send')}
                >
                  <Send />
                </Button>
                {isStreaming && (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-9 text-[11px]"
                      disabled={!inputMessage.trim()}
                      onClick={() => void sendMessage('interrupt')}
                    >
                      {t('chat.interruptAndSend')}
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="destructive"
                      onClick={handleInterrupt}
                      title={t('chat.interrupt')}
                      aria-label={t('chat.interrupt')}
                    >
                      <Square />
                    </Button>
                  </>
                )}
              </form>
            </div>

            {/* Live Event Log Panel (dev only) */}
            {showRawEventLog && (
              <div className="w-80 border-l border-border bg-muted/30 p-3 flex flex-col overflow-hidden text-xs">
                <div className="flex items-center justify-between pb-2 mb-2 border-b border-border">
                  <span className="font-semibold text-[11px] uppercase tracking-wider text-muted-foreground">
                    {t('eventLog.title')}
                  </span>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {t('eventLog.count', { count: rawEvents.length })}
                  </span>
                </div>
                <div className="flex-1 overflow-y-auto space-y-2 font-mono text-[11px]">
                  {rawEvents.length === 0 ? (
                    <div className="text-muted-foreground text-center py-8 text-xs">{t('eventLog.empty')}</div>
                  ) : (
                    rawEvents.map((e, idx) => (
                      <div key={idx} className="p-2 rounded-md bg-card border border-border shadow-xs">
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
                          <span className="text-primary font-semibold">{e.type}</span>
                          <span>{new Date(e.ts).toLocaleTimeString(i18n.language)}</span>
                        </div>
                        <div className="text-muted-foreground text-[10px] break-all max-h-24 overflow-y-auto bg-black/5 dark:bg-black/30 p-1.5 rounded">
                          {JSON.stringify(e.payload)}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
