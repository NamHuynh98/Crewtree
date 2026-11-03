// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Sparkles, Square, X } from 'lucide-react';
import type { AppSettings } from '@crewtree/shared';
import { api } from '@/lib/api';
import { postSse } from '@/lib/sse';
import { Button } from '@/components/ui/button';
import { Composer } from '@/features/composer/Composer';

export type GenerateKind = 'skill' | 'command' | 'memory' | 'mcp' | 'plugin';
export type GenerateMode = 'generate' | 'improve' | 'add-rule' | 'cleanup';

interface Props<T> {
  kind: GenerateKind;
  title: string;
  modes: Array<{ mode: GenerateMode; label: string }>;
  /** Current content for improve / add-rule / cleanup */
  current?: string;
  scopes?: Array<{ value: string; label: string }>;
  placeholder?: string;
  renderResult: (result: T) => React.ReactNode;
  onApply: (result: T, scope?: string) => Promise<unknown>;
  onClose: () => void;
}

/** AI Generate panel shared by skill/command/memory/MCP/plugin (PLAN.md 6.4, UI-WIREFRAMES 9). */
export function ConfigGenerateDialog<T>({
  kind,
  title,
  modes,
  current,
  scopes,
  placeholder,
  renderResult,
  onApply,
  onClose,
}: Props<T>) {
  const { t, i18n } = useTranslation();
  const [input, setInput] = useState<{ text: string; attachments: string[] }>({ text: '', attachments: [] });
  const [scope, setScope] = useState(scopes?.[0]?.value);
  const [streamed, setStreamed] = useState('');
  const [result, setResult] = useState<T | null>(null);
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => api<AppSettings>('/api/settings') });
  const uiLanguage = i18n.language?.startsWith('vi') ? 'vi' : 'en';
  const lang = settings?.ai.generatedContentLanguage ?? 'follow';
  const languageLabel =
    lang === 'follow'
      ? t('aiGenerate.followInterface', { language: t(`aiGenerate.lang.${uiLanguage}`) })
      : t(`aiGenerate.lang.${lang}`);

  const run = async (mode: GenerateMode) => {
    setError(null);
    setResult(null);
    setStreamed('');
    setRunning(true);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      await postSse(
        `/api/generate/${kind}`,
        { mode, description: input.text, attachments: input.attachments, current, uiLanguage },
        (event, data) => {
          if (event === 'delta') setStreamed((s) => s + data.text);
          else if (event === 'result') setResult(data.result as T);
          else if (event === 'error') setError(data.error);
        },
        abort.signal
      );
    } catch (err: any) {
      if (err?.name !== 'AbortError') setError(err.message);
    } finally {
      setRunning(false);
    }
  };

  const apply = async () => {
    if (!result) return;
    setApplying(true);
    setError(null);
    try {
      await onApply(result, scope);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onMouseDown={onClose}>
      <div
        className="flex max-h-full w-full max-w-3xl flex-col rounded-lg border border-border bg-card shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <span className="flex items-center gap-1.5 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-primary" />
            {title}
          </span>
          <button onClick={onClose} aria-label={t('actions.close')}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4 text-xs">
          <Composer
            ctx={{}}
            compact
            hideSend
            clearOnSend={false}
            enableSlash={false}
            autoFocus
            placeholder={placeholder ?? t('aiGenerate.describe')}
            onChange={setInput}
            onSend={() => void run(modes[0].mode)}
          />
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
            {scopes && (
              <span className="flex items-center gap-2">
                {t('config.scope')}:
                {scopes.map((s) => (
                  <label key={s.value} className="flex items-center gap-1">
                    <input type="radio" checked={scope === s.value} onChange={() => setScope(s.value)} />
                    {s.label}
                  </label>
                ))}
              </span>
            )}
            <span>{t('aiGenerate.outputLanguage', { language: languageLabel })}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {modes.map((m, i) => (
              <Button
                key={m.mode}
                size="sm"
                variant={i === 0 ? 'default' : 'outline'}
                disabled={running || (m.mode !== 'cleanup' && !input.text && !input.attachments.length)}
                onClick={() => void run(m.mode)}
              >
                {m.label}
              </Button>
            ))}
            {running && (
              <Button size="sm" variant="ghost" onClick={() => abortRef.current?.abort()}>
                <Square />
                {t('aiGenerate.stop')}
              </Button>
            )}
          </div>
          {error && (
            <p className="rounded-md bg-red-50 px-2 py-1.5 text-red-700 dark:bg-red-950/30 dark:text-red-400">
              {error}
            </p>
          )}
          {(running || (streamed && !result)) && (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px]">
              {streamed || '…'}
            </pre>
          )}
          {result && (
            <div className="space-y-2">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t('aiGenerate.result')}
              </div>
              {renderResult(result)}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button size="sm" disabled={!result || applying} onClick={() => void apply()}>
            {t('aiGenerate.apply')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Generated files listed with an expandable preview. */
export function FilesPreview({ files }: { files: Array<{ path: string; content: string }> }) {
  return (
    <ul className="space-y-1">
      {files.map((f) => (
        <li key={f.path}>
          <details className="rounded-md border border-border">
            <summary className="cursor-pointer px-2 py-1 font-mono">{f.path}</summary>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border p-2 font-mono text-[11px]">
              {f.content}
            </pre>
          </details>
        </li>
      ))}
    </ul>
  );
}
