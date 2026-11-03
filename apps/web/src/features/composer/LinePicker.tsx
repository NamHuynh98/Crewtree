// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { readFile } from './sources';
import type { ComposerContext } from './types';

interface Props {
  ctx: ComposerContext;
  path: string;
  initial?: { start: number; end: number };
  onInsert: (range?: { start: number; end: number }) => void;
  onCancel: () => void;
}

/** `#` — pick lines of a file by dragging or typing `10-24` (UI-WIREFRAMES 3). */
export function LinePicker({ ctx, path, initial, onInsert, onCancel }: Props) {
  const { t } = useTranslation();
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<{ start: number; end: number } | undefined>(initial);
  const [typed, setTyped] = useState(initial ? `${initial.start}-${initial.end}` : '');
  const dragFrom = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    readFile(ctx, path)
      .then((f) => {
        if (f.content === undefined) setError(f.binary ? t('composer.binaryFile') : t('composer.fileTooLarge'));
        else setLines(f.content.split(/\r?\n/));
      })
      .catch((err) => setError(err.message));
  }, [ctx, path, t]);

  // Scroll the initial range into view
  useEffect(() => {
    if (!lines || !initial) return;
    listRef.current?.querySelector(`[data-line="${initial.start}"]`)?.scrollIntoView({ block: 'center' });
  }, [lines, initial]);

  const select = (a: number, b: number) => {
    const next = { start: Math.min(a, b), end: Math.max(a, b) };
    setRange(next);
    setTyped(next.start === next.end ? `${next.start}` : `${next.start}-${next.end}`);
  };

  const onTyped = (value: string) => {
    setTyped(value);
    const m = /^(\d+)(?:-(\d+))?$/.exec(value.trim());
    if (m) {
      const start = Number(m[1]);
      setRange({ start, end: Math.max(start, Number(m[2] ?? m[1])) });
    } else setRange(undefined);
  };

  const label = useMemo(
    () => (range ? `#L${range.start}${range.end !== range.start ? `-${range.end}` : ''}` : ''),
    [range]
  );

  return (
    <div
      className="absolute bottom-full left-0 right-0 z-40 mb-2 flex max-h-[360px] flex-col rounded-lg border border-border bg-popover text-popover-foreground shadow-xl"
      onMouseUp={() => (dragFrom.current = null)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
        if (e.key === 'Enter') {
          e.preventDefault();
          onInsert(range);
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <span className="truncate font-mono">{path}</span>
        <input
          autoFocus
          value={typed}
          onChange={(e) => onTyped(e.target.value)}
          placeholder="10-24"
          className="ml-auto w-24 rounded border border-input bg-background px-1.5 py-0.5 font-mono text-[11px]"
          aria-label={t('composer.lineRange')}
        />
      </div>
      <div ref={listRef} className="flex-1 select-none overflow-auto py-1 font-mono text-[11px] leading-5">
        {error && <p className="px-3 py-2 text-muted-foreground">{error}</p>}
        {!lines && !error && <p className="px-3 py-2 text-muted-foreground">{t('composer.loading')}</p>}
        {lines?.map((line, i) => {
          const n = i + 1;
          const active = range && n >= range.start && n <= range.end;
          return (
            <div
              key={n}
              data-line={n}
              className={`flex cursor-pointer whitespace-pre px-2 ${active ? 'bg-primary/15' : 'hover:bg-accent'}`}
              onMouseDown={(e) => {
                if (e.shiftKey && range) select(range.start, n);
                else {
                  dragFrom.current = n;
                  select(n, n);
                }
              }}
              onMouseEnter={() => dragFrom.current !== null && select(dragFrom.current, n)}
            >
              <span className={`w-10 shrink-0 pr-2 text-right ${active ? 'text-primary' : 'text-muted-foreground'}`}>
                {n}
              </span>
              <span className={active ? 'border-l-2 border-primary pl-1.5' : 'pl-2'}>{line || ' '}</span>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-1.5">
        <span className="mr-auto text-[10px] text-muted-foreground">{t('composer.lineHint')}</span>
        <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={onCancel}>
          {t('actions.cancel')}
        </Button>
        <Button size="sm" className="h-7 text-[11px]" onClick={() => onInsert(range)}>
          {range ? t('composer.insertLines', { range: label }) : t('composer.insertFile')}
        </Button>
      </div>
    </div>
  );
}
