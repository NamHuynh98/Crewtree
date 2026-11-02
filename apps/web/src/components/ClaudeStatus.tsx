// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export interface ClaudeStatusInfo {
  login: 'logged_in' | 'not_logged_in' | 'unknown';
  subscriptionType?: string;
  rateLimited: boolean;
}

/** Sidebar footer: Claude Code logged in / not logged in / rate limited (UI-WIREFRAMES 0). */
export function ClaudeStatus({ status, serverOnline }: { status: ClaudeStatusInfo | null; serverOnline: boolean }) {
  const { t } = useTranslation();

  let dot = 'text-zinc-400';
  let text = t('claude.checking');
  let hint: string | undefined;
  if (!serverOnline) {
    dot = 'text-red-500';
    text = t('claude.serverOffline');
  } else if (status?.login === 'not_logged_in') {
    dot = 'text-red-500';
    text = t('claude.notLoggedIn');
    hint = t('claude.loginHint');
  } else if (status?.rateLimited) {
    dot = 'text-violet-400';
    text = t('claude.rateLimited');
  } else if (status?.login === 'logged_in') {
    dot = 'text-emerald-500';
    text = t('claude.loggedIn');
  } else if (status?.login === 'unknown') {
    text = t('claude.unknown');
  }

  return (
    <div className="flex items-start gap-2 px-2.5 text-[11px]" title={hint ?? status?.subscriptionType}>
      <span aria-hidden className={cn('leading-4', dot)}>
        ●
      </span>
      <div>
        <div className="font-medium text-foreground">{serverOnline ? t('claude.label') : text}</div>
        {serverOnline && <div className="text-muted-foreground">{text}</div>}
      </div>
    </div>
  );
}
