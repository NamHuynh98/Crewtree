// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import { EditorView } from '@codemirror/view';
import { ArrowLeft, Copy, Sparkles, Play, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ScopeBadge } from '@/features/resources/ScopeBadge';
import { DiffView } from '@/features/resources/DiffView';
import { ModelPicker } from '@/features/model-picker/ModelPicker';
import {
  AGENT_COLORS,
  EDITOR_TOOLS,
  newAgentTemplate,
  patchAgentFile,
  readAgentFields,
} from '@/features/resources/agentFile';
import {
  WRITABLE_SCOPES,
  type ResourceDetail,
  type ResourceItem,
  type WritableScope,
} from '@/features/resources/types';
import { useAgents } from './AgentsPage';

type Tab = 'ai' | 'try' | 'file' | 'history';

const SWATCH: Record<string, string> = {
  violet: 'bg-violet-500',
  blue: 'bg-blue-500',
  cyan: 'bg-cyan-500',
  green: 'bg-emerald-500',
  yellow: 'bg-yellow-500',
  orange: 'bg-orange-500',
  red: 'bg-red-500',
  pink: 'bg-pink-500',
};

const inputClass = 'w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs';
const sectionTitle = 'text-[10px] font-semibold uppercase tracking-wider text-muted-foreground';

function useIsDark() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** Chips editor for string lists (delegates, skills, MCP servers). */
function Chips({
  values,
  options,
  onChange,
  placeholder,
}: {
  values: string[];
  options: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {values.map((v) => (
        <span
          key={v}
          className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 text-[11px]"
        >
          {v}
          <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`remove ${v}`}>
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <select
        value=""
        onChange={(e) => e.target.value && onChange([...values, e.target.value])}
        className="rounded border border-input bg-background px-1.5 py-0.5 text-[11px]"
        aria-label={placeholder}
      >
        <option value="">+ {placeholder}</option>
        {options
          .filter((o) => !values.includes(o))
          .map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
      </select>
    </div>
  );
}

/** Agent Editor (UI-WIREFRAMES 8). The .md file is the single source of truth; the form edits it in place. */
export function AgentEditorPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const dark = useIsDark();
  const [tab, setTab] = useState<Tab>((searchParams.get('tab') as Tab) || 'file');
  const [scope, setScope] = useState<WritableScope>((searchParams.get('scope') as WritableScope) || 'user');
  const [content, setContent] = useState(isNew ? newAgentTemplate() : '');
  const [original, setOriginal] = useState(isNew ? newAgentTemplate() : '');
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);

  const { data: detail, refetch } = useQuery({
    queryKey: ['resources', 'agent', id],
    queryFn: () => api<ResourceDetail>(`/api/resources/agents/${id}`),
    enabled: !isNew,
  });
  const { data: agents = [] } = useAgents();
  const { data: skills = [] } = useQuery({
    queryKey: ['resources', 'skills'],
    queryFn: () => api<ResourceItem[]>('/api/resources/skills'),
  });
  const { data: mcp = [] } = useQuery({
    queryKey: ['resources', 'mcp'],
    queryFn: () => api<ResourceItem[]>('/api/resources/mcp'),
  });
  const { data: revision } = useQuery({
    queryKey: ['resources', 'revision', revisionId],
    queryFn: () =>
      api<{ content: string; action: string; createdAt: number }>(
        `/api/resources/agents/${id}/revisions/${revisionId}`
      ),
    enabled: !!revisionId,
  });

  const hasChanges = isNew ? content !== newAgentTemplate() : content !== original;
  const readOnly = !!detail?.readOnly;
  // Set right before navigating after a successful save, so the "discard?" guard does not fire
  const leavingAfterSave = useRef(false);

  useEffect(() => {
    leavingAfterSave.current = false;
  }, [id]);

  // Load the file; keep local edits when the file changes on disk while editing
  useEffect(() => {
    if (detail?.content === undefined) return;
    if (content === original) setContent(detail.content);
    setOriginal(detail.content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.content]);

  // "Discard unsaved changes?" when leaving (UI-WIREFRAMES 8)
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      hasChanges && !leavingAfterSave.current && currentLocation.pathname !== nextLocation.pathname
  );
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasChanges) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasChanges]);

  const { fields, body, error: yamlError } = useMemo(() => readAgentFields(content), [content]);
  const set = (patch: Parameters<typeof patchAgentFile>[1]) => setContent((c) => patchAgentFile(c, patch));
  const delegateOptions = agents.filter((a) => a.path && a.name !== fields.name).map((a) => a.name);
  const uniq = (xs: string[]) => [...new Set(xs)];

  const save = async () => {
    setError(null);
    try {
      if (isNew) {
        const res = await api<{ item: ResourceItem }>('/api/resources/agents', { body: { scope, content } });
        setReviewing(false);
        await queryClient.invalidateQueries({ queryKey: ['resources'] });
        leavingAfterSave.current = true;
        navigate(`/agents/${res.item.id}`, { replace: true });
        return;
      }
      const res = await api<{ item: ResourceItem }>(`/api/resources/agents/${id}`, {
        method: 'PUT',
        body: { content },
      });
      setOriginal(content);
      setReviewing(false);
      await queryClient.invalidateQueries({ queryKey: ['resources'] });
      if (res.item.id !== id) {
        leavingAfterSave.current = true;
        navigate(`/agents/${res.item.id}`, { replace: true });
      } else void refetch();
    } catch (err: any) {
      setReviewing(false);
      setError(err.message);
    }
  };

  const rollback = async () => {
    if (!revisionId) return;
    setError(null);
    try {
      const res = await api<{ item: ResourceItem }>(`/api/resources/agents/${id}/rollback`, { body: { revisionId } });
      setRevisionId(null);
      await queryClient.invalidateQueries({ queryKey: ['resources'] });
      if (res.item.id !== id) {
        leavingAfterSave.current = true;
        navigate(`/agents/${res.item.id}`, { replace: true });
      } else {
        const fresh = await refetch();
        if (fresh.data?.content !== undefined) {
          setContent(fresh.data.content);
          setOriginal(fresh.data.content);
        }
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  const duplicate = async () => {
    try {
      const res = await api<{ item: ResourceItem }>(`/api/resources/agents/${id}/duplicate`, { body: {} });
      await queryClient.invalidateQueries({ queryKey: ['resources'] });
      navigate(`/agents/${res.item.id}`);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const tabButton = (value: Tab, label: React.ReactNode, disabled = false, title?: string) => (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={() => setTab(value)}
      className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs ${
        tab === value ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent'
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {label}
    </button>
  );

  const editorTheme = EditorView.theme({
    '&': { fontSize: '12px' },
    '.cm-content': { fontFamily: '"JetBrains Mono Variable", monospace' },
  });

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      {/* Header: ◀ Agents / name · scope · Unsaved · Save */}
      <div className="flex h-11 items-center gap-3 border-b border-border bg-card px-4">
        <Link to="/agents" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          {t('agents')}
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="text-sm font-semibold">{fields.name || t('editor.untitled')}</span>
        {isNew ? (
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as WritableScope)}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs"
            aria-label={t('editor.scope')}
          >
            {WRITABLE_SCOPES.map((s) => (
              <option key={s} value={s}>
                {t(`scope.${s}`)}
              </option>
            ))}
          </select>
        ) : (
          detail && <ScopeBadge scope={detail.scope} plugin={detail.plugin} readOnly={detail.readOnly} />
        )}
        {!readOnly && hasChanges && !isNew && (
          <span className="text-xs text-amber-600 dark:text-amber-400">● {t('editor.unsaved')}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {detail?.path && (
            <span className="hidden font-mono text-[10px] text-muted-foreground lg:inline">{detail.path}</span>
          )}
          {readOnly ? (
            detail?.path && (
              <Button size="sm" variant="outline" onClick={() => void duplicate()}>
                <Copy />
                {t('agentsPage.duplicateAsMine')}
              </Button>
            )
          ) : (
            <Button
              size="sm"
              disabled={(!isNew && content === original) || !!yamlError}
              onClick={() => setReviewing(true)}
            >
              {t('actions.save')}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <p className="border-b border-border bg-red-50 px-4 py-1.5 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Left: form + system prompt */}
        <fieldset
          disabled={readOnly}
          className="flex w-1/2 min-w-[380px] flex-col overflow-y-auto border-r border-border p-4"
        >
          <div className="space-y-4">
            <section className="space-y-2">
              <div className={sectionTitle}>{t('editor.basics')}</div>
              <label className="block space-y-1 text-xs">
                <span>{t('editor.name')}</span>
                <input
                  className={`${inputClass} font-mono`}
                  value={fields.name}
                  onChange={(e) => set({ name: e.target.value })}
                />
              </label>
              <div className="flex items-center gap-1.5 text-xs">
                <span className="mr-1">{t('editor.color')}</span>
                {AGENT_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => set({ color: fields.color === c ? null : c })}
                    className={`h-4 w-4 rounded-full ${SWATCH[c]} ${fields.color === c ? 'ring-2 ring-ring ring-offset-2 ring-offset-background' : ''}`}
                    aria-label={c}
                    title={c}
                  />
                ))}
              </div>
              <label className="block space-y-1 text-xs">
                <span title={t('editor.descriptionHint')}>{t('editor.description')} ⓘ</span>
                <textarea
                  className={`${inputClass} min-h-[56px]`}
                  value={fields.description}
                  onChange={(e) => set({ description: e.target.value })}
                />
              </label>
            </section>

            <section className="space-y-2">
              <div className={sectionTitle}>{t('editor.model')}</div>
              <ModelPicker value={fields.model} onChange={(model) => set({ model: model ?? null })} />
              <label className="flex items-center gap-2 text-xs">
                <span>{t('editor.maxTurns')}</span>
                <input
                  type="number"
                  min={1}
                  className={`${inputClass} w-24`}
                  value={fields.maxTurns ?? ''}
                  onChange={(e) => set({ maxTurns: e.target.value ? Number(e.target.value) : null })}
                />
              </label>
            </section>

            <section className="space-y-2">
              <div className={sectionTitle}>{t('editor.delegation')}</div>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={fields.canDelegate}
                  onChange={(e) => set({ canDelegate: e.target.checked })}
                />
                {t('editor.canDelegate')}
              </label>
              {fields.canDelegate && (
                <div className="space-y-1.5 text-xs">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={fields.delegates === '*'}
                      onChange={(e) => set({ delegates: e.target.checked ? '*' : [] })}
                    />
                    {t('editor.delegatesAny')}
                  </label>
                  {fields.delegates !== '*' && (
                    <Chips
                      values={fields.delegates}
                      options={uniq(delegateOptions)}
                      onChange={(v) => set({ delegates: v })}
                      placeholder={t('editor.addDelegate')}
                    />
                  )}
                </div>
              )}
            </section>

            <section className="space-y-2">
              <div className={sectionTitle}>{t('editor.tools')}</div>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={fields.tools === undefined}
                  onChange={(e) => set({ tools: e.target.checked ? null : ['Read', 'Grep', 'Glob'] })}
                />
                {t('editor.inheritTools')}
              </label>
              {fields.tools !== undefined && (
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  {uniq([...EDITOR_TOOLS, ...fields.tools]).map((tool) => (
                    <label key={tool} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={fields.tools!.includes(tool)}
                        onChange={(e) =>
                          set({
                            tools: e.target.checked
                              ? [...fields.tools!, tool]
                              : fields.tools!.filter((x) => x !== tool),
                          })
                        }
                      />
                      {tool}
                    </label>
                  ))}
                </div>
              )}
              <p className="text-[10px] text-muted-foreground">{t('editor.toolsHint')}</p>
              <div className="space-y-1 text-xs">
                <span>{t('skills')}</span>
                <Chips
                  values={fields.skills}
                  options={uniq(skills.map((s) => s.name))}
                  onChange={(v) => set({ skills: v })}
                  placeholder={t('editor.addSkill')}
                />
              </div>
              <div className="space-y-1 text-xs">
                <span>{t('mcp')}</span>
                <Chips
                  values={fields.mcpServers}
                  options={uniq(mcp.map((m) => m.name))}
                  onChange={(v) => set({ mcpServers: v })}
                  placeholder={t('editor.addMcp')}
                />
              </div>
            </section>

            <section className="space-y-1.5">
              <div className={sectionTitle}>{t('editor.advanced')}</div>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={fields.role === 'supervisor'}
                  onChange={(e) => set({ role: e.target.checked ? 'supervisor' : null })}
                />
                {t('editor.roleSupervisor')}
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={fields.freshContextPerTask}
                  onChange={(e) => set({ freshContextPerTask: e.target.checked })}
                />
                {t('editor.freshContext')}
              </label>
            </section>

            <section className="space-y-1.5">
              <div className={sectionTitle}>{t('editor.systemPrompt')}</div>
              <div className="overflow-hidden rounded-md border border-input">
                <CodeMirror
                  value={body}
                  theme={dark ? 'dark' : 'light'}
                  extensions={[markdown(), EditorView.lineWrapping, editorTheme]}
                  editable={!readOnly}
                  minHeight="220px"
                  basicSetup={{ foldGutter: false }}
                  onChange={(value) => set({ body: value })}
                />
              </div>
            </section>
          </div>
        </fieldset>

        {/* Right: AI · Try it · .md file · History */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex items-center gap-1 border-b border-border px-3 py-2">
            {tabButton(
              'ai',
              <>
                <Sparkles className="h-3.5 w-3.5" />
                {t('editor.generate')}
              </>,
              true,
              t('editor.comingPhase4')
            )}
            {tabButton(
              'try',
              <>
                <Play className="h-3.5 w-3.5" />
                {t('editor.tryIt')}
              </>,
              true,
              t('editor.comingPhase4')
            )}
            {tabButton('file', t('editor.mdFile'))}
            {!isNew && tabButton('history', t('editor.history'))}
          </div>

          {tab === 'file' && (
            <div className="flex flex-1 flex-col overflow-hidden p-3">
              {yamlError && (
                <p className="mb-2 text-[11px] text-red-600 dark:text-red-400">
                  {t('editor.invalidYaml', { error: yamlError })}
                </p>
              )}
              <div className="flex-1 overflow-auto rounded-md border border-input">
                <CodeMirror
                  value={content}
                  theme={dark ? 'dark' : 'light'}
                  extensions={[yamlFrontmatter({ content: markdown() }), EditorView.lineWrapping, editorTheme]}
                  editable={!readOnly}
                  basicSetup={{ foldGutter: false }}
                  onChange={setContent}
                />
              </div>
            </div>
          )}

          {tab === 'history' && detail && (
            <div className="flex flex-1 overflow-hidden">
              <ul className="w-56 shrink-0 space-y-0.5 overflow-y-auto border-r border-border p-2 text-xs">
                {detail.revisions.length === 0 && (
                  <li className="p-2 text-muted-foreground">{t('editor.noHistory')}</li>
                )}
                {detail.revisions.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setRevisionId(r.id)}
                      className={`w-full rounded px-2 py-1.5 text-left hover:bg-accent ${revisionId === r.id ? 'bg-accent' : ''}`}
                    >
                      <div className="font-medium">{t(`revision.${r.action}`)}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {new Date(r.createdAt).toLocaleString()} · {t(`scope.${r.scope}`)}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="flex flex-1 flex-col overflow-hidden p-3">
                {revision ? (
                  <>
                    <div className="mb-2 flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground">{t('editor.diffHint')}</span>
                      {!readOnly && (
                        <Button
                          size="sm"
                          className="ml-auto h-7 text-[11px]"
                          disabled={revision.content === original}
                          onClick={() => void rollback()}
                        >
                          {t('editor.rollback')}
                        </Button>
                      )}
                    </div>
                    <div className="flex-1 overflow-auto rounded-md border border-input">
                      <DiffView before={original} after={revision.content} dark={dark} />
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">{t('editor.pickRevision')}</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Review the diff before saving (PLAN.md 6.3) */}
      {reviewing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
          <div className="flex max-h-full w-full max-w-5xl flex-col rounded-lg border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <span className="text-sm font-semibold">
                {isNew ? t('editor.reviewNew', { scope: t(`scope.${scope}`) }) : t('editor.reviewChanges')}
              </span>
              <button onClick={() => setReviewing(false)} aria-label={t('actions.cancel')}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-3">
              <DiffView before={isNew ? '' : original} after={content} dark={dark} />
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
              <Button size="sm" variant="ghost" onClick={() => setReviewing(false)}>
                {t('actions.cancel')}
              </Button>
              <Button size="sm" onClick={() => void save()}>
                {t('editor.confirmSave')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {blocker.state === 'blocked' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
          <div className="w-full max-w-sm space-y-3 rounded-lg border border-border bg-card p-4 shadow-xl">
            <p className="text-sm">{t('editor.discardQuestion')}</p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => blocker.reset()}>
                {t('editor.keepEditing')}
              </Button>
              <Button size="sm" variant="destructive" onClick={() => blocker.proceed()}>
                {t('editor.discard')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
