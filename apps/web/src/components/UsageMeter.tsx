// SPDX-License-Identifier: Apache-2.0
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface UsageWindow {
  key: string;
  label?: string;
  percent: number;
  resetsAt: string | null;
}

interface AccountUsage {
  available: boolean;
  subscriptionType: string | null;
  windows: UsageWindow[];
  fetchedAt: number;
}

const barColor = (p: number) => (p >= 90 ? 'bg-red-500' : p >= 75 ? 'bg-amber-500' : 'bg-emerald-500');
const textColor = (p: number) =>
  p >= 90 ? 'text-red-600 dark:text-red-400' : p >= 75 ? 'text-amber-600 dark:text-amber-400' : '';

/** Plan usage of the Claude account (the `/usage` windows of Claude Code) in the sidebar footer. */
export function UsageMeter({ compact = false }: { compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { data, isFetching } = useQuery({
    queryKey: ['usage'],
    queryFn: () => api<AccountUsage>('/api/claude/usage'),
    refetchInterval: 2 * 60_000,
    refetchOnWindowFocus: true,
    staleTime: 60_000,
  });
  if (!data?.available || data.windows.length === 0) return null;

  const name = (w: UsageWindow) =>
    w.key === 'weekly_model' ? t('usage.weeklyModel', { name: w.label }) : t(`usage.${w.key}`, w.label ?? w.key);
  const resets = (iso: string | null) => {
    if (!iso) return '';
    const at = new Date(iso);
    const soon = at.getTime() - Date.now() < 24 * 60 * 60_000;
    const time = new Intl.DateTimeFormat(
      i18n.language,
      soon ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' }
    ).format(at);
    return t('usage.resets', { time });
  };
  const tooltip = data.windows.map((w) => `${name(w)}: ${w.percent}% · ${resets(w.resetsAt)}`).join('\n');

  if (compact) {
    const top = data.windows.reduce((a, b) => (b.percent > a.percent ? b : a));
    return (
      <div
        className={cn('text-center text-[10px] font-medium tabular-nums text-muted-foreground', textColor(top.percent))}
        title={`${t('usage.title')}\n${tooltip}`}
        aria-label={`${t('usage.title')}: ${tooltip}`}
      >
        {top.percent}%
      </div>
    );
  }

  const refresh = async () => {
    const fresh = await api<AccountUsage>('/api/claude/usage?refresh=1');
    queryClient.setQueryData(['usage'], fresh);
  };

  return (
    <div className="space-y-1.5 px-2.5 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="font-medium text-foreground">{t('usage.title')}</span>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t('usage.refresh')}
          aria-label={t('usage.refresh')}
        >
          <RefreshCw className={cn('h-3 w-3', isFetching && 'animate-spin')} />
        </button>
      </div>
      {data.windows.map((w) => (
        <div key={`${w.key}:${w.label ?? ''}`} title={resets(w.resetsAt)}>
          <div className="flex items-baseline justify-between gap-2 text-muted-foreground">
            <span className="truncate">{name(w)}</span>
            <span className={cn('tabular-nums', textColor(w.percent))}>{w.percent}%</span>
          </div>
          <div
            className="mt-0.5 h-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label={name(w)}
            aria-valuenow={w.percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className={cn('h-full rounded-full', barColor(w.percent))} style={{ width: `${w.percent}%` }} />
          </div>
          {w.resetsAt && <div className="mt-0.5 text-[10px] text-muted-foreground/80">{resets(w.resetsAt)}</div>}
        </div>
      ))}
    </div>
  );
}
