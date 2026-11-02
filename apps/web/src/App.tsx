// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Sparkles,
  Terminal,
  Brain,
  Network,
  Puzzle,
  Settings,
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
} from 'lucide-react';
import { Session, SessionAgent, AgentEvent } from '@crewtree/shared';
import { getBoot, resolveTheme, saveUiSettings, BootSettings, ThemeSetting, LanguageSetting } from './lib/boot';
import { StatusBadge, StatusDot, agentStatusKey, agentVisual, sessionVisual } from '@/components/StatusBadge';
import { Markdown } from '@/components/Markdown';
import { ThemeMenu, LanguageMenu } from '@/components/HeaderMenus';
import { ClaudeStatus, ClaudeStatusInfo } from '@/components/ClaudeStatus';
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
}

type SessionListItem = Session & { activity?: 'running' | 'idle' };

interface ProjectInfo {
  path: string;
  name: string;
  homeDir: string;
}

/** ~/WorkSpace/app instead of /Users/me/WorkSpace/app */
function shortenPath(p: string, homeDir?: string): string {
  return homeDir && (p === homeDir || p.startsWith(homeDir + '/')) ? '~' + p.slice(homeDir.length) : p;
}

const BUSY_STATUSES = ['running', 'waiting_input', 'waiting_children'];

interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

// Unique React keys for chat messages (several can be created in the same millisecond during replay)
let keySeq = 0;
const nextKey = (prefix = 'msg') => `${prefix}-${++keySeq}`;

export function App() {
  const { t, i18n } = useTranslation();
  const [themeSetting, setThemeSetting] = useState<ThemeSetting>(() => getBoot().theme);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => resolveTheme(getBoot().theme));
  // Failed settings save: the UI keeps the new value and offers a retry (PLAN.md 11.1)
  const [saveError, setSaveError] = useState<{ ui: Partial<BootSettings> } | null>(null);
  const [serverOnline, setServerOnline] = useState(true);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatusInfo | null>(null);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState(0);

  // Sessions & Selection
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
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

  const loadPendingApprovals = useCallback(() => {
    fetch('/api/approvals?status=pending')
      .then((res) => (res.ok ? res.json() : []))
      .then((rows) => setPendingApprovals(Array.isArray(rows) ? rows.length : 0))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadSessions();
    loadPendingApprovals();
    fetch('/api/projects')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data && setProject(data.current))
      .catch(() => undefined);

    // Claude Code login / rate-limit state for the sidebar footer
    const loadClaudeStatus = () =>
      fetch('/api/claude/status')
        .then((res) => {
          setServerOnline(true);
          return res.ok ? res.json() : null;
        })
        .then((data) => data && setClaudeStatus(data))
        .catch(() => setServerOnline(false));
    loadClaudeStatus();
    const timer = setInterval(loadClaudeStatus, 60_000);
    return () => clearInterval(timer);
  }, [loadPendingApprovals]);

  // Handle incoming live AgentEvents
  // `history`: replaying persisted events — status and usage are already reflected in the loaded session
  const handleAgentEvent = useCallback(
    (event: AgentEvent, opts: { history?: boolean } = {}) => {
      if (opts.history && event.type === 'agent.status') return;

      if (event.type === 'message.created' && event.payload?.role === 'user') {
        const text = event.payload.text ?? '';
        setMessages((prev) => {
          const pendingIdx = prev.findIndex((m) => m.pending && m.role === 'user' && m.content === text);
          if (pendingIdx >= 0) {
            return prev.map((m, i) => (i === pendingIdx ? { ...m, pending: false } : m));
          }
          return [...prev, { id: event.payload.messageId ?? nextKey('user'), role: 'user', content: text }];
        });
        return;
      }

      if (event.type.startsWith('approval.')) {
        loadPendingApprovals();
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
        setAgents((prev) => prev.map((a) => (a.id === event.sessionAgentId ? { ...a, status } : a)));
        if (status === 'running') {
          setIsStreaming(true);
          setThrottledRetryMs(null);
        }
        if (status === 'idle' || status === 'suspended') {
          setIsStreaming(false);
          setThrottledRetryMs(null);
        }
        if (status === 'throttled') {
          setIsStreaming(false);
          setThrottledRetryMs(event.payload?.retryAfterMs ?? 60000);
        }
        if (status === 'error') {
          setIsStreaming(false);
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

      if (event.type === 'usage.updated' && !opts.history) {
        setUsageStats((prev) => ({
          inputTokens: prev.inputTokens + (event.payload?.inputTokens || 0),
          outputTokens: prev.outputTokens + (event.payload?.outputTokens || 0),
          cacheReadTokens: prev.cacheReadTokens + (event.payload?.cacheReadTokens || 0),
          cacheCreationTokens: prev.cacheCreationTokens + (event.payload?.cacheCreationTokens || 0),
        }));
      }
    },
    [loadPendingApprovals]
  );

  // When a session is selected, load its details & connect WS
  useEffect(() => {
    if (!selectedSessionId) {
      setCurrentSession(null);
      setAgents([]);
      setMessages([]);
      setUsageStats({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
      setThrottledRetryMs(null);
      setRawEvents([]);
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
          handleAgentEvent(agentEvent);
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
        setCurrentSession(detail.session);
        setAgents(detail.agents);
        setMessages([]);
        setUsageStats({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
        for (const evt of events as AgentEvent[]) {
          if (evt.sessionAgentId !== detail.session.supervisorAgentId) continue;
          handleAgentEvent(evt, { history: true });
          if (evt.id) lastEventIdsRef.current[sessionId] = evt.id;
        }
        const supervisor = (detail.agents as SessionAgent[]).find((a) => a.id === detail.session.supervisorAgentId);
        setIsStreaming(supervisor?.status === 'running' || supervisor?.status === 'waiting_input');
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
  }, [selectedSessionId, handleAgentEvent]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  // "System" follows the OS setting live
  useEffect(() => {
    setTheme(resolveTheme(themeSetting));
    if (themeSetting !== 'system') return;
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onChange = () => setTheme(resolveTheme('system'));
    media?.addEventListener('change', onChange);
    return () => media?.removeEventListener('change', onChange);
  }, [themeSetting]);

  const persistUi = (ui: Partial<BootSettings>) => {
    saveUiSettings(ui)
      .then(() => setSaveError(null))
      .catch((err) => {
        console.error(err);
        setSaveError({ ui });
      });
  };

  const changeLanguage = (language: LanguageSetting) => {
    i18n.changeLanguage(language);
    document.documentElement.lang = language;
    persistUi({ language });
  };

  const changeTheme = (next: ThemeSetting) => {
    setThemeSetting(next);
    persistUi({ theme: next });
  };

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

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputMessage.trim() || !selectedSessionId || isStreaming) return;

    const userText = inputMessage.trim();
    setInputMessage('');
    setMessages((prev) => [...prev, { id: nextKey(), role: 'user', content: userText, pending: true }]);
    setIsStreaming(true);

    try {
      await fetch(`/api/sessions/${selectedSessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: userText }),
      });
    } catch (err) {
      console.error('Failed to send message', err);
      setIsStreaming(false);
    }
  };

  const supervisor = agents.find((a) => a.id === currentSession?.supervisorAgentId);
  const supervisorName = supervisor?.alias || supervisor?.agentName || 'Supervisor';
  const workspaceBusy = agents.some((a) => BUSY_STATUSES.includes(a.status ?? 'idle'));
  const navItemClass =
    'flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-accent hover:text-accent-foreground transition';

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-background text-foreground">
      {/* Top Header */}
      <header className="h-12 border-b border-border px-4 flex items-center justify-between bg-card select-none">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="text-xl text-primary">◆</span>
            <span className="text-base">{t('appName')}</span>
          </div>
          <div className="h-4 w-px bg-border" />
          <div
            className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted px-2.5 py-1 rounded-md border border-border"
            title={project?.path}
          >
            <span>{t('project')}:</span>
            <span className="font-medium text-foreground font-mono">
              {project ? shortenPath(project.path, project.homeDir) : '…'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 text-sm">
          <div
            className={`flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-md border ${
              pendingApprovals > 0
                ? 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800'
                : 'text-muted-foreground border-border'
            }`}
            title={t('header.pendingTitle')}
          >
            <span aria-hidden>⚑</span>
            <span>{t('header.pending', { count: pendingApprovals })}</span>
          </div>
          <ThemeMenu value={themeSetting} onChange={changeTheme} />
          <LanguageMenu value={(i18n.language as LanguageSetting) ?? 'en'} onChange={changeLanguage} />
          <a
            href="#settings"
            className="p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title={t('header.openSettings')}
            aria-label={t('header.openSettings')}
          >
            <Settings className="w-4 h-4" />
          </a>
        </div>
      </header>

      {/* Main Layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar */}
        <aside className="w-56 border-r border-border bg-card/50 flex flex-col justify-between p-3 select-none">
          <div className="space-y-4">
            <div>
              <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase px-2 mb-1.5">
                {t('nav.workspace')}
              </div>
              <nav className="space-y-0.5 text-xs font-medium">
                <button
                  onClick={() => setSelectedSessionId(null)}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-left transition ${
                    selectedSessionId === null
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  }`}
                >
                  <Play className="w-3.5 h-3.5 text-primary" />
                  <span>{t('sessions')}</span>
                </button>
              </nav>
            </div>

            <div>
              <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase px-2 mb-1.5">
                {t('nav.claudeConfig')}
              </div>
              <nav className="space-y-0.5 text-xs font-medium text-muted-foreground">
                <a href="#agents" className={navItemClass}>
                  <Bot className="w-3.5 h-3.5" />
                  <span>{t('agents')}</span>
                </a>
                <a href="#skills" className={navItemClass}>
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>{t('skills')}</span>
                </a>
                <a href="#commands" className={navItemClass}>
                  <Terminal className="w-3.5 h-3.5" />
                  <span>{t('commands')}</span>
                </a>
                <a href="#memory" className={navItemClass}>
                  <Brain className="w-3.5 h-3.5" />
                  <span>{t('memory')}</span>
                </a>
                <a href="#mcp" className={navItemClass}>
                  <Network className="w-3.5 h-3.5" />
                  <span>{t('mcp')}</span>
                </a>
                <a href="#plugins" className={navItemClass}>
                  <Puzzle className="w-3.5 h-3.5" />
                  <span>{t('plugins')}</span>
                </a>
              </nav>
            </div>
          </div>

          {/* Footer: Settings + Claude Code status (UI-WIREFRAMES 0) */}
          <div className="pt-3 border-t border-border space-y-2">
            <a href="#settings" className={`${navItemClass} text-xs font-medium text-muted-foreground`}>
              <Settings className="w-3.5 h-3.5" />
              <span>{t('settings')}</span>
            </a>
            <ClaudeStatus status={claudeStatus} serverOnline={serverOnline} />
          </div>
        </aside>

        {/* Center Content */}
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
                <div className="space-y-3">
                  {agents.map((agent) => (
                    <div
                      key={agent.id}
                      className={`p-3 rounded-lg border border-border bg-card shadow-sm ${
                        agent.status === 'suspended' ? 'opacity-70' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <Bot className="w-4 h-4 text-primary shrink-0" />
                          <span className="font-semibold text-xs truncate">{agent.alias || agent.agentName}</span>
                        </div>
                        <StatusBadge visual={agentVisual(agent.status)} label={t(agentStatusKey(agent.status))} />
                      </div>
                      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="rounded border border-border px-1.5 py-px">{t(`scope.${agent.scope}`)}</span>
                        {agent.status === 'suspended' && <span>{t('workspace.suspendedHint')}</span>}
                      </div>
                    </div>
                  ))}
                </div>
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

                {/* Input Bar (the shared Composer of UI-WIREFRAMES 3 arrives in Phase 4) */}
                <form
                  onSubmit={handleSendMessage}
                  className="p-3 border-t border-border bg-card flex items-center gap-2"
                >
                  <input
                    type="text"
                    value={inputMessage}
                    onChange={(e) => setInputMessage(e.target.value)}
                    placeholder={t('chat.placeholder', { name: supervisorName })}
                    disabled={isStreaming || throttledRetryMs !== null}
                    className="flex-1 px-3 py-2 text-xs rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                  />
                  {isStreaming || throttledRetryMs !== null ? (
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
                  ) : (
                    <Button
                      type="submit"
                      size="icon"
                      disabled={!inputMessage.trim()}
                      title={t('chat.send')}
                      aria-label={t('chat.send')}
                    >
                      <Send />
                    </Button>
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
      </div>
      {saveError && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 text-xs bg-destructive text-destructive-foreground rounded-lg px-3 py-2 shadow-lg">
          <span>{t('settingsSaveFailed')}</span>
          <button onClick={() => persistUi(saveError.ui)} className="font-semibold underline">
            {t('retry')}
          </button>
        </div>
      )}
    </div>
  );
}

export default App;
