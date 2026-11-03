// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { RotateCcw, ShieldAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { shortenPath } from '@/lib/paths';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/Markdown';
import { Composer } from '@/features/composer/Composer';
import { UserMessageText } from '@/features/composer/MessageText';
import type { ComposerSendPayload } from '@/features/composer/types';

interface ProjectsResponse {
  current: { path: string; homeDir: string };
  recent: Array<{ path: string }>;
}

type Entry =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | { kind: 'tool'; id: string; tool: string; input: unknown; output?: string; isError?: boolean }
  | { kind: 'permission'; id: string; tool: string; input: unknown; decided?: boolean; allow?: boolean }
  | { kind: 'error'; id: string; text: string };

function toolOutputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map((b: any) => b?.text ?? '').join('');
  return JSON.stringify(output);
}

let seq = 0;
const key = () => `e${++seq}`;

/** Agent Editor "Try it" (PLAN.md 6.4, UI-WIREFRAMES 8): run the unsaved agent in a sandbox. */
export function TryItPanel({ content, agentName }: { content: string; agentName: string }) {
  const { t } = useTranslation();
  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<ProjectsResponse>('/api/projects'),
  });
  const [cwd, setCwd] = useState<string>('');
  const [allowWrites, setAllowWrites] = useState(false);
  const [sandbox, setSandbox] = useState<{ id: string; content: string; cwd: string; allowWrites: boolean } | null>(
    null
  );
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<'idle' | 'running' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sandboxRef = useRef(sandbox);
  sandboxRef.current = sandbox;

  useEffect(() => {
    if (!cwd && projects?.current.path) setCwd(projects.current.path);
  }, [projects, cwd]);

  // Stop the sandbox when leaving the editor
  useEffect(
    () => () => {
      if (sandboxRef.current) void fetch(`/api/tryit/${sandboxRef.current.id}`, { method: 'DELETE' });
    },
    []
  );

  // Event stream of the current sandbox
  useEffect(() => {
    if (!sandbox) return;
    const source = new EventSource(`/api/tryit/${sandbox.id}/events`);
    const on = (type: string, fn: (data: any) => void) =>
      source.addEventListener(type, (e) => fn(JSON.parse((e as MessageEvent).data)));
    on('status', (d) => setStatus(d.status));
    on('run.error', (d) => d?.error && setEntries((prev) => [...prev, { kind: 'error', id: key(), text: d.error }]));
    on('permission', (d) =>
      setEntries((prev) =>
        prev.some((e) => e.kind === 'permission' && e.id === d.id)
          ? prev
          : [...prev, { kind: 'permission', id: d.id, tool: d.tool, input: d.input }]
      )
    );
    on('permission.resolved', (d) =>
      setEntries((prev) =>
        prev.map((e) => (e.kind === 'permission' && e.id === d.id ? { ...e, decided: true, allow: d.allow } : e))
      )
    );
    on('event', (ev) => {
      const p = ev.payload ?? {};
      if (p.parentToolUseId) return; // built-in subagent internals stay hidden
      setEntries((prev) => {
        const last = prev[prev.length - 1];
        switch (ev.type) {
          case 'message.created':
            return [...prev, { kind: 'user', id: key(), text: p.content }];
          case 'agent.text.delta':
            if (last?.kind === 'assistant' && last.streaming) {
              return [...prev.slice(0, -1), { ...last, text: last.text + p.text }];
            }
            return [...prev, { kind: 'assistant', id: key(), text: p.text, streaming: true }];
          case 'agent.text.done':
            if (last?.kind === 'assistant' && last.streaming)
              return [...prev.slice(0, -1), { ...last, text: p.text, streaming: false }];
            return [...prev, { kind: 'assistant', id: key(), text: p.text, streaming: false }];
          case 'agent.tool.start':
            return [...prev, { kind: 'tool', id: p.toolUseId, tool: p.tool, input: p.input }];
          case 'agent.tool.end':
            return prev.map((e) =>
              e.kind === 'tool' && e.id === p.toolUseId
                ? { ...e, output: toolOutputText(p.output), isError: p.isError }
                : e
            );
          default:
            return prev;
        }
      });
    });
    return () => source.close();
  }, [sandbox]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries]);

  const reset = async () => {
    if (sandbox) await fetch(`/api/tryit/${sandbox.id}`, { method: 'DELETE' }).catch(() => undefined);
    setSandbox(null);
    setEntries([]);
    setStatus('idle');
    setError(null);
  };

  const send = async ({ text, attachments, mode }: ComposerSendPayload) => {
    setError(null);
    try {
      let current = sandbox;
      if (current && mode === 'interrupt') await api(`/api/tryit/${current.id}/interrupt`, { body: {} });
      if (!current) {
        const res = await api<{ id: string }>('/api/tryit', { body: { content, cwd, allowWrites } });
        current = { id: res.id, content, cwd, allowWrites };
        setSandbox(current);
      }
      await api(`/api/tryit/${current.id}/messages`, { body: { content: text, attachments } });
    } catch (err: any) {
      setError(err.message);
    }
  };

  const decide = async (id: string, allow: boolean) => {
    if (!sandbox) return;
    await api(`/api/tryit/${sandbox.id}/permissions/${id}`, { body: { allow } }).catch((err) => setError(err.message));
  };

  const cwdOptions = [
    ...new Set([projects?.current.path, ...(projects?.recent.map((r) => r.path) ?? [])].filter(Boolean)),
  ] as string[];
  const stale = sandbox && (sandbox.content !== content || sandbox.cwd !== cwd || sandbox.allowWrites !== allowWrites);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <span className="font-medium">{t('tryIt.sandbox')}</span>
        <label className="flex items-center gap-1">
          <span className="text-muted-foreground">cwd:</span>
          <select
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            className="max-w-[220px] rounded border border-input bg-background px-1.5 py-0.5 font-mono text-[11px]"
          >
            {cwdOptions.map((p) => (
              <option key={p} value={p}>
                {shortenPath(p, projects?.current.homeDir)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1" title={t('tryIt.allowWritesHint')}>
          <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} />
          {t('tryIt.allowWrites')}
        </label>
        <Button size="sm" variant="ghost" className="ml-auto h-7 text-[11px]" onClick={() => void reset()}>
          <RotateCcw />
          {t('tryIt.reset')}
        </Button>
      </div>
      {stale && (
        <p className="border-b border-border bg-amber-50 px-3 py-1 text-[11px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          {t('tryIt.stale')}
        </p>
      )}
      {error && (
        <p className="border-b border-border bg-red-50 px-3 py-1 text-[11px] text-red-700 dark:bg-red-950/30 dark:text-red-400">
          {error}
        </p>
      )}

      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto p-3 text-xs">
        {entries.length === 0 && <p className="text-muted-foreground">{t('tryIt.empty', { name: agentName })}</p>}
        {entries.map((e) => {
          if (e.kind === 'user')
            return (
              <div key={e.id} className="ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-primary-foreground">
                <UserMessageText text={e.text} />
              </div>
            );
          if (e.kind === 'assistant')
            return (
              <div key={e.id} className="max-w-[90%] rounded-lg border border-border bg-muted px-3 py-2">
                <div className="mb-0.5 text-[10px] font-semibold text-muted-foreground">{agentName}</div>
                <Markdown>{e.text}</Markdown>
              </div>
            );
          if (e.kind === 'tool')
            return (
              <details
                key={e.id}
                className={`rounded-md border px-2 py-1 font-mono text-[11px] ${e.isError ? 'border-red-300 text-red-700 dark:text-red-400' : 'border-border'}`}
              >
                <summary className="cursor-pointer">
                  {e.tool.replace(/^mcp__crewtree__/, '⚙ ')} {e.output === undefined ? '…' : e.isError ? '✕' : '✓'}
                </summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap">
                  {JSON.stringify(e.input, null, 2)}
                </pre>
                {e.output !== undefined && (
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap border-t border-border pt-1">
                    {e.output}
                  </pre>
                )}
              </details>
            );
          if (e.kind === 'permission')
            return (
              <div key={e.id} className="rounded-md border border-amber-400 bg-amber-50 p-2 dark:bg-amber-950/30">
                <div className="flex items-center gap-1.5 font-medium">
                  <ShieldAlert className="h-3.5 w-3.5 text-amber-600" />
                  {t('tryIt.permission', { tool: e.tool })}
                </div>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[10px]">
                  {JSON.stringify(e.input, null, 2)}
                </pre>
                {e.decided ? (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {e.allow ? t('tryIt.allowed') : t('tryIt.denied')}
                  </p>
                ) : (
                  <div className="mt-1.5 flex gap-2">
                    <Button size="sm" className="h-6 text-[11px]" onClick={() => void decide(e.id, true)}>
                      {t('tryIt.allowOnce')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[11px]"
                      onClick={() => void decide(e.id, false)}
                    >
                      {t('tryIt.deny')}
                    </Button>
                  </div>
                )}
              </div>
            );
          return (
            <p key={e.id} className="rounded-md bg-red-50 px-2 py-1 text-red-700 dark:bg-red-950/30 dark:text-red-400">
              {e.text}
            </p>
          );
        })}
        {status === 'running' && (
          <p className="text-[11px] text-muted-foreground">{t('chat.thinking', { name: agentName })}</p>
        )}
      </div>

      <div className="border-t border-border p-3">
        <Composer
          ctx={{ cwd }}
          target={agentName}
          placeholder={t('tryIt.placeholder', { name: agentName })}
          busy={status === 'running'}
          onStop={() => sandbox && void api(`/api/tryit/${sandbox.id}/interrupt`, { body: {} })}
          onSend={send}
        />
        <p className="mt-1 text-[10px] text-muted-foreground">{t('tryIt.simulatedNote')}</p>
      </div>
    </div>
  );
}
