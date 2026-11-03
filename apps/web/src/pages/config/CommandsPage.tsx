// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ScopeBadge } from '@/features/resources/ScopeBadge';
import type { ResourceDetail, ResourceItem } from '@/features/resources/types';
import { ConfigHeader, ConfigList, Empty, useInvalidateResources, useResourceList } from '@/features/config/ConfigList';
import { FileEditor } from '@/features/config/FileEditor';
import { ConfigGenerateDialog } from '@/features/config/ConfigGenerateDialog';
import { NewResourceDialog } from '@/features/config/NewResourceDialog';

interface GeneratedCommand {
  name: string;
  description: string;
  content: string;
}

const template = (description: string) =>
  `---\ndescription: ${description || 'What this command does'}\nargument-hint: [args]\n---\n$ARGUMENTS\n`;

/** Slash commands (UI-WIREFRAMES 9: same layout as Skills, no supporting files). */
export function CommandsPage() {
  const { t } = useTranslation();
  const { data: items = [] } = useResourceList('commands');
  const invalidate = useInvalidateResources();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const selected = items.find((i) => i.id === selectedId);

  useEffect(() => {
    if (!selectedId && items.length) setSelectedId(items[0].id);
  }, [items, selectedId]);

  const create = async (scope: string, name: string, content: string) => {
    const res = await api<{ item: ResourceItem }>('/api/resources/commands', { body: { scope, name, content } });
    await invalidate();
    setSelectedId(res.item.id);
  };

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      <ConfigHeader
        title={t('commands')}
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
          <CommandDetail key={selected.id} item={selected} onDeleted={() => setSelectedId(undefined)} />
        ) : (
          <Empty text={t('config.pickCommand')} />
        )}
      </div>
      {creating && (
        <NewResourceDialog
          title={t('config.newCommand')}
          withDescription
          namePlaceholder="review or git/ship"
          onClose={() => setCreating(false)}
          onCreate={async ({ name, description, scope }) => {
            await create(scope, name, template(description));
            setCreating(false);
          }}
        />
      )}
      {generating && (
        <ConfigGenerateDialog<GeneratedCommand>
          kind="command"
          title={t('config.createCommandAi')}
          placeholder={t('config.commandPlaceholder')}
          modes={[{ mode: 'generate', label: t('aiGenerate.generateNew') }]}
          scopes={[
            { value: 'project', label: t('scope.project') },
            { value: 'user', label: t('scope.user') },
          ]}
          renderResult={(r) => (
            <div className="space-y-1">
              <div className="font-mono font-semibold">/{r.name}</div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border p-2 font-mono text-[11px]">
                {r.content}
              </pre>
            </div>
          )}
          onApply={async (r, scope) => {
            await create(scope ?? 'project', r.name, r.content);
            setGenerating(false);
          }}
          onClose={() => setGenerating(false)}
        />
      )}
    </main>
  );
}

function CommandDetail({ item, onDeleted }: { item: ResourceItem; onDeleted: () => void }) {
  const { t } = useTranslation();
  const invalidate = useInvalidateResources();
  const { data: detail, refetch } = useQuery({
    queryKey: ['resources', 'command', item.id],
    queryFn: () => api<ResourceDetail>(`/api/resources/commands/${item.id}`),
  });
  const [value, setValue] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (detail?.content !== undefined && value === null) setValue(detail.content);
  }, [detail, value]);
  const original = detail?.content ?? '';
  const slash = `/${item.metadata.namespace ? `${item.metadata.namespace}:` : ''}${item.name}`;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs">
        <span className="font-mono text-sm font-semibold">{slash}</span>
        <ScopeBadge scope={item.scope} plugin={item.plugin} readOnly={item.readOnly} />
        {item.metadata.argumentHint && (
          <span className="font-mono text-muted-foreground">{item.metadata.argumentHint}</span>
        )}
        <span className="ml-auto" />
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
                    await api(`/api/resources/commands/${item.id}`, { method: 'DELETE' });
                    await invalidate();
                    onDeleted();
                  } catch (err: any) {
                    setError(err.message);
                  }
                }}
              >
                {t('config.confirmDelete')}
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
      {error && <p className="border-b border-border bg-red-50 px-4 py-1 text-[11px] text-red-700">{error}</p>}
      {value === null ? (
        <Empty text={t('composer.loading')} />
      ) : (
        <FileEditor
          path={item.path ?? `${item.name}.md`}
          value={value}
          original={original}
          readOnly={item.readOnly}
          onChange={setValue}
          revisions={detail?.revisions}
          onSave={async (content) => {
            await api(`/api/resources/commands/${item.id}`, { method: 'PUT', body: { content } });
            await invalidate();
            await refetch();
          }}
          onRollback={async (revisionId) => {
            await api(`/api/resources/commands/${item.id}/rollback`, { body: { revisionId } });
            const fresh = await refetch();
            setValue(fresh.data?.content ?? '');
          }}
        />
      )}
    </div>
  );
}
