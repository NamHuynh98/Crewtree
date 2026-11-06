// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bot,
  Brain,
  Moon,
  Network,
  Play,
  Plus,
  Puzzle,
  Settings,
  Sparkles,
  Sun,
  Terminal,
  Languages,
} from 'lucide-react';
import type { Session } from '@crewtree/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { ResourceItem } from '@/features/resources/types';
import { useShell } from './shell';

interface Entry {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  run: () => void;
}

function score(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const s = text.toLowerCase();
  if (s.startsWith(q)) return 3;
  if (s.includes(q)) return 2;
  let i = 0;
  for (const c of s) if (c === q[i]) i++;
  return i === q.length ? 1 : 0;
}

/** Ctrl+K command palette (UI-WIREFRAMES 0): jump to sessions, agents, skills, pages; run actions. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { changeTheme, changeLanguage, themeSetting } = useShell();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const enabled = open;
  const { data: sessions = [] } = useQuery({
    // The most recent sessions; older ones are on the Sessions page
    queryKey: ['sessions', 'palette'],
    queryFn: () => api<{ items: Session[] }>('/api/sessions?limit=200').then((page) => page.items),
    enabled,
  });
  const { data: agents = [] } = useQuery({
    queryKey: ['resources', 'agents'],
    queryFn: () => api<ResourceItem[]>('/api/resources/agents'),
    enabled,
  });
  const { data: skills = [] } = useQuery({
    queryKey: ['resources', 'skills'],
    queryFn: () => api<ResourceItem[]>('/api/resources/skills'),
    enabled,
  });
  const { data: commands = [] } = useQuery({
    queryKey: ['resources', 'commands'],
    queryFn: () => api<ResourceItem[]>('/api/resources/commands'),
    enabled,
  });

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
    }
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const go = (to: string) => () => navigate(to);
    const actions: Entry[] = [
      {
        id: 'new-session',
        group: t('palette.actions'),
        label: t('actions.newSession'),
        icon: Plus,
        run: go('/?new=1'),
      },
      {
        id: 'new-agent',
        group: t('palette.actions'),
        label: t('palette.newAgent'),
        icon: Plus,
        run: go('/agents/new'),
      },
      {
        id: 'theme',
        group: t('palette.actions'),
        label: t('palette.toggleTheme'),
        icon: themeSetting === 'dark' ? Sun : Moon,
        run: () => changeTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark'),
      },
      {
        id: 'language',
        group: t('palette.actions'),
        label: i18n.language?.startsWith('vi') ? 'Switch to English' : 'Chuyển sang Tiếng Việt',
        icon: Languages,
        run: () => changeLanguage(i18n.language?.startsWith('vi') ? 'en' : 'vi'),
      },
    ];
    const pages: Entry[] = [
      { id: 'p-sessions', label: t('sessions'), icon: Play, to: '/' },
      { id: 'p-agents', label: t('agents'), icon: Bot, to: '/agents' },
      { id: 'p-skills', label: t('skills'), icon: Sparkles, to: '/skills' },
      { id: 'p-commands', label: t('commands'), icon: Terminal, to: '/commands' },
      { id: 'p-memory', label: t('memory'), icon: Brain, to: '/memory' },
      { id: 'p-mcp', label: t('mcp'), icon: Network, to: '/mcp' },
      { id: 'p-plugins', label: t('plugins'), icon: Puzzle, to: '/plugins' },
      { id: 'p-settings', label: t('settings'), icon: Settings, to: '/settings' },
    ].map((p) => ({ ...p, group: t('palette.pages'), run: go(p.to) }));
    return [
      ...actions,
      ...pages,
      ...sessions.map((s) => ({
        id: `s-${s.id}`,
        group: t('sessions'),
        label: s.title,
        hint: s.cwd,
        icon: Play,
        run: go(`/sessions/${s.id}`),
      })),
      ...agents
        .filter((a) => a.scope !== 'builtin')
        .map((a) => ({
          id: `a-${a.id}`,
          group: t('agents'),
          label: a.name,
          hint: t(`scope.${a.scope}`),
          icon: Bot,
          run: go(`/agents/${a.id}`),
        })),
      ...skills.map((s) => ({
        id: `k-${s.id}`,
        group: t('skills'),
        label: s.name,
        hint: t(`scope.${s.scope}`),
        icon: Sparkles,
        run: go('/skills'),
      })),
      ...commands.map((c) => ({
        id: `c-${c.id}`,
        group: t('commands'),
        label: `/${c.name}`,
        hint: t(`scope.${c.scope}`),
        icon: Terminal,
        run: go('/commands'),
      })),
    ];
  }, [t, i18n.language, navigate, sessions, agents, skills, commands, changeTheme, changeLanguage, themeSetting]);

  const shown = useMemo(
    () =>
      entries
        .map((e) => ({ e, s: score(query, `${e.label} ${e.hint ?? ''}`) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 40)
        .map((x) => x.e),
    [entries, query]
  );

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!open) return null;
  const choose = (e?: Entry) => {
    if (!e) return;
    onClose();
    e.run();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/30 pt-[12vh]" onMouseDown={onClose}>
      <div
        className="w-full max-w-xl overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t('palette.title')}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, shown.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(shown[index]);
            }
          }}
          placeholder={t('palette.placeholder')}
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none"
        />
        <ul ref={listRef} className="max-h-[50vh] overflow-y-auto p-1 text-xs" role="listbox">
          {shown.length === 0 && <li className="px-3 py-4 text-center text-muted-foreground">{t('palette.empty')}</li>}
          {shown.map((e, i) => {
            const Icon = e.icon;
            const header = i === 0 || shown[i - 1].group !== e.group;
            return (
              <li key={e.id}>
                {header && (
                  <div className="px-3 pb-0.5 pt-2 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {e.group}
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === index}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => choose(e)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-3 py-1.5 text-left',
                    i === index && 'bg-accent text-accent-foreground'
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="max-w-[60%] shrink-0 truncate">{e.label}</span>
                  {e.hint && (
                    <span className="ml-auto min-w-0 flex-1 truncate pl-3 text-right text-[10px] text-muted-foreground">
                      {e.hint}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">{t('palette.hint')}</div>
      </div>
    </div>
  );
}
