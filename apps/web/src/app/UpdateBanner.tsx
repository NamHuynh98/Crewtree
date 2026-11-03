// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api } from '@/lib/api';

interface VersionInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
  releaseUrl?: string;
  disabled: boolean;
}

const DISMISSED_KEY = 'crewtree.update.dismissed';

/** "v0.2.0 available · What's new · How to update" (PLAN.md 16.4). The web only tells; it never updates. */
export function UpdateBanner() {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ['version'],
    queryFn: () => api<VersionInfo>('/api/version'),
    staleTime: 6 * 60 * 60 * 1000,
  });
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY);
    } catch {
      return null;
    }
  });
  const [howTo, setHowTo] = useState(false);
  if (!data?.updateAvailable || data.disabled || dismissed === data.latest) return null;
  return (
    <div className="flex items-center gap-2 border-b border-border bg-primary/10 px-4 py-1 text-xs">
      <span className="font-medium">{t('update.available', { version: data.latest, current: data.current })}</span>
      {data.releaseUrl && (
        <a href={data.releaseUrl} target="_blank" rel="noreferrer noopener" className="text-primary hover:underline">
          {t('update.whatsNew')}
        </a>
      )}
      <button type="button" className="text-primary hover:underline" onClick={() => setHowTo((v) => !v)}>
        {t('update.howTo')}
      </button>
      {howTo && <code className="rounded bg-background px-1.5 py-0.5 font-mono">crewtree update</code>}
      <button
        type="button"
        className="ml-auto rounded p-0.5 hover:bg-accent"
        aria-label={t('actions.close')}
        onClick={() => {
          try {
            localStorage.setItem(DISMISSED_KEY, data.latest);
          } catch {
            // dismissal is a convenience only
          }
          setDismissed(data.latest);
        }}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
