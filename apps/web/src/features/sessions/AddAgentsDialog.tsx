// SPDX-License-Identifier: Apache-2.0
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScopeBadge } from '@/features/resources/ScopeBadge';
import type { ResourceItem } from '@/features/resources/types';

export interface ParentOption {
  value: string;
  label: string;
  /** `delegates` of that parent: '*' or allowed agent names */
  delegates: '*' | string[];
}

/** Agents that can be put in a session tree: file agents that are not shadowed (built-ins run inside Claude Code). */
export function sessionCandidates(agents: ResourceItem[]): ResourceItem[] {
  return agents.filter((a) => a.scope !== 'builtin' && !a.shadowedBy);
}

/** Add agents dialog (UI-WIREFRAMES 1), used by New session and the Workspace. */
export function AddAgentsDialog({
  agents,
  parents,
  defaultParent,
  onAdd,
  onClose,
}: {
  agents: ResourceItem[];
  parents: ParentOption[];
  defaultParent?: string;
  onAdd: (names: string[], parent: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<string>('all');
  const [parent, setParent] = useState(defaultParent ?? parents[0]?.value ?? '');
  const [selected, setSelected] = useState<string[]>([]);
  const allowed = parents.find((p) => p.value === parent)?.delegates ?? '*';

  const list = useMemo(
    () =>
      sessionCandidates(agents).filter(
        (a) =>
          (scope === 'all' || a.scope === scope) &&
          (allowed === '*' || allowed.includes(a.name)) &&
          `${a.name} ${a.description}`.toLowerCase().includes(query.toLowerCase())
      ),
    [agents, scope, allowed, query]
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onMouseDown={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg border border-border bg-card shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t('addAgents.title')}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <span className="text-sm font-semibold">{t('addAgents.title')}</span>
          <button onClick={onClose} aria-label={t('actions.cancel')}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-2 border-b border-border p-3 text-xs">
          <div className="flex gap-2">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('addAgents.search')}
              className="flex-1 rounded-md border border-input bg-background px-2.5 py-1.5"
            />
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1.5"
              aria-label={t('agentsPage.scope')}
            >
              <option value="all">{t('agentsPage.allScopes')}</option>
              {['crewtree', 'user', 'project', 'plugin'].map((s) => (
                <option key={s} value={s}>
                  {t(`scope.${s}`)}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">{t('tree.parent')}</span>
            <select
              value={parent}
              onChange={(e) => {
                setParent(e.target.value);
                setSelected([]);
              }}
              className="flex-1 rounded-md border border-input bg-background px-2 py-1.5"
            >
              {parents.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {allowed !== '*' && (
            <p className="text-[10px] text-muted-foreground">{t('addAgents.limited', { names: allowed.join(', ') })}</p>
          )}
        </div>
        <ul className="flex-1 overflow-y-auto p-2 text-xs">
          {list.length === 0 && <li className="p-3 text-muted-foreground">{t('addAgents.none')}</li>}
          {list.map((a) => (
            <li key={a.id}>
              <label className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-accent">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={selected.includes(a.name)}
                  onChange={(e) =>
                    setSelected((prev) => (e.target.checked ? [...prev, a.name] : prev.filter((n) => n !== a.name)))
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{a.name}</span>
                  {a.metadata.canDelegate && (
                    <span className="ml-1 text-[10px] text-primary">({t('addAgents.delegates')})</span>
                  )}
                  <span className="block truncate text-[11px] text-muted-foreground">{a.description}</span>
                </span>
                <ScopeBadge scope={a.scope} plugin={a.plugin} readOnly={a.readOnly} />
              </label>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={!selected.length}
            onClick={async () => {
              await onAdd(selected, parent);
              onClose();
            }}
          >
            {t('addAgents.add', { count: selected.length })}
          </Button>
        </div>
      </div>
    </div>
  );
}
