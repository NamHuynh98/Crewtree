// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, FileText, Folder } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { Workspace } from '../useWorkspace';
import { FileViewer, type ViewerMode } from './FileViewer';
import { useChanges, type FileChange } from './ChangesTab';

interface Entry {
  path: string;
  type: 'file' | 'dir';
}

const STATUS_LETTER = { added: 'A', modified: 'M', deleted: 'D' } as const;

function TreeLevel({
  sessionId,
  dir,
  depth,
  changes,
  selected,
  onOpen,
}: {
  sessionId: string;
  dir: string;
  depth: number;
  changes: Map<string, FileChange>;
  selected?: string;
  onOpen: (path: string) => void;
}) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    api<{ entries: Entry[] }>(`/api/fs/tree?sessionId=${encodeURIComponent(sessionId)}&dir=${encodeURIComponent(dir)}`)
      .then((r) => setEntries(r.entries))
      .catch(() => setEntries([]));
  }, [sessionId, dir]);
  if (!entries) return null;
  return (
    <ul>
      {entries.map((e) => {
        const name = e.path.slice(dir ? dir.length + 1 : 0);
        const change = changes.get(e.path);
        const dirChanged = e.type === 'dir' && [...changes.keys()].some((p) => p.startsWith(`${e.path}/`));
        return (
          <li key={e.path}>
            <button
              type="button"
              className={cn(
                'flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-accent',
                selected === e.path && 'bg-accent font-medium'
              )}
              style={{ paddingLeft: 4 + depth * 12 }}
              onClick={() =>
                e.type === 'dir'
                  ? setOpen((prev) => {
                      const next = new Set(prev);
                      if (next.has(e.path)) next.delete(e.path);
                      else next.add(e.path);
                      return next;
                    })
                  : onOpen(e.path)
              }
            >
              {e.type === 'dir' ? (
                open.has(e.path) ? (
                  <ChevronDown className="h-3 w-3 shrink-0" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0" />
                )
              ) : (
                <span className="w-3 shrink-0 text-center text-primary">{change ? '●' : ''}</span>
              )}
              {e.type === 'dir' ? (
                <Folder className="h-3 w-3 shrink-0 text-muted-foreground" />
              ) : (
                <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              <span className={cn('truncate', dirChanged && 'text-primary')}>{name}</span>
              {change && (
                <span className="ml-auto pr-1 font-mono text-[10px] text-amber-600">
                  {STATUS_LETTER[change.status]}
                </span>
              )}
            </button>
            {e.type === 'dir' && open.has(e.path) && (
              <TreeLevel
                sessionId={sessionId}
                dir={e.path}
                depth={depth + 1}
                changes={changes}
                selected={selected}
                onOpen={onOpen}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Tab Files (UI-WIREFRAMES 6): tree, search, "only changed by agents", File Viewer. */
export function FilesTab({
  ws,
  dark,
  open,
  onOpen,
  onMention,
}: {
  ws: Workspace;
  dark: boolean;
  open: { path: string; mode: ViewerMode } | null;
  onOpen: (path: string | null, mode?: ViewerMode) => void;
  onMention: (path: string, range?: { start: number; end: number }) => void;
}) {
  const { t } = useTranslation();
  const session = ws.session!;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Entry[] | null>(null);
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [checkpoints, setCheckpoints] = useState<number[]>([]);
  const changes = useChanges(session.id, ws.subscribe);
  const changeMap = useMemo(() => new Map((changes ?? []).map((c) => [c.path, c])), [changes]);

  useEffect(() => {
    api<Array<{ n: number }>>(`/api/sessions/${session.id}/checkpoints`)
      .then((rows) => setCheckpoints(rows.map((r) => r.n)))
      .catch(() => setCheckpoints([]));
  }, [session.id]);

  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    const timer = setTimeout(() => {
      api<{ items: Entry[] }>(
        `/api/fs/search?sessionId=${encodeURIComponent(session.id)}&limit=60&q=${encodeURIComponent(query)}`
      )
        .then((r) => setResults(r.items.filter((i) => i.type === 'file')))
        .catch(() => setResults([]));
    }, 120);
    return () => clearTimeout(timer);
  }, [query, session.id]);

  const touchedBy = open ? changeMap.get(open.path) : undefined;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-64 shrink-0 flex-col border-r border-border text-xs">
        <div className="space-y-1.5 border-b border-border p-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('files.search')}
            className="w-full rounded-md border border-input bg-background px-2 py-1"
          />
          <label className="flex items-center gap-1.5 text-[11px]">
            <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />
            {t('files.onlyChanged')}
          </label>
        </div>
        <div className="flex-1 overflow-y-auto p-1">
          {results ? (
            <ul>
              {results.map((r) => (
                <li key={r.path}>
                  <button
                    type="button"
                    className="w-full truncate rounded px-1.5 py-0.5 text-left font-mono hover:bg-accent"
                    onClick={() => onOpen(r.path)}
                  >
                    {r.path}
                  </button>
                </li>
              ))}
            </ul>
          ) : onlyChanged ? (
            <ul>
              {(changes ?? []).map((c) => (
                <li key={c.path}>
                  <button
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left hover:bg-accent',
                      open?.path === c.path && 'bg-accent'
                    )}
                    onClick={() => onOpen(c.path, 'diff')}
                  >
                    <span className="font-mono text-[10px] text-amber-600">{STATUS_LETTER[c.status]}</span>
                    <span className="truncate font-mono">{c.path}</span>
                  </button>
                </li>
              ))}
              {changes && !changes.length && <li className="p-2 text-muted-foreground">{t('changes.empty')}</li>}
            </ul>
          ) : (
            <TreeLevel
              sessionId={session.id}
              dir=""
              depth={0}
              changes={changeMap}
              selected={open?.path}
              onOpen={(p) => onOpen(p)}
            />
          )}
        </div>
        <div className="border-t border-border px-2 py-1 text-[10px] text-muted-foreground">{t('files.legend')}</div>
      </div>
      {open ? (
        <FileViewer
          key={open.path}
          sessionId={session.id}
          cwd={session.cwd}
          path={open.path}
          mode={open.mode}
          dark={dark}
          checkpoints={checkpoints}
          subscribe={ws.subscribe}
          touchedBy={
            touchedBy ? { agent: touchedBy.agents.map((a) => a.name).join(', '), ts: touchedBy.lastTs } : undefined
          }
          onMode={(mode) => onOpen(open.path, mode)}
          onClose={() => onOpen(null)}
          onMention={onMention}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">{t('files.pick')}</div>
      )}
    </div>
  );
}
