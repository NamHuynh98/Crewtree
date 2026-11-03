// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentEvent, Approval, Session, SessionAgent, Task } from '@crewtree/shared';
import { useShell } from '@/app/shell';
import { api } from '@/lib/api';
import { previewComposerText } from '@/features/composer/MessageText';
import type { ComposerSendPayload } from '@/features/composer/types';
import type { ApprovalDecisionInput } from '@/components/workspace/ApprovalList';
import { applyChatEvent, BUSY_STATUSES, nextKey, type ChatMessage } from './chat';

export interface AgentStats {
  tokens: number;
  turns: number;
  filesTouched: number;
  lastTool?: { tool: string; input: unknown; ts: number };
  /** Rate limit retry deadline (epoch ms) while throttled */
  throttledUntil?: number;
}

export interface FileConflict {
  id: string;
  agentId: string;
  path: string;
  holderAgentId?: string;
  holderTaskTitle?: string;
  ts: number;
}

interface SessionDetail {
  session: Session;
  agents: SessionAgent[];
  tasks: Task[];
  approvals: Approval[];
  agentStats: Record<string, AgentStats>;
  runningProcesses: number;
  runningAgents: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

export type WorkspaceListener = (event: AgentEvent) => void;

/**
 * Live state of one session (UI-WIREFRAMES 2): tree, tasks, approvals, per-agent counters and the
 * Supervisor chat, from the REST snapshot plus the session WebSocket (replays after lastEventId).
 */
export function useWorkspace(sessionId: string) {
  const { t } = useTranslation();
  const { refreshApprovals } = useShell();
  const [session, setSession] = useState<Session | null>(null);
  const [agents, setAgents] = useState<SessionAgent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [stats, setStats] = useState<Record<string, AgentStats>>({});
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [usage, setUsage] = useState<Usage>(ZERO_USAGE);
  const [conflicts, setConflicts] = useState<FileConflict[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const supervisorIdRef = useRef<string | undefined>(undefined);
  const lastEventIdRef = useRef(0);
  const listeners = useRef(new Set<WorkspaceListener>());
  const agentsRef = useRef<SessionAgent[]>([]);
  agentsRef.current = agents;
  const titleRef = useRef('');
  const statsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refreshStats = useCallback(() => {
    clearTimeout(statsTimer.current);
    statsTimer.current = setTimeout(() => {
      api<SessionDetail>(`/api/sessions/${sessionId}`)
        .then((d) => setStats((prev) => mergeStats(prev, d.agentStats)))
        .catch(() => undefined);
    }, 1500);
  }, [sessionId]);

  const handleEvent = useCallback(
    (event: AgentEvent) => {
      const p = event.payload as any;
      const agentId = event.sessionAgentId ?? undefined;
      switch (event.type) {
        case 'agent.status':
          setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, status: p.status } : a)));
          if (agentId) {
            setStats((prev) => ({
              ...prev,
              [agentId]: {
                ...(prev[agentId] ?? emptyStats()),
                throttledUntil: p.status === 'throttled' ? Date.now() + (p.retryAfterMs ?? 60_000) : undefined,
              },
            }));
          }
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
          setApprovals((prev) => (prev.some((a) => a.id === p.id) ? prev : [...prev, p]));
          refreshApprovals();
          if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            const agent = agentsRef.current.find((a) => a.id === p.sessionAgentId);
            new Notification(t('approvals.notificationTitle', { agent: agent?.alias || agent?.agentName || '' }), {
              body: t('approvals.notificationBody', { tool: p.tool, session: titleRef.current }),
            });
          }
          break;
        case 'approval.resolved':
          setApprovals((prev) => prev.filter((a) => a.id !== p.id));
          refreshApprovals();
          break;
        case 'session.status':
          setSession((prev) => (prev ? { ...prev, status: p.status } : prev));
          break;
        case 'usage.updated':
          setUsage((prev) => ({
            inputTokens: prev.inputTokens + (p.inputTokens || 0),
            outputTokens: prev.outputTokens + (p.outputTokens || 0),
            cacheReadTokens: prev.cacheReadTokens + (p.cacheReadTokens || 0),
            cacheCreationTokens: prev.cacheCreationTokens + (p.cacheCreationTokens || 0),
          }));
          if (agentId) {
            setStats((prev) => {
              const s = prev[agentId] ?? emptyStats();
              return {
                ...prev,
                [agentId]: {
                  ...s,
                  tokens: s.tokens + (p.inputTokens || 0) + (p.outputTokens || 0),
                  turns: s.turns + (p.numTurns || 0),
                },
              };
            });
          }
          break;
        case 'agent.tool.start':
          if (agentId && !p.parentToolUseId) {
            setStats((prev) => ({
              ...prev,
              [agentId]: {
                ...(prev[agentId] ?? emptyStats()),
                lastTool: { tool: p.tool, input: p.input, ts: event.ts },
              },
            }));
          }
          break;
        case 'file.touched':
          refreshStats();
          break;
        case 'file.conflict':
          setConflicts((prev) => [
            ...prev.slice(-4),
            {
              id: nextKey('conflict'),
              agentId: p.agentId ?? agentId ?? '',
              path: p.path,
              holderAgentId: p.holderAgentId,
              holderTaskTitle: p.holderTask,
              ts: event.ts,
            },
          ]);
          break;
      }
      // Delivery updates of queued messages may come without an agent id
      if ((agentId && agentId === supervisorIdRef.current) || event.type === 'message.updated') {
        setChat((prev) => applyChatEvent(prev, event));
      }
      for (const l of listeners.current) l(event);
    },
    [refreshApprovals, refreshStats, t]
  );

  // Snapshot + Supervisor chat history, then the live socket
  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    setLoaded(false);
    setNotFound(false);
    lastEventIdRef.current = 0;

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const last = lastEventIdRef.current;
      ws = new WebSocket(
        `${protocol}//${window.location.host}/ws?sessionId=${sessionId}${last ? `&lastEventId=${last}` : ''}`
      );
      ws.onopen = () => (attempt = 0);
      ws.onmessage = (msg) => {
        try {
          const event: AgentEvent = JSON.parse(msg.data);
          if (!event.sessionId) return; // connected / pong
          if (event.id) {
            if (event.id <= lastEventIdRef.current) return;
            lastEventIdRef.current = event.id;
          }
          handleEvent(event);
        } catch (err) {
          console.error('Failed to parse WS event', err);
        }
      };
      ws.onclose = () => {
        if (closed) return;
        retry = setTimeout(connect, Math.min(500 * 2 ** attempt++, 10_000));
      };
    };

    (async () => {
      try {
        const detail = await api<SessionDetail>(`/api/sessions/${sessionId}`);
        const supervisorId = detail.session.supervisorAgentId;
        const events = await api<AgentEvent[]>(
          `/api/sessions/${sessionId}/events?after=0&agent=${supervisorId}&limit=2000`
        );
        if (closed) return;
        supervisorIdRef.current = supervisorId;
        titleRef.current = detail.session.title;
        setSession(detail.session);
        setAgents(detail.agents);
        setTasks(detail.tasks ?? []);
        setApprovals(detail.approvals ?? []);
        setStats(detail.agentStats ?? {});
        setUsage(ZERO_USAGE);
        let history: ChatMessage[] = [];
        for (const e of events) {
          if (e.type === 'agent.status') continue;
          history = applyChatEvent(history, e, true);
        }
        setChat(history);
        // Live events start after the newest persisted one of the whole session
        const tail = await api<AgentEvent[]>(`/api/sessions/${sessionId}/events?before=999999999999&limit=1`);
        lastEventIdRef.current = tail[0]?.id ?? 0;
        setLoaded(true);
      } catch (err: any) {
        if (!closed) {
          if (err?.status === 404) setNotFound(true);
          else setError(err.message);
        }
      }
      if (!closed) connect();
    })();

    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(statsTimer.current);
      ws?.close();
    };
  }, [sessionId, handleEvent]);

  const subscribe = useCallback((listener: WorkspaceListener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  // ------------------------------------------------------------------ actions

  const run = useCallback(async (fn: () => Promise<unknown>): Promise<string | null> => {
    try {
      await fn();
      setError(null);
      return null;
    } catch (err: any) {
      setError(err.message);
      return err.message as string;
    }
  }, []);

  /** Main chat → Supervisor; with agentId → a node's own chat. Busy agents queue the message (PLAN.md 4.3). */
  const sendMessage = useCallback(
    async ({ text, attachments, mode }: ComposerSendPayload, agentId?: string) => {
      if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
      const toSupervisor = !agentId || agentId === supervisorIdRef.current;
      const key = nextKey();
      if (toSupervisor) {
        const preview = [previewComposerText(text), ...(attachments.length ? [`📎 ×${attachments.length}`] : [])]
          .filter(Boolean)
          .join('\n');
        setChat((prev) => [...prev, { id: key, role: 'user', content: preview, pending: true, ts: Date.now() }]);
      }
      const url = toSupervisor
        ? `/api/sessions/${sessionId}/messages`
        : `/api/sessions/${sessionId}/agents/${agentId}/messages`;
      const failed = await run(() => api(url, { body: { content: text, attachments, mode } }));
      if (failed && toSupervisor) setChat((prev) => prev.filter((m) => m.id !== key));
      return failed;
    },
    [run, sessionId]
  );

  const actions = useMemo(
    () => ({
      sendMessage,
      interrupt: (agentId?: string) =>
        run(() =>
          api(`/api/sessions/${sessionId}/agents/${agentId ?? supervisorIdRef.current}/interrupt`, { body: {} })
        ),
      decideApproval: (id: string, decision: ApprovalDecisionInput) =>
        api(`/api/approvals/${id}`, { body: decision }).then(
          () => null,
          (err) => err.message as string
        ),
      sessionAction: (action: 'pause' | 'resume' | 'stop') =>
        run(() => api(`/api/sessions/${sessionId}/${action}`, { body: {} })),
      cancelTask: (taskId: string) =>
        run(() =>
          api(`/api/sessions/${sessionId}/tasks/${taskId}/cancel`, { body: { reason: 'Cancelled by the user' } })
        ),
      addAgent: (agentName: string, parentId?: string) =>
        run(() => api(`/api/sessions/${sessionId}/agents`, { body: { agentName, parentId } })),
      removeAgent: (agentId: string) =>
        run(() => api(`/api/sessions/${sessionId}/agents/${agentId}`, { method: 'DELETE' })),
      updateAgent: (agentId: string, patch: { modelOverride?: string | null; canDelegateOverride?: boolean | null }) =>
        run(async () => {
          const updated = await api<SessionAgent>(`/api/sessions/${sessionId}/agents/${agentId}`, {
            method: 'PATCH',
            body: patch,
          });
          setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, ...updated } : a)));
        }),
      updateSession: (patch: { title?: string; settings?: unknown }) =>
        run(async () => setSession(await api<Session>(`/api/sessions/${sessionId}`, { method: 'PATCH', body: patch }))),
      dismissConflict: (id: string) => setConflicts((prev) => prev.filter((c) => c.id !== id)),
      clearError: () => setError(null),
    }),
    [run, sendMessage, sessionId]
  );

  const supervisor = agents.find((a) => a.id === session?.supervisorAgentId);
  return {
    session,
    agents,
    tasks,
    approvals,
    stats,
    chat,
    usage,
    conflicts,
    error,
    loaded,
    notFound,
    supervisor,
    supervisorBusy: BUSY_STATUSES.includes(supervisor?.status ?? 'idle'),
    workspaceBusy: agents.some((a) => BUSY_STATUSES.includes(a.status ?? 'idle')),
    subscribe,
    ...actions,
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;

function emptyStats(): AgentStats {
  return { tokens: 0, turns: 0, filesTouched: 0 };
}

/** Server counters win for totals; live-only fields (throttle deadline) are kept. */
function mergeStats(prev: Record<string, AgentStats>, next: Record<string, AgentStats>): Record<string, AgentStats> {
  const out: Record<string, AgentStats> = { ...prev };
  for (const [id, s] of Object.entries(next)) out[id] = { ...s, throttledUntil: prev[id]?.throttledUntil };
  return out;
}

export function agentLabel(agent: SessionAgent | undefined): string {
  return agent ? agent.alias || agent.agentName : '?';
}
