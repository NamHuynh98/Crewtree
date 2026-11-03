// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { languages } from '@codemirror/language-data';
import { markdown } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import type { Extension } from '@codemirror/state';
import { History, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useIsDark } from '@/lib/useIsDark';
import { Button } from '@/components/ui/button';
import { DiffView } from '@/features/resources/DiffView';
import type { RevisionMeta } from '@/features/resources/types';

function useLanguage(path: string): Extension[] {
  const [ext, setExt] = useState<Extension[]>([]);
  useEffect(() => {
    if (/\.mdx?$/i.test(path)) {
      setExt([yamlFrontmatter({ content: markdown() })]);
      return;
    }
    const lang = languages.find((l) => l.extensions.some((e) => path.toLowerCase().endsWith(`.${e}`)));
    if (!lang) {
      setExt([]);
      return;
    }
    let cancelled = false;
    void lang.load().then((support) => !cancelled && setExt([support]));
    return () => {
      cancelled = true;
    };
  }, [path]);
  return ext;
}

const theme = EditorView.theme({
  '&': { fontSize: '12px', height: '100%' },
  '.cm-scroller': { fontFamily: '"JetBrains Mono Variable", monospace' },
});

/**
 * Editor of one config file (UI-WIREFRAMES 9/10): unsaved marker, diff review before every save
 * (PLAN.md 6.3), history with diff and rollback.
 */
export function FileEditor({
  path,
  value,
  original,
  readOnly,
  onChange,
  onSave,
  revisions = [],
  onRollback,
  extraActions,
  isNew,
}: {
  path: string;
  value: string;
  original: string;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onSave: (value: string) => Promise<unknown>;
  revisions?: RevisionMeta[];
  onRollback?: (revisionId: string) => Promise<unknown>;
  extraActions?: React.ReactNode;
  isNew?: boolean;
}) {
  const { t } = useTranslation();
  const dark = useIsDark();
  const language = useLanguage(path);
  const [reviewing, setReviewing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [revision, setRevision] = useState<{ id: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = isNew || value !== original;
  const extensions = useMemo(() => [...language, EditorView.lineWrapping, theme], [language]);

  useEffect(() => {
    setRevision(null);
    setHistoryOpen(false);
  }, [path]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(value);
      setReviewing(false);
    } catch (err: any) {
      setError(err.message);
      setReviewing(false);
    } finally {
      setBusy(false);
    }
  };

  const openRevision = async (id: string) => {
    try {
      const rev = await api<{ content: string }>(`/api/revisions/${id}`);
      setRevision({ id, content: rev.content });
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <span className="truncate font-mono text-muted-foreground">{path}</span>
        {!readOnly && dirty && !isNew && (
          <span className="text-amber-600 dark:text-amber-400">● {t('editor.unsaved')}</span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {extraActions}
          {revisions.length > 0 && (
            <Button
              size="sm"
              variant={historyOpen ? 'secondary' : 'ghost'}
              className="h-7 text-[11px]"
              onClick={() => setHistoryOpen((v) => !v)}
            >
              <History />
              {t('editor.history')}
            </Button>
          )}
          {!readOnly && (
            <Button size="sm" className="h-7 text-[11px]" disabled={!dirty} onClick={() => setReviewing(true)}>
              {t('actions.save')}
            </Button>
          )}
        </span>
      </div>
      {error && (
        <p className="border-b border-border bg-red-50 px-3 py-1 text-[11px] text-red-700 dark:bg-red-950/30 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto">
          {revision ? (
            <div className="flex h-full flex-col">
              <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-[11px]">
                <span className="text-muted-foreground">{t('editor.diffHint')}</span>
                <span className="ml-auto flex gap-1">
                  {onRollback && !readOnly && (
                    <Button
                      size="sm"
                      className="h-6 text-[11px]"
                      disabled={revision.content === original}
                      onClick={async () => {
                        try {
                          await onRollback(revision.id);
                          setRevision(null);
                        } catch (err: any) {
                          setError(err.message);
                        }
                      }}
                    >
                      {t('editor.rollback')}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setRevision(null)}>
                    <X />
                  </Button>
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <DiffView before={original} after={revision.content} dark={dark} language={language} fill />
              </div>
            </div>
          ) : (
            <CodeMirror
              value={value}
              height="100%"
              className="h-full"
              theme={dark ? 'dark' : 'light'}
              extensions={extensions}
              editable={!readOnly}
              basicSetup={{ foldGutter: false }}
              onChange={onChange}
            />
          )}
        </div>
        {historyOpen && (
          <ul className="w-52 shrink-0 space-y-0.5 overflow-y-auto border-l border-border p-2 text-xs">
            {revisions.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => void openRevision(r.id)}
                  className={`w-full rounded px-2 py-1 text-left hover:bg-accent ${revision?.id === r.id ? 'bg-accent' : ''}`}
                >
                  <div className="font-medium">{t(`revision.${r.action}`)}</div>
                  <div className="text-[10px] text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {reviewing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
          <div className="flex max-h-full w-full max-w-5xl flex-col rounded-lg border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <span className="text-sm font-semibold">
                {isNew ? t('config.reviewNew', { path }) : t('editor.reviewChanges')}
              </span>
              <button onClick={() => setReviewing(false)} aria-label={t('actions.cancel')}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-3">
              <DiffView before={isNew ? '' : original} after={value} dark={dark} language={language} />
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
              <Button size="sm" variant="ghost" onClick={() => setReviewing(false)}>
                {t('actions.cancel')}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                {t('editor.confirmSave')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
