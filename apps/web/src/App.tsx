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
  Sun,
  Moon,
  Plus,
  Play,
  ArrowLeft,
  Send,
  Loader2,
  Wrench,
  PauseCircle,
  Clock,
  Coins,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Code2,
  Square,
} from 'lucide-react';
import { Session, SessionAgent, AgentEvent } from '@crewtree/shared';
import { getBoot, resolveTheme, saveUiSettings, BootSettings } from './lib/boot';
import { Button } from '@/components/ui/button';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: Array<{ tool: string; toolUseId: string; input: any; output?: any; isError?: boolean }>;
  isStreaming?: boolean;
  /** Optimistic user message not yet confirmed by message.created */
  pending?: boolean;
}

interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

// Unique React keys for chat messages (several can be created in the same millisecond during replay)
let keySeq = 0;
const nextKey = (prefix = 'msg') => `${prefix}-${++keySeq}`;

// Helper: map agent status to color classes
function statusBadge(status: string) {
  switch (status) {
    case 'running':
      return 'bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800';
    case 'waiting_input':
      return 'bg-amber-100 dark:bg-amber-950 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800';
    case 'throttled':
      return 'bg-orange-100 dark:bg-orange-950 text-orange-600 dark:text-orange-400 border-orange-200 dark:border-orange-800';
    case 'suspended':
      return 'bg-zinc-200 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border-zinc-300 dark:border-zinc-700';
    case 'error':
      return 'bg-red-100 dark:bg-red-950 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800';
    default:
      return 'bg-emerald-100 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800';
  }
}

function statusIcon(status: string) {
  switch (status) {
    case 'running':
      return <Loader2 className="w-3 h-3 animate-spin" />;
    case 'waiting_input':
      return <AlertTriangle className="w-3 h-3" />;
    case 'throttled':
      return <Clock className="w-3 h-3" />;
    case 'suspended':
      return <PauseCircle className="w-3 h-3" />;
    case 'error':
      return <XCircle className="w-3 h-3" />;
    default:
      return <CheckCircle2 className="w-3 h-3" />;
  }
}

export function App() {
  const { t, i18n } = useTranslation();
  const [theme, setTheme] = useState<'light' | 'dark'>(() => resolveTheme(getBoot().theme));
  // Failed settings save: the UI keeps the new value and offers a retry (PLAN.md 11.1)
  const [saveError, setSaveError] = useState<{ ui: Partial<BootSettings> } | null>(null);
  const [serverHealth, setServerHealth] = useState<{ status: string; version: string } | null>(null);

  // Sessions & Selection
  const [sessions, setSessions] = useState<Session[]>([]);
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

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((data) => setServerHealth(data))
      .catch((err) => console.error('Server health check failed', err));

    loadSessions();
  }, []);

  // Handle incoming live AgentEvents
  // `history`: replaying persisted events — status and usage are already reflected in the loaded session
  const handleAgentEvent = useCallback((event: AgentEvent, opts: { history?: boolean } = {}) => {
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

    if (event.type === 'usage.updated' && event.payload?.isError) {
      setMessages((prev) => [
        ...prev,
        { id: nextKey('ended'), role: 'system', content: 'Turn interrupted or failed.' },
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
          { id: nextKey(), role: 'system', content: `⚠️ Agent error: ${event.payload?.error || 'Unknown error'}` },
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
  }, []);

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

  const persistUi = (ui: Partial<BootSettings>) => {
    saveUiSettings(ui)
      .then(() => setSaveError(null))
      .catch((err) => {
        console.error(err);
        setSaveError({ ui });
      });
  };

  const toggleLanguage = () => {
    const nextLang = i18n.language === 'en' ? 'vi' : 'en';
    i18n.changeLanguage(nextLang);
    document.documentElement.lang = nextLang;
    persistUi({ language: nextLang });
  };

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    persistUi({ theme: nextTheme });
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

  return (
    <div
      className={`h-screen overflow-hidden flex flex-col ${theme === 'dark' ? 'dark bg-zinc-950 text-zinc-100' : 'bg-zinc-50 text-zinc-900'}`}
    >
      {/* Top Header */}
      <header className="h-12 border-b border-zinc-200 dark:border-zinc-800 px-4 flex items-center justify-between bg-white dark:bg-zinc-900 select-none">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 font-bold tracking-tight text-indigo-600 dark:text-indigo-400">
            <span className="text-xl">◆</span>
            <span className="text-base font-semibold text-zinc-900 dark:text-white">Crewtree</span>
          </div>
          <div className="h-4 w-[1px] bg-zinc-300 dark:bg-zinc-700" />
          <div className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-2.5 py-1 rounded-md border border-zinc-200 dark:border-zinc-700">
            <span>{t('project')}:</span>
            <span className="font-medium text-zinc-900 dark:text-zinc-200">Tool-AI</span>
          </div>
        </div>

        <div className="flex items-center gap-3 text-sm">
          <div className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 rounded border border-amber-200 dark:border-amber-800">
            <ShieldAlert className="w-3.5 h-3.5" />
            <span>0 {t('approvals')}</span>
          </div>

          <button
            onClick={toggleTheme}
            className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
            title="Toggle Theme"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          <button
            onClick={toggleLanguage}
            className="px-2 py-1 text-xs font-semibold rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700"
          >
            {i18n.language.toUpperCase()}
          </button>

          <button
            className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
            title="Settings"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar */}
        <aside className="w-56 border-r border-zinc-200 dark:border-zinc-800 bg-white/50 dark:bg-zinc-900/50 flex flex-col justify-between p-3 select-none">
          <div className="space-y-4">
            <div>
              <div className="text-[10px] font-semibold tracking-wider text-zinc-400 uppercase px-2 mb-1.5">
                Workspace
              </div>
              <nav className="space-y-0.5 text-xs font-medium">
                <button
                  onClick={() => setSelectedSessionId(null)}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-left transition ${
                    selectedSessionId === null
                      ? 'bg-zinc-200/70 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
                      : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800/60'
                  }`}
                >
                  <Play className="w-3.5 h-3.5 text-indigo-500" />
                  <span>{t('sessions')}</span>
                </button>
              </nav>
            </div>

            <div>
              <div className="text-[10px] font-semibold tracking-wider text-zinc-400 uppercase px-2 mb-1.5">
                Claude Config
              </div>
              <nav className="space-y-0.5 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                <a
                  href="#agents"
                  className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800/60 hover:text-zinc-900 dark:hover:text-zinc-200"
                >
                  <Bot className="w-3.5 h-3.5" />
                  <span>{t('agents')}</span>
                </a>
                <a
                  href="#skills"
                  className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800/60 hover:text-zinc-900 dark:hover:text-zinc-200"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>{t('skills')}</span>
                </a>
                <a
                  href="#commands"
                  className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800/60 hover:text-zinc-900 dark:hover:text-zinc-200"
                >
                  <Terminal className="w-3.5 h-3.5" />
                  <span>{t('commands')}</span>
                </a>
                <a
                  href="#memory"
                  className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800/60 hover:text-zinc-900 dark:hover:text-zinc-200"
                >
                  <Brain className="w-3.5 h-3.5" />
                  <span>{t('memory')}</span>
                </a>
                <a
                  href="#mcp"
                  className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800/60 hover:text-zinc-900 dark:hover:text-zinc-200"
                >
                  <Network className="w-3.5 h-3.5" />
                  <span>{t('mcp')}</span>
                </a>
                <a
                  href="#plugins"
                  className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800/60 hover:text-zinc-900 dark:hover:text-zinc-200"
                >
                  <Puzzle className="w-3.5 h-3.5" />
                  <span>{t('plugins')}</span>
                </a>
              </nav>
            </div>
          </div>

          {/* Footer Status */}
          <div className="pt-3 border-t border-zinc-200 dark:border-zinc-800 text-[11px] text-zinc-500">
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-2 h-2 rounded-full ${serverHealth ? 'bg-emerald-500' : 'bg-zinc-400'}`}></span>
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                {serverHealth ? 'Server online' : 'Server offline'}
              </span>
            </div>
            <div className="text-[10px] text-zinc-400">
              Server: {serverHealth ? `v${serverHealth.version} (online)` : 'connecting...'}
            </div>
          </div>
        </aside>

        {/* Center Content */}
        {!selectedSessionId ? (
          /* SESSIONS LIST VIEW */
          <main className="flex-1 p-6 overflow-y-auto">
            <div className="max-w-4xl mx-auto space-y-6">
              <div className="flex items-center justify-between pb-4 border-b border-zinc-200 dark:border-zinc-800">
                <div>
                  <h1 className="text-xl font-bold tracking-tight">{t('sessions')}</h1>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Manage and coordinate multi-agent sessions on top of Claude Code
                  </p>
                </div>
                <button
                  onClick={() => setIsCreatingSession(true)}
                  className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-md text-xs font-semibold shadow-sm transition"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{t('actions.newSession')}</span>
                </button>
              </div>

              {/* Create Session Dialog inline */}
              {isCreatingSession && (
                <form
                  onSubmit={handleCreateSession}
                  className="p-4 rounded-xl border border-indigo-200 dark:border-indigo-900/60 bg-indigo-50/50 dark:bg-indigo-950/20 space-y-3"
                >
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Create New Session</h3>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Session Title (e.g. Implement login feature)..."
                      value={newSessionTitle}
                      onChange={(e) => setNewSessionTitle(e.target.value)}
                      className="flex-1 px-3 py-1.5 text-xs rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      autoFocus
                    />
                    <button
                      type="submit"
                      className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-md transition"
                    >
                      {t('actions.save')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsCreatingSession(false)}
                      className="px-3 py-1.5 text-xs font-semibold text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded-md transition"
                    >
                      {t('actions.cancel')}
                    </button>
                  </div>
                </form>
              )}

              {authRequired && (
                <div className="mb-4 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
                  <ShieldAlert className="w-4 h-4 shrink-0" />
                  <span>
                    Not signed in. Run <code className="font-mono">crewtree</code> (or open the login link printed by
                    the dev server) to access your sessions.
                  </span>
                </div>
              )}

              {/* Sessions Table / List */}
              {authRequired ? null : sessions.length === 0 ? (
                <div className="border border-dashed border-zinc-300 dark:border-zinc-800 rounded-xl p-10 text-center flex flex-col items-center justify-center bg-white/40 dark:bg-zinc-900/20">
                  <div className="w-12 h-12 rounded-full bg-indigo-50 dark:bg-indigo-950/50 flex items-center justify-center text-indigo-600 dark:text-indigo-400 mb-3">
                    <Bot className="w-6 h-6" />
                  </div>
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">No sessions yet</h3>
                  <p className="text-xs text-zinc-500 max-w-sm mt-1">
                    Create a session, select your agents and assign the Supervisor a goal.
                  </p>
                  <button
                    onClick={() => setIsCreatingSession(true)}
                    className="mt-4 flex items-center gap-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>{t('actions.newSession')}</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  {sessions.map((s) => (
                    <div
                      key={s.id}
                      onClick={() => setSelectedSessionId(s.id)}
                      className="p-3.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/80 hover:border-indigo-400 dark:hover:border-indigo-600/80 cursor-pointer flex items-center justify-between transition shadow-sm"
                    >
                      <div className="flex items-center gap-3">
                        <span className="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
                        <div>
                          <div className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">{s.title}</div>
                          <div className="text-[11px] text-zinc-500 mt-0.5">{s.cwd}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-zinc-500">
                        <span>{new Date(s.createdAt).toLocaleDateString()}</span>
                        <button className="px-2.5 py-1 text-xs font-medium rounded border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                          {t('actions.open')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </main>
        ) : (
          /* ACTIVE SESSION WORKSPACE VIEW */
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Session Workspace Header */}
            <div className="h-11 border-b border-zinc-200 dark:border-zinc-800 px-4 flex items-center justify-between bg-white dark:bg-zinc-900 select-none">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setSelectedSessionId(null)}
                  className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                  title="Back to sessions"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <div className="font-semibold text-sm">{currentSession?.title}</div>
                <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 text-[11px] font-medium border border-emerald-200 dark:border-emerald-800">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                  <span>{currentSession?.status}</span>
                </div>
              </div>

              <div className="text-xs text-zinc-500 flex items-center gap-3">
                <span>{agents.length} agent(s)</span>
                <span>•</span>
                <span className="flex items-center gap-1">
                  <Coins className="w-3 h-3" />
                  {(currentSession?.totalTokens ?? 0) + usageStats.inputTokens + usageStats.outputTokens} tokens
                </span>
                {throttledRetryMs !== null && (
                  <span className="flex items-center gap-1 text-orange-500 font-medium">
                    <Clock className="w-3 h-3" />
                    Rate limited — retry in {Math.ceil(throttledRetryMs / 1000)}s
                  </span>
                )}
                <button
                  onClick={() => setShowRawEventLog((v) => !v)}
                  className={`px-2 py-0.5 text-[11px] rounded font-medium border flex items-center gap-1.5 transition ${
                    showRawEventLog
                      ? 'bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 border-indigo-300 dark:border-indigo-700'
                      : 'text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                  }`}
                  title="Toggle Raw Event Log"
                >
                  <Code2 className="w-3 h-3" />
                  <span>Event Log</span>
                </button>
              </div>
            </div>

            {/* Split Workspace: Agents Tree Pane & Chat Pane */}
            <div className="flex-1 flex overflow-hidden">
              {/* Agent Tree Diagram Pane */}
              <div className="w-72 border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30 p-4 flex flex-col overflow-y-auto">
                <div className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase mb-3">Agent Tree</div>
                <div className="space-y-3">
                  {agents.map((agent) => (
                    <div
                      key={agent.id}
                      className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm"
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2">
                          <Bot className="w-4 h-4 text-indigo-500" />
                          <span className="font-semibold text-xs text-zinc-900 dark:text-zinc-100">
                            {agent.alias || agent.agentName}
                          </span>
                        </div>
                        <span
                          className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium border ${statusBadge(agent.status ?? 'idle')}`}
                        >
                          {statusIcon(agent.status ?? 'idle')}
                          {agent.status}
                        </span>
                      </div>
                      <div className="text-[11px] text-zinc-500 mt-1">Scope: {agent.scope}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Chat & Stream Pane */}
              <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-zinc-950">
                {/* Messages List */}
                <div className="flex-1 p-4 overflow-y-auto space-y-4">
                  {messages.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-zinc-400 text-xs">
                      <Bot className="w-8 h-8 mb-2 opacity-50 text-indigo-500" />
                      <p>Start interacting with the Supervisor agent.</p>
                      <p className="text-[11px] mt-0.5">Send instructions or prompt the team to begin.</p>
                    </div>
                  ) : (
                    messages.map((m) => (
                      <div
                        key={m.id}
                        className={`flex flex-col ${m.role === 'user' ? 'items-end' : m.role === 'system' ? 'items-center' : 'items-start'}`}
                      >
                        {m.role === 'system' ? (
                          <div className="text-[11px] text-zinc-400 italic py-1">{m.content}</div>
                        ) : (
                          <div
                            className={`max-w-[80%] rounded-xl px-4 py-2.5 text-xs leading-relaxed ${
                              m.role === 'user'
                                ? 'bg-indigo-600 text-white rounded-br-sm'
                                : 'bg-zinc-100 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 rounded-bl-sm border border-zinc-200 dark:border-zinc-800'
                            }`}
                          >
                            {m.content && <div className="whitespace-pre-wrap">{m.content}</div>}
                            {m.isStreaming && (
                              <span className="inline-block w-1.5 h-3.5 bg-indigo-500 rounded-sm ml-0.5 animate-pulse" />
                            )}
                            {/* Tool chips if any */}
                            {m.toolCalls && m.toolCalls.length > 0 && (
                              <div className={`space-y-1 ${m.content ? 'mt-2' : ''}`}>
                                {m.toolCalls.map((tc, idx) => (
                                  <details
                                    key={idx}
                                    className={`px-2 py-1.5 rounded text-[11px] font-mono border ${
                                      tc.isError
                                        ? 'bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border-red-200 dark:border-red-900/50'
                                        : tc.output !== undefined
                                          ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900/50'
                                          : 'bg-black/5 dark:bg-white/5 text-zinc-600 dark:text-zinc-300 border-black/5 dark:border-white/5'
                                    }`}
                                  >
                                    <summary className="cursor-pointer select-none flex items-center gap-1.5 list-none">
                                      {tc.isError ? (
                                        <XCircle className="w-3 h-3 text-red-400 shrink-0" />
                                      ) : tc.output !== undefined ? (
                                        <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                                      ) : (
                                        <Wrench className="w-3 h-3 animate-pulse text-indigo-400 shrink-0" />
                                      )}
                                      <span className="font-semibold">{tc.tool}</span>
                                      <span className="text-[10px] opacity-60 ml-auto">details</span>
                                    </summary>
                                    <div className="mt-2 pt-1.5 border-t border-black/10 dark:border-white/10 space-y-1 text-[10px]">
                                      {tc.input && (
                                        <div>
                                          <div className="text-[9px] uppercase tracking-wider opacity-60 font-sans font-semibold">
                                            Input:
                                          </div>
                                          <pre className="overflow-x-auto whitespace-pre-wrap max-h-32">
                                            {JSON.stringify(tc.input, null, 2)}
                                          </pre>
                                        </div>
                                      )}
                                      {tc.output !== undefined && (
                                        <div className="mt-1 pt-1 border-t border-black/5 dark:border-white/5">
                                          <div className="text-[9px] uppercase tracking-wider opacity-60 font-sans font-semibold">
                                            Output:
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
                    <div className="flex items-center gap-2 text-xs text-zinc-400">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500" />
                      <span>Supervisor is thinking and responding...</span>
                    </div>
                  )}

                  {throttledRetryMs !== null && (
                    <div className="flex items-center gap-2 text-xs text-orange-500 bg-orange-50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-800 rounded-lg px-3 py-2">
                      <Clock className="w-3.5 h-3.5" />
                      <span>
                        Rate limited by Claude API — auto-retrying in {Math.ceil(throttledRetryMs / 1000)} seconds
                      </span>
                    </div>
                  )}

                  <div ref={chatBottomRef} />
                </div>

                {/* Input Bar */}
                <form
                  onSubmit={handleSendMessage}
                  className="p-3 border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex items-center gap-2"
                >
                  <input
                    type="text"
                    value={inputMessage}
                    onChange={(e) => setInputMessage(e.target.value)}
                    placeholder="Message Supervisor (e.g. Break down the task, delegate to coder)..."
                    disabled={isStreaming || throttledRetryMs !== null}
                    className="flex-1 px-3 py-2 text-xs rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
                  />
                  {isStreaming || throttledRetryMs !== null ? (
                    <Button
                      type="button"
                      size="icon"
                      variant="destructive"
                      onClick={handleInterrupt}
                      title="Interrupt"
                      aria-label="Interrupt"
                    >
                      <Square />
                    </Button>
                  ) : (
                    <Button type="submit" size="icon" disabled={!inputMessage.trim()} title="Send" aria-label="Send">
                      <Send />
                    </Button>
                  )}
                </form>
              </div>

              {/* Live Event Log Panel (collapsible) */}
              {showRawEventLog && (
                <div className="w-80 border-l border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/40 p-3 flex flex-col overflow-hidden text-xs">
                  <div className="flex items-center justify-between pb-2 mb-2 border-b border-zinc-200 dark:border-zinc-800">
                    <span className="font-semibold text-[11px] uppercase tracking-wider text-zinc-400">
                      Live Event Log
                    </span>
                    <span className="text-[10px] text-zinc-500 font-mono">{rawEvents.length} events</span>
                  </div>
                  <div className="flex-1 overflow-y-auto space-y-2 font-mono text-[11px]">
                    {rawEvents.length === 0 ? (
                      <div className="text-zinc-400 text-center py-8 text-xs">No events captured yet</div>
                    ) : (
                      rawEvents.map((e, idx) => (
                        <div
                          key={idx}
                          className="p-2 rounded bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xs"
                        >
                          <div className="flex items-center justify-between text-[10px] text-zinc-400 mb-1">
                            <span className="text-indigo-600 dark:text-indigo-400 font-semibold">{e.type}</span>
                            <span>{new Date(e.ts).toLocaleTimeString()}</span>
                          </div>
                          <div className="text-zinc-600 dark:text-zinc-300 text-[10px] break-all max-h-24 overflow-y-auto bg-black/5 dark:bg-black/30 p-1.5 rounded">
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
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 text-xs bg-red-600 text-white rounded-lg px-3 py-2 shadow-lg">
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
