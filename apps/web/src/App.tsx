// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, useRef } from 'react';
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
  Wrench
} from 'lucide-react';
import { Session, SessionAgent, AgentEvent } from '@crewtree/shared';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: Array<{ tool: string; input: any }>;
}

export function App() {
  const { t, i18n } = useTranslation();
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [serverHealth, setServerHealth] = useState<{ status: string; version: string } | null>(null);
  
  // Sessions & Selection
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [agents, setAgents] = useState<SessionAgent[]>([]);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [newSessionTitle, setNewSessionTitle] = useState('');

  // Chat & Realtime State
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);

  // Load server health & sessions
  const loadSessions = () => {
    fetch('/api/sessions')
      .then((res) => res.json())
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

  // When a session is selected, load its details & connect WS
  useEffect(() => {
    if (!selectedSessionId) {
      setCurrentSession(null);
      setAgents([]);
      setMessages([]);
      return;
    }

    fetch(`/api/sessions/${selectedSessionId}`)
      .then((res) => res.json())
      .then((data) => {
        setCurrentSession(data.session);
        setAgents(data.agents);
      });

    // Setup WebSocket for this session
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?sessionId=${selectedSessionId}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const agentEvent: AgentEvent = JSON.parse(event.data);
        handleAgentEvent(agentEvent);
      } catch (err) {
        console.error('Failed to parse WS event', err);
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [selectedSessionId]);

  // Handle incoming live AgentEvents
  const handleAgentEvent = (event: AgentEvent) => {
    if (event.type === 'agent.status') {
      const status = event.payload?.status;
      setAgents((prev) =>
        prev.map((a) => (a.id === event.sessionAgentId ? { ...a, status } : a))
      );
      if (status === 'running') setIsStreaming(true);
      if (status === 'idle') setIsStreaming(false);
    }

    if (event.type === 'agent.text.delta') {
      const deltaText = event.payload?.text || '';
      setMessages((prev) => {
        const lastMsg = prev[prev.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          return [
            ...prev.slice(0, -1),
            { ...lastMsg, content: lastMsg.content + deltaText },
          ];
        } else {
          return [
            ...prev,
            { id: Date.now().toString(), role: 'assistant', content: deltaText },
          ];
        }
      });
    }

    if (event.type === 'agent.tool.start') {
      const { tool, input } = event.payload;
      setMessages((prev) => {
        const lastMsg = prev[prev.length - 1];
        const newTool = { tool, input };
        if (lastMsg && lastMsg.role === 'assistant') {
          return [
            ...prev.slice(0, -1),
            { ...lastMsg, toolCalls: [...(lastMsg.toolCalls || []), newTool] },
          ];
        } else {
          return [
            ...prev,
            { id: Date.now().toString(), role: 'assistant', content: '', toolCalls: [newTool] },
          ];
        }
      });
    }
  };

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const toggleLanguage = () => {
    const nextLang = i18n.language === 'en' ? 'vi' : 'en';
    i18n.changeLanguage(nextLang);
  };

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    if (nextTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
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

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputMessage.trim() || !selectedSessionId || isStreaming) return;

    const userText = inputMessage.trim();
    setInputMessage('');
    setMessages((prev) => [
      ...prev,
      { id: Date.now().toString(), role: 'user', content: userText },
    ]);
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
    <div className={`min-h-screen flex flex-col ${theme === 'dark' ? 'dark bg-zinc-950 text-zinc-100' : 'bg-zinc-50 text-zinc-900'}`}>
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
                <a href="#agents" className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800/60 hover:text-zinc-900 dark:hover:text-zinc-200">
                  <Bot className="w-3.5 h-3.5" />
                  <span>{t('agents')}</span>
                </a>
                <a href="#skills" className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800/60 hover:text-zinc-900 dark:hover:text-zinc-200">
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>{t('skills')}</span>
                </a>
                <a href="#commands" className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800/60 hover:text-zinc-900 dark:hover:text-zinc-200">
                  <Terminal className="w-3.5 h-3.5" />
                  <span>{t('commands')}</span>
                </a>
                <a href="#memory" className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800/60 hover:text-zinc-900 dark:hover:text-zinc-200">
                  <Brain className="w-3.5 h-3.5" />
                  <span>{t('memory')}</span>
                </a>
                <a href="#mcp" className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800/60 hover:text-zinc-900 dark:hover:text-zinc-200">
                  <Network className="w-3.5 h-3.5" />
                  <span>{t('mcp')}</span>
                </a>
                <a href="#plugins" className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800/60 hover:text-zinc-900 dark:hover:text-zinc-200">
                  <Puzzle className="w-3.5 h-3.5" />
                  <span>{t('plugins')}</span>
                </a>
              </nav>
            </div>
          </div>

          {/* Footer Status */}
          <div className="pt-3 border-t border-zinc-200 dark:border-zinc-800 text-[11px] text-zinc-500">
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
              <span className="font-medium text-zinc-700 dark:text-zinc-300">Claude Code ready</span>
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
                  <p className="text-xs text-zinc-500 mt-0.5">Manage and coordinate multi-agent sessions on top of Claude Code</p>
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
                <form onSubmit={handleCreateSession} className="p-4 rounded-xl border border-indigo-200 dark:border-indigo-900/60 bg-indigo-50/50 dark:bg-indigo-950/20 space-y-3">
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

              {/* Sessions Table / List */}
              {sessions.length === 0 ? (
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
                <span>{currentSession?.totalTokens || 0} tokens</span>
              </div>
            </div>

            {/* Split Workspace: Agents Tree Pane & Chat Pane */}
            <div className="flex-1 flex overflow-hidden">
              {/* Agent Tree Diagram Pane */}
              <div className="w-72 border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30 p-4 flex flex-col overflow-y-auto">
                <div className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase mb-3">
                  Agent Tree
                </div>
                <div className="space-y-3">
                  {agents.map((agent) => (
                    <div
                      key={agent.id}
                      className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Bot className="w-4 h-4 text-indigo-500" />
                          <span className="font-semibold text-xs text-zinc-900 dark:text-zinc-100">
                            {agent.alias || agent.agentName}
                          </span>
                        </div>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                            agent.status === 'running'
                              ? 'bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400'
                              : agent.status === 'waiting_input'
                              ? 'bg-amber-100 dark:bg-amber-950 text-amber-600 dark:text-amber-400'
                              : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500'
                          }`}
                        >
                          {agent.status}
                        </span>
                      </div>
                      <div className="text-[11px] text-zinc-500 mt-1">Scope: {agent.scope}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Chat & Stream Pane */}
              <div className="flex-1 flex flex-col bg-white dark:bg-zinc-950">
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
                        className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}
                      >
                        <div
                          className={`max-w-[80%] rounded-xl px-4 py-2.5 text-xs leading-relaxed ${
                            m.role === 'user'
                              ? 'bg-indigo-600 text-white rounded-br-sm'
                              : 'bg-zinc-100 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 rounded-bl-sm border border-zinc-200 dark:border-zinc-800'
                          }`}
                        >
                          {/* Tool chips if any */}
                          {m.toolCalls && m.toolCalls.length > 0 && (
                            <div className="mb-2 space-y-1">
                              {m.toolCalls.map((tc, idx) => (
                                <div
                                  key={idx}
                                  className="flex items-center gap-1.5 px-2 py-1 rounded bg-black/5 dark:bg-white/5 text-[11px] font-mono text-zinc-600 dark:text-zinc-300"
                                >
                                  <Wrench className="w-3 h-3 text-indigo-400" />
                                  <span>{tc.tool}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          <div className="whitespace-pre-wrap">{m.content}</div>
                        </div>
                      </div>
                    ))
                  )}

                  {isStreaming && (
                    <div className="flex items-center gap-2 text-xs text-zinc-400">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500" />
                      <span>Supervisor is thinking and responding...</span>
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
                    disabled={isStreaming}
                    className="flex-1 px-3 py-2 text-xs rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
                  />
                  <button
                    type="submit"
                    disabled={!inputMessage.trim() || isStreaming}
                    className="p-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 transition shadow-sm"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
