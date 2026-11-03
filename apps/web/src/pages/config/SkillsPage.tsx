// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { FilePlus, FileText, Folder, Plus, Sparkles, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScopeBadge } from '@/features/resources/ScopeBadge';
import type { ResourceDetail, ResourceItem } from '@/features/resources/types';
import { ConfigHeader, ConfigList, Empty, useInvalidateResources, useResourceList } from '@/features/config/ConfigList';
import { FileEditor } from '@/features/config/FileEditor';
import { ConfigGenerateDialog, FilesPreview } from '@/features/config/ConfigGenerateDialog';
import { NewResourceDialog } from '@/features/config/NewResourceDialog';

interface SkillDetail extends ResourceDetail {
  files: Array<{ path: string; type: 'file' | 'dir'; size?: number }>;
  usedBy: string[];
}

interface GeneratedSkill {
  name: string;
  description: string;
  files: Array<{ path: string; content: string }>;
}

function skillTemplate(name: string, description: string) {
  return `---\nname: ${name}\ndescription: ${description || 'Describe what the skill does and when to use it.'}\n---\n# ${name}\n\n1. …\n`;
}

/** Skills (UI-WIREFRAMES 9): list, file tree, editor with history, AI create. */
export function SkillsPage() {
  const { t } = useTranslation();
  const { data: items = [] } = useResourceList('skills');
  const invalidate = useInvalidateResources();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const selected = items.find((i) => i.id === selectedId);

  useEffect(() => {
    if (!selectedId && items.length) setSelectedId(items.find((i) => !i.readOnly)?.id ?? items[0].id);
  }, [items, selectedId]);

  const createSkill = async (scope: string, files: Array<{ path: string; content: string }>) => {
    const res = await api<{ item: ResourceItem }>('/api/resources/skills', { body: { scope, files } });
    await invalidate();
    setSelectedId(res.item.id);
  };

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      <ConfigHeader
        title={t('skills')}
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setGenerating(true)}>
              <Sparkles />
              {t('config.createWithAi')}
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              {t('config.new')}
            </Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <ConfigList items={items} selectedId={selectedId} onSelect={(i) => setSelectedId(i.id)} />
        {selected ? (
          <SkillDetailView key={selected.id} item={selected} onDeleted={() => setSelectedId(undefined)} />
        ) : (
          <Empty text={t('config.pickSkill')} />
        )}
      </div>
      {creating && (
        <NewResourceDialog
          title={t('config.newSkill')}
          withDescription
          onClose={() => setCreating(false)}
          onCreate={async ({ name, description, scope }) => {
            await createSkill(scope, [{ path: 'SKILL.md', content: skillTemplate(name, description) }]);
            setCreating(false);
          }}
        />
      )}
      {generating && (
        <ConfigGenerateDialog<GeneratedSkill>
          kind="skill"
          title={t('config.createSkillAi')}
          placeholder={t('config.skillPlaceholder')}
          modes={[{ mode: 'generate', label: t('aiGenerate.generateNew') }]}
          scopes={[
            { value: 'project', label: t('scope.project') },
            { value: 'user', label: t('scope.user') },
          ]}
          renderResult={(r) => (
            <div className="space-y-1">
              <div>
                <span className="font-mono font-semibold">{r.name}/</span> — {r.description}
              </div>
              <FilesPreview files={r.files} />
            </div>
          )}
          onApply={async (r, scope) => {
            await createSkill(scope ?? 'project', r.files);
            setGenerating(false);
          }}
          onClose={() => setGenerating(false)}
        />
      )}
    </main>
  );
}

function SkillDetailView({ item, onDeleted }: { item: ResourceItem; onDeleted: () => void }) {
  const { t } = useTranslation();
  const invalidate = useInvalidateResources();
  const { data: detail, refetch } = useQuery({
    queryKey: ['resources', 'skill', item.id],
    queryFn: () => api<SkillDetail>(`/api/resources/skills/${item.id}`),
  });
  const [file, setFile] = useState('SKILL.md');
  const [newFile, setNewFile] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ path: string; value: string; original: string; isNew?: boolean } | null>(null);
  const [revisions, setRevisions] = useState<ResourceDetail['revisions']>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the selected file (SKILL.md comes with the detail)
  useEffect(() => {
    if (!detail) return;
    if (draft?.isNew && draft.path === file) return;
    let cancelled = false;
    api<{ content?: string; binary: boolean; revisions: ResourceDetail['revisions'] }>(
      `/api/resources/skills/${item.id}/file?path=${encodeURIComponent(file)}`
    )
      .then((f) => {
        if (cancelled) return;
        setDraft((d) =>
          d && d.path === file && d.value !== d.original
            ? { ...d, original: f.content ?? '' }
            : { path: file, value: f.content ?? '', original: f.content ?? '' }
        );
        setRevisions(f.revisions);
      })
      .catch((err) => setError(err.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, file, item.id]);

  const save = async (value: string) => {
    await api(`/api/resources/skills/${item.id}`, { method: 'PUT', body: { path: file, content: value } });
    setDraft({ path: file, value, original: value });
    await invalidate();
    await refetch();
  };

  const files = detail?.files ?? [];
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
        <span className="text-sm font-semibold">{item.name}</span>
        <ScopeBadge scope={item.scope} plugin={item.plugin} readOnly={item.readOnly} />
        {item.metadata.linkTarget && (
          <span className="font-mono text-[10px] text-muted-foreground">→ {item.metadata.linkTarget}</span>
        )}
        <span className="ml-auto text-muted-foreground">
          {t('config.usedBy')}: {detail?.usedBy.length ? detail.usedBy.join(', ') : '—'}
        </span>
        {!item.readOnly &&
          (confirmDelete ? (
            <>
              <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => setConfirmDelete(false)}>
                {t('actions.cancel')}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="h-7 text-[11px]"
                onClick={async () => {
                  try {
                    await api(`/api/resources/skills/${item.id}`, { method: 'DELETE' });
                    await invalidate();
                    onDeleted();
                  } catch (err: any) {
                    setError(err.message);
                  }
                }}
              >
                {t('config.confirmDeleteSkill')}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px] text-red-600"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 />
              {t('actions.delete')}
            </Button>
          ))}
      </div>
      <div className="border-b border-border px-4 py-1.5 text-[11px]">
        <span className="text-muted-foreground" title={t('config.descriptionHint')}>
          {t('config.description')} ⓘ:
        </span>{' '}
        {item.description || '—'}
      </div>
      {error && (
        <p className="border-b border-border bg-red-50 px-4 py-1 text-[11px] text-red-700 dark:bg-red-950/30 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="flex w-52 shrink-0 flex-col border-r border-border text-xs">
          <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t('config.files')}
          </div>
          <ul className="flex-1 overflow-y-auto px-1">
            {files.map((f) => (
              <li key={f.path}>
                {f.type === 'dir' ? (
                  <div
                    className="flex items-center gap-1 px-1.5 py-0.5 text-muted-foreground"
                    style={{ paddingLeft: 6 + (f.path.split('/').length - 1) * 12 }}
                  >
                    <Folder className="h-3 w-3" />
                    {f.path.split('/').pop()}/
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setFile(f.path)}
                    className={cn(
                      'flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left hover:bg-accent',
                      file === f.path && 'bg-accent font-medium'
                    )}
                    style={{ paddingLeft: 6 + (f.path.split('/').length - 1) * 12 }}
                  >
                    <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{f.path.split('/').pop()}</span>
                  </button>
                )}
              </li>
            ))}
            {draft?.isNew && (
              <li className="px-1.5 py-0.5 font-medium text-primary">
                <FileText className="mr-1 inline h-3 w-3" />
                {draft.path}
              </li>
            )}
          </ul>
          {!item.readOnly && (
            <div className="border-t border-border p-2">
              {newFile === null ? (
                <Button size="sm" variant="ghost" className="h-7 w-full text-[11px]" onClick={() => setNewFile('')}>
                  <FilePlus />
                  {t('config.addFile')}
                </Button>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const p = newFile.trim().replace(/^\/+/, '');
                    if (!p || p.split('/').includes('..')) return;
                    setDraft({ path: p, value: '', original: '', isNew: true });
                    setRevisions([]);
                    setFile(p);
                    setNewFile(null);
                  }}
                >
                  <input
                    autoFocus
                    value={newFile}
                    onChange={(e) => setNewFile(e.target.value)}
                    onBlur={() => !newFile && setNewFile(null)}
                    placeholder="scripts/run.sh"
                    className="w-full rounded border border-input bg-background px-1.5 py-1 font-mono text-[11px]"
                  />
                </form>
              )}
            </div>
          )}
        </div>
        {draft && draft.path === file ? (
          <FileEditor
            path={file}
            value={draft.value}
            original={draft.original}
            isNew={draft.isNew}
            readOnly={item.readOnly}
            onChange={(value) => setDraft((d) => (d ? { ...d, value } : d))}
            onSave={save}
            revisions={revisions}
            onRollback={async (revisionId) => {
              await api(`/api/resources/skills/${item.id}/rollback`, { body: { revisionId } });
              await refetch();
            }}
            extraActions={
              !item.readOnly && file !== 'SKILL.md' && !draft.isNew ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-[11px] text-red-600"
                  onClick={async () => {
                    try {
                      await api(`/api/resources/skills/${item.id}?path=${encodeURIComponent(file)}`, {
                        method: 'DELETE',
                      });
                      setFile('SKILL.md');
                      await refetch();
                    } catch (err: any) {
                      setError(err.message);
                    }
                  }}
                >
                  {t('config.deleteFile')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Empty text={t('composer.loading')} />
        )}
      </div>
    </div>
  );
}
