// SPDX-License-Identifier: Apache-2.0
import type { AgentStatus, SessionStatus } from '@crewtree/shared';
import { cn } from '@/lib/utils';

/** Status legend of UI-WIREFRAMES.md: colour is reserved for state; green only means "done". */
export type StatusVisual = 'running' | 'waiting' | 'done' | 'error' | 'approval' | 'throttled' | 'idle' | 'suspended';

const VISUALS: Record<StatusVisual, { glyph: string; dot: string; badge: string }> = {
  running: {
    glyph: '●',
    dot: 'text-blue-500 animate-pulse',
    badge: 'text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/40',
  },
  waiting: {
    glyph: '●',
    dot: 'text-blue-500',
    badge: 'text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/40',
  },
  done: {
    glyph: '✓',
    dot: 'text-emerald-500',
    badge:
      'text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40',
  },
  error: {
    glyph: '✕',
    dot: 'text-red-500',
    badge: 'text-red-600 dark:text-red-400 border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40',
  },
  approval: {
    glyph: '⚑',
    dot: 'text-amber-500',
    badge: 'text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40',
  },
  throttled: {
    glyph: '◌',
    dot: 'text-violet-400',
    badge:
      'text-violet-600 dark:text-violet-300 border-violet-200 dark:border-violet-900 bg-violet-50 dark:bg-violet-950/40',
  },
  idle: {
    glyph: '○',
    dot: 'text-zinc-400',
    badge: 'text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900',
  },
  suspended: {
    glyph: '○',
    dot: 'text-zinc-400 opacity-60',
    badge:
      'text-zinc-400 dark:text-zinc-500 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 opacity-80',
  },
};

export function agentVisual(status: AgentStatus | undefined): StatusVisual {
  switch (status) {
    case 'running':
      return 'running';
    case 'waiting_children':
      return 'waiting';
    case 'waiting_input':
    case 'needs_input':
      return 'approval';
    case 'throttled':
      return 'throttled';
    case 'error':
      return 'error';
    case 'suspended':
      return 'suspended';
    default:
      return 'idle'; // idle, queued
  }
}

export function sessionVisual(
  status: SessionStatus | undefined,
  activity: 'running' | 'idle' | undefined
): StatusVisual {
  if (activity === 'running') return 'running';
  if (status === 'completed') return 'done';
  if (status === 'error') return 'error';
  return 'idle';
}

/** i18n key of an agent status (`status.*` in the locale files). */
export function agentStatusKey(status: AgentStatus | undefined): string {
  return `status.${(status ?? 'idle').replace(/_(\w)/g, (_, c: string) => c.toUpperCase())}`;
}

export function StatusDot({ visual, className }: { visual: StatusVisual; className?: string }) {
  return (
    <span aria-hidden className={cn('inline-block w-3 text-center leading-none', VISUALS[visual].dot, className)}>
      {VISUALS[visual].glyph}
    </span>
  );
}

export function StatusBadge({ visual, label }: { visual: StatusVisual; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        VISUALS[visual].badge
      )}
    >
      <StatusDot visual={visual} className="w-auto" />
      {label}
    </span>
  );
}
