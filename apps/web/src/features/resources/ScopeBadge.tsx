// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Scope } from './types';

const STYLE: Record<Scope, string> = {
  crewtree: 'border-violet-300 text-violet-700 dark:border-violet-800 dark:text-violet-300',
  user: 'border-sky-300 text-sky-700 dark:border-sky-800 dark:text-sky-300',
  project: 'border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300',
  local: 'border-teal-300 text-teal-700 dark:border-teal-800 dark:text-teal-300',
  plugin: 'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300',
  builtin: 'border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400',
};

/** Source badge (PLAN.md 6.1): Crewtree, User, Project, Plugin: <name>, Built-in; read-only sources show a lock. */
export function ScopeBadge({ scope, plugin, readOnly }: { scope: Scope; plugin?: string; readOnly?: boolean }) {
  const { t } = useTranslation();
  const label = scope === 'plugin' && plugin ? `${t('scope.plugin')}: ${plugin.split('@')[0]}` : t(`scope.${scope}`);
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-medium', STYLE[scope])}
    >
      {readOnly && <Lock className="h-2.5 w-2.5" />}
      {label}
    </span>
  );
}
