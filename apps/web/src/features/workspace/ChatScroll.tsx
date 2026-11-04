// SPDX-License-Identifier: Apache-2.0
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

/**
 * Scroll container of a chat: follows new messages, loads older pages when scrolled to the top (or on the
 * button) and keeps the reading position while they are added above.
 */
export function ChatScroll({
  firstKey,
  lastKey,
  dep,
  hasOlder,
  onLoadOlder,
  children,
}: {
  /** Ids of the first and last message: a new first id with the same last id means a page was prepended */
  firstKey?: string;
  lastKey?: string;
  /** Changes whenever the content changes (streaming text included) */
  dep: unknown;
  hasOlder: boolean;
  onLoadOlder: () => Promise<void>;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const seen = useRef<{ first?: string; last?: string; height: number; top: number }>({ height: 0, top: 0 });
  const atBottom = useRef(true);
  const loading = useRef(false);
  const [busy, setBusy] = useState(false);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const before = seen.current;
    const prepended = before.first !== undefined && firstKey !== before.first && lastKey === before.last;
    if (prepended) el.scrollTop = before.top + (el.scrollHeight - before.height);
    else if (atBottom.current || lastKey !== before.last) {
      el.scrollTop = el.scrollHeight;
      atBottom.current = true;
    }
    seen.current = { first: firstKey, last: lastKey, height: el.scrollHeight, top: el.scrollTop };
  }, [firstKey, lastKey, dep]);

  const loadOlder = async () => {
    if (loading.current || !hasOlder) return;
    loading.current = true;
    setBusy(true);
    try {
      await onLoadOlder();
    } finally {
      loading.current = false;
      setBusy(false);
    }
  };

  return (
    <div
      ref={box}
      className="flex-1 overflow-y-auto p-3"
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        seen.current = { ...seen.current, height: el.scrollHeight, top: el.scrollTop };
        if (el.scrollTop < 60) void loadOlder();
      }}
    >
      {hasOlder && (
        <div className="mb-3 flex justify-center">
          <button
            type="button"
            className="flex items-center gap-1.5 text-[11px] text-primary hover:underline disabled:opacity-60"
            disabled={busy}
            onClick={() => void loadOlder()}
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            {busy ? t('chat.loadingOlder') : t('chat.loadOlder')}
          </button>
        </div>
      )}
      {children}
    </div>
  );
}
