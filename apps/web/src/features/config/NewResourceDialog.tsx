// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Name (+ description) + scope for a new skill, command or MCP server. */
export function NewResourceDialog({
  title,
  withDescription,
  scopes = ['project', 'user'],
  namePlaceholder,
  onCreate,
  onClose,
}: {
  title: string;
  withDescription?: boolean;
  scopes?: string[];
  namePlaceholder?: string;
  onCreate: (input: { name: string; description: string; scope: string }) => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState(scopes[0]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onMouseDown={onClose}>
      <form
        className="w-full max-w-md space-y-3 rounded-lg border border-border bg-card p-4 text-xs shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await onCreate({ name: name.trim(), description: description.trim(), scope });
          } catch (err: any) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">{title}</span>
          <button type="button" onClick={onClose} aria-label={t('actions.cancel')}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <label className="block space-y-1">
          <span>{t('editor.name')}</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={namePlaceholder}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono"
          />
        </label>
        {withDescription && (
          <label className="block space-y-1">
            <span title={t('config.descriptionHint')}>{t('config.description')} ⓘ</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="min-h-[56px] w-full rounded-md border border-input bg-background px-2 py-1.5"
            />
          </label>
        )}
        <div className="flex items-center gap-3">
          <span>{t('config.scope')}</span>
          {scopes.map((s) => (
            <label key={s} className="flex items-center gap-1">
              <input type="radio" checked={scope === s} onChange={() => setScope(s)} />
              {t(`scope.${s}`)}
            </label>
          ))}
        </div>
        {error && <p className="text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={!name.trim() || busy}>
            {t('config.create')}
          </Button>
        </div>
      </form>
    </div>
  );
}
