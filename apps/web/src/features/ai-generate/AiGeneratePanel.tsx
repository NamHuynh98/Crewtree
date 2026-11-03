// SPDX-License-Identifier: Apache-2.0
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Sparkles, Square, Wand2 } from 'lucide-react';
import type { AppSettings, GeneratedAgent } from '@crewtree/shared';
import { api } from '@/lib/api';
import { postSse } from '@/lib/sse';
import { Button } from '@/components/ui/button';
import { Composer } from '@/features/composer/Composer';
import { DiffView } from '@/features/resources/DiffView';
import { patchAgentFile } from '@/features/resources/agentFile';
import { modelLabel } from '@/features/model-picker/models';
import { useModelCatalog } from '@/features/model-picker/ModelPicker';

interface Props {
  /** Current .md content in the editor */
  current: string;
  onApply: (content: string) => void;
  dark: boolean;
  disabled?: boolean;
}

/** The editor content with a generated definition applied (form fields + system prompt). */
export function applyGeneratedAgent(current: string, agent: GeneratedAgent): string {
  return patchAgentFile(current, {
    name: agent.name,
    description: agent.description,
    model: agent.suggestedModel || null,
    tools: agent.suggestedTools.length ? agent.suggestedTools : null,
    canDelegate: agent.canDelegate,
    delegates: agent.canDelegate ? agent.delegates : null,
    body: agent.systemPrompt,
  });
}

/** AI Generate for agents (PLAN.md 6.4, UI-WIREFRAMES 8): describe → stream → diff → Apply. */
export function AiGeneratePanel({ current, onApply, dark, disabled }: Props) {
  const { t, i18n } = useTranslation();
  const [input, setInput] = useState<{ text: string; attachments: string[] }>({ text: '', attachments: [] });
  const [streamed, setStreamed] = useState('');
  const [result, setResult] = useState<{ agent: GeneratedAgent; model: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const { data: catalog } = useModelCatalog();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => api<AppSettings>('/api/settings') });
  const uiLanguage = i18n.language?.startsWith('vi') ? 'vi' : 'en';
  const languageSetting = settings?.ai.generatedContentLanguage ?? 'follow';
  const languageLabel =
    languageSetting === 'follow'
      ? t('aiGenerate.followInterface', { language: t(`aiGenerate.lang.${uiLanguage}`) })
      : t(`aiGenerate.lang.${languageSetting}`);

  const applied = useMemo(() => (result ? applyGeneratedAgent(current, result.agent) : ''), [current, result]);

  const run = async (mode: 'generate' | 'improve') => {
    setError(null);
    setResult(null);
    setStreamed('');
    setShowDiff(false);
    setRunning(true);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      await postSse(
        '/api/generate/agent',
        {
          mode,
          description: input.text,
          attachments: input.attachments,
          current: mode === 'improve' ? current : undefined,
          uiLanguage,
        },
        (event, data) => {
          if (event === 'delta') setStreamed((s) => s + data.text);
          else if (event === 'result') setResult({ agent: data.agent, model: data.model });
          else if (event === 'error') setError(data.error);
        },
        abort.signal
      );
    } catch (err: any) {
      if (err?.name !== 'AbortError') setError(err.message);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const canGenerate = !running && !disabled && (!!input.text || input.attachments.length > 0);

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{t('aiGenerate.describe')}</p>
        <Composer
          ctx={{}}
          compact
          hideSend
          clearOnSend={false}
          enableSlash={false}
          disabled={disabled}
          placeholder={t('aiGenerate.placeholder')}
          onChange={setInput}
          onSend={() => (canGenerate ? run('generate') : undefined)}
        />
        <p className="text-[10px] text-muted-foreground">
          {t('aiGenerate.outputLanguage', { language: languageLabel })}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!canGenerate} onClick={() => void run('generate')}>
            <Sparkles />
            {t('aiGenerate.generateNew')}
          </Button>
          <Button size="sm" variant="outline" disabled={running || disabled} onClick={() => void run('improve')}>
            <Wand2 />
            {t('aiGenerate.improve')}
          </Button>
          {running && (
            <Button size="sm" variant="ghost" onClick={() => abortRef.current?.abort()}>
              <Square />
              {t('aiGenerate.stop')}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <p className="rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-400">
          {error}
        </p>
      )}

      {(running || (streamed && !result)) && (
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t('aiGenerate.streaming')}
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px]">
            {streamed || '…'}
          </pre>
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t('aiGenerate.result')}
            <span className="font-normal normal-case tracking-normal">· {modelLabel(result.model, catalog)}</span>
          </div>
          <dl className="grid grid-cols-[110px_1fr] gap-x-2 gap-y-1 rounded-md border border-border p-2 text-xs">
            <dt className="text-muted-foreground">name</dt>
            <dd className="font-mono">{result.agent.name}</dd>
            <dt className="text-muted-foreground">description</dt>
            <dd>{result.agent.description}</dd>
            <dt className="text-muted-foreground">{t('aiGenerate.tools')}</dt>
            <dd className="font-mono">{result.agent.suggestedTools.join(', ') || '—'}</dd>
            <dt className="text-muted-foreground">model</dt>
            <dd className="font-mono">{result.agent.suggestedModel ?? 'inherit'}</dd>
            <dt className="text-muted-foreground">canDelegate</dt>
            <dd className="font-mono">
              {String(result.agent.canDelegate)}
              {result.agent.canDelegate &&
                ` → ${result.agent.delegates === '*' ? t('editor.delegatesAny') : result.agent.delegates.join(', ')}`}
            </dd>
            <dt className="text-muted-foreground">system prompt</dt>
            <dd className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px]">
              {result.agent.systemPrompt}
            </dd>
          </dl>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setShowDiff((v) => !v)}>
              {showDiff ? t('aiGenerate.hideDiff') : t('aiGenerate.viewDiff')}
            </Button>
            <Button
              size="sm"
              disabled={disabled || applied === current}
              onClick={() => {
                onApply(applied);
                setResult(null);
                setStreamed('');
              }}
            >
              {t('aiGenerate.apply')}
            </Button>
          </div>
          {showDiff && (
            <div className="overflow-auto rounded-md border border-input">
              <DiffView before={current} after={applied} dark={dark} />
            </div>
          )}
          <p className="text-[10px] text-muted-foreground">{t('aiGenerate.applyHint')}</p>
        </div>
      )}
    </div>
  );
}
