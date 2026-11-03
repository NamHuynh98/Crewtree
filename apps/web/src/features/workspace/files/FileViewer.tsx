// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { Decoration, EditorView, keymap } from '@codemirror/view';
import { gotoLine } from '@codemirror/search';
import { languages } from '@codemirror/language-data';
import type { Extension } from '@codemirror/state';
import { Copy, ExternalLink, MessageSquarePlus, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/Markdown';
import { DiffView } from '@/features/resources/DiffView';
import { readFile } from '@/features/composer/sources';
import type { WorkspaceListener } from '../useWorkspace';

export type ViewerMode = 'view' | 'diff';

interface Props {
  sessionId: string;
  cwd: string;
  path: string;
  mode: ViewerMode;
  dark: boolean;
  checkpoints: number[];
  subscribe: (l: WorkspaceListener) => () => void;
  touchedBy?: { agent: string; ts: number };
  onMode: (mode: ViewerMode) => void;
  onClose: () => void;
  onMention: (path: string, range?: { start: number; end: number }) => void;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i;

function useLanguage(path: string): Extension[] {
  const [ext, setExt] = useState<Extension[]>([]);
  useEffect(() => {
    const lang = languages.find(
      (l) => l.extensions.some((e) => path.toLowerCase().endsWith(`.${e}`)) || l.filename?.test(path)
    );
    if (!lang) {
      setExt([]);
      return;
    }
    let cancelled = false;
    void lang.load().then((support) => {
      if (!cancelled) setExt([support]);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);
  return ext;
}

/** File Viewer (UI-WIREFRAMES 6, PLAN.md 9): read-only view or diff, line selection, live updates. */
export function FileViewer({
  sessionId,
  cwd,
  path,
  mode,
  dark,
  checkpoints,
  subscribe,
  touchedBy,
  onMode,
  onClose,
  onMention,
}: Props) {
  const { t } = useTranslation();
  const [file, setFile] = useState<{ content?: string; binary: boolean; tooLarge: boolean; size: number } | null>(null);
  const [diff, setDiff] = useState<{ before: string; after: string; beforeMissing: boolean } | null>(null);
  const [base, setBase] = useState<string>('session');
  const [error, setError] = useState<string | null>(null);
  const [renderMd, setRenderMd] = useState(false);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [version, setVersion] = useState(0);
  const [changedLines, setChangedLines] = useState<Set<number>>(new Set());
  const cm = useRef<ReactCodeMirrorRef>(null);
  const previous = useRef<string | undefined>(undefined);
  const language = useLanguage(path);
  const ctx = useMemo(() => ({ sessionId }), [sessionId]);

  // Live update when an agent changes this file
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === 'file.touched' && (e.payload as any)?.path === path) setVersion((v) => v + 1);
      }),
    [subscribe, path]
  );

  useEffect(() => {
    setError(null);
    readFile(ctx, path)
      .then((f) => {
        // Highlight lines that changed since the last load
        if (previous.current !== undefined && f.content !== undefined) {
          const old = previous.current.split('\n');
          const next = f.content.split('\n');
          const changed = new Set<number>();
          next.forEach((line, i) => old[i] !== line && changed.add(i + 1));
          setChangedLines(changed);
          setTimeout(() => setChangedLines(new Set()), 4000);
        }
        previous.current = f.content;
        setFile(f);
      })
      .catch((err) => setError(err.message));
  }, [ctx, path, version]);

  useEffect(() => {
    previous.current = undefined;
    setSelection(null);
    setRenderMd(false);
  }, [path]);

  useEffect(() => {
    if (mode !== 'diff') return;
    const params = new URLSearchParams({ path, sessionId, base });
    api<{ before: string; after: string; beforeMissing: boolean }>(`/api/fs/diff?${params.toString()}`)
      .then(setDiff)
      .catch((err) => setError(err.message));
  }, [mode, path, sessionId, base, version]);

  const highlight = useMemo(
    () =>
      EditorView.decorations.of((view) =>
        Decoration.set(
          [...changedLines]
            .filter((n) => n <= view.state.doc.lines)
            .sort((a, b) => a - b)
            .map((n) => lineDeco.range(view.state.doc.line(n).from))
        )
      ),
    [changedLines]
  );

  const isImage = IMAGE_EXT.test(path);
  const isMarkdown = /\.mdx?$/i.test(path);
  const rangeLabel = selection
    ? `#L${selection.start}${selection.end !== selection.start ? `-${selection.end}` : ''}`
    : '';
  const absPath = `${cwd.replace(/\/$/, '')}/${path}`;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <span className="truncate font-mono font-medium">{path}</span>
        <div className="flex rounded-md border border-border">
          {(['view', 'diff'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onMode(m)}
              className={`px-2 py-0.5 ${mode === m ? 'bg-accent font-medium' : 'text-muted-foreground'}`}
            >
              {t(`files.${m}`)}
            </button>
          ))}
        </div>
        {mode === 'diff' && (
          <label className="flex items-center gap-1 text-muted-foreground">
            {t('files.compareWith')}
            <select
              value={base}
              onChange={(e) => setBase(e.target.value)}
              className="rounded border border-input bg-background px-1 py-0.5"
            >
              <option value="session">{t('files.baseSession')}</option>
              <option value="head">HEAD</option>
              {checkpoints.map((n) => (
                <option key={n} value={`checkpoint:${n}`}>
                  {t('files.checkpoint', { n })}
                </option>
              ))}
            </select>
          </label>
        )}
        {isMarkdown && mode === 'view' && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setRenderMd((v) => !v)}
          >
            {renderMd ? t('files.source') : t('files.render')}
          </button>
        )}
        <span className="ml-auto flex items-center gap-1">
          <a
            href={`vscode://file/${absPath}${selection ? `:${selection.start}` : ''}`}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
            {t('files.openInVsCode')}
          </a>
          <button
            type="button"
            className="rounded p-1 hover:bg-accent"
            onClick={onClose}
            aria-label={t('actions.close')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
      {touchedBy && (
        <div className="border-b border-border px-3 py-1 text-[11px] text-muted-foreground">
          {t('files.editedBy', { agent: touchedBy.agent, time: new Date(touchedBy.ts).toLocaleTimeString() })}
        </div>
      )}
      {error && <p className="px-3 py-2 text-xs text-red-600">{error}</p>}
      <div className="relative min-h-0 flex-1 overflow-auto">
        {mode === 'diff' ? (
          diff ? (
            <>
              {diff.beforeMissing && <p className="px-3 py-1 text-[11px] text-muted-foreground">{t('files.noBase')}</p>}
              <DiffView before={diff.before} after={diff.after} dark={dark} language={language} fill />
            </>
          ) : (
            <p className="p-3 text-xs text-muted-foreground">{t('composer.loading')}</p>
          )
        ) : isImage ? (
          <div className="flex h-full items-center justify-center p-4">
            <img
              src={`/api/fs/raw?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`}
              alt={path}
              className="max-h-full max-w-full"
            />
          </div>
        ) : !file ? (
          <p className="p-3 text-xs text-muted-foreground">{t('composer.loading')}</p>
        ) : file.content === undefined ? (
          <p className="p-3 text-xs text-muted-foreground">
            {file.binary ? t('composer.binaryFile') : t('composer.fileTooLarge')} ({Math.round(file.size / 1024)} KB)
          </p>
        ) : renderMd ? (
          <div className="p-4 text-sm">
            <Markdown>{file.content}</Markdown>
          </div>
        ) : (
          <CodeMirror
            ref={cm}
            value={file.content}
            editable={false}
            theme={dark ? 'dark' : 'light'}
            extensions={[...language, highlight, goToLineKey, EditorView.theme({ '&': { fontSize: '12px' } })]}
            basicSetup={{ foldGutter: false, highlightActiveLine: false }}
            onUpdate={(u) => {
              if (!u.selectionSet) return;
              const sel = u.state.selection.main;
              if (sel.empty) return setSelection(null);
              const start = u.state.doc.lineAt(sel.from).number;
              const end = u.state.doc.lineAt(sel.to).number;
              setSelection({ start, end });
            }}
          />
        )}
        {selection && mode === 'view' && (
          <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 gap-1 rounded-md border border-border bg-popover p-1 shadow-lg">
            <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => onMention(path, selection)}>
              <MessageSquarePlus />
              {t('files.mention')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[11px]"
              onClick={() => void navigator.clipboard?.writeText(`${path}${rangeLabel}`)}
            >
              <Copy />
              {t('files.copyPath', { range: rangeLabel })}
            </Button>
          </div>
        )}
      </div>
      <div className="border-t border-border px-3 py-1 text-[10px] text-muted-foreground">{t('files.keysHint')}</div>
    </div>
  );
}

// Ctrl+G go to line (UI-WIREFRAMES 6); Ctrl+F comes with the basic setup
const goToLineKey = keymap.of([{ key: 'Mod-g', run: gotoLine, preventDefault: true }]);
const lineDeco = Decoration.line({ attributes: { style: 'background-color: rgba(250, 204, 21, 0.18)' } });
