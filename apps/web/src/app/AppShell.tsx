// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Brain, Network, Play, Puzzle, Settings, Sparkles, Terminal } from 'lucide-react';
import type { AgentEvent } from '@crewtree/shared';
import {
  getBoot,
  resolveTheme,
  saveUiSettings,
  type BootSettings,
  type LanguageSetting,
  type ThemeSetting,
} from '@/lib/boot';
import { api } from '@/lib/api';
import { ThemeMenu, LanguageMenu } from '@/components/HeaderMenus';
import { ClaudeStatus, type ClaudeStatusInfo } from '@/components/ClaudeStatus';
import { ShellContext, type ProjectInfo } from './shell';
import { ProjectSwitcher } from './ProjectSwitcher';

const navItemClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2.5 px-2.5 py-1.5 rounded-md transition ${
    isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
  }`;

/** App shell of UI-WIREFRAMES 0: header, sidebar, global channel; pages render in the outlet. */
export function AppShell() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [themeSetting, setThemeSetting] = useState<ThemeSetting>(() => getBoot().theme);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => resolveTheme(getBoot().theme));
  // Failed settings save: the UI keeps the new value and offers a retry (PLAN.md 11.1)
  const [saveError, setSaveError] = useState<{ ui: Partial<BootSettings> } | null>(null);
  const [serverOnline, setServerOnline] = useState(true);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatusInfo | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<{ current: ProjectInfo }>('/api/projects'),
  });

  const refreshApprovals = useCallback(() => {
    fetch('/api/approvals?status=pending')
      .then((res) => (res.ok ? res.json() : []))
      .then((rows) => setPendingApprovals(Array.isArray(rows) ? rows.length : 0))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshApprovals();
    // Claude Code login / rate-limit state for the sidebar footer
    const loadClaudeStatus = () =>
      fetch('/api/claude/status')
        .then((res) => {
          setServerOnline(true);
          return res.ok ? res.json() : null;
        })
        .then((data) => data && setClaudeStatus(data))
        .catch(() => setServerOnline(false));
    loadClaudeStatus();
    const timer = setInterval(loadClaudeStatus, 60_000);
    return () => clearInterval(timer);
  }, [refreshApprovals]);

  // Global channel (PLAN.md 15.2): approvals of every session, resource changes and notices
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws: WebSocket | undefined;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      ws.onmessage = (msg) => {
        try {
          const evt: AgentEvent = JSON.parse(msg.data);
          if (evt.type?.startsWith('approval.')) refreshApprovals();
          if (evt.type === 'resource.changed') {
            void queryClient.invalidateQueries({ queryKey: ['resources'] });
            if (evt.payload?.reason === 'project') void queryClient.invalidateQueries({ queryKey: ['projects'] });
            if (evt.payload?.action === 'created' && evt.payload?.model) {
              setNotice(t('notices.supervisorCreated', { model: evt.payload.model }));
            }
          }
        } catch {
          // ignore
        }
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [refreshApprovals, queryClient, t]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  // "System" follows the OS setting live
  useEffect(() => {
    setTheme(resolveTheme(themeSetting));
    if (themeSetting !== 'system') return;
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onChange = () => setTheme(resolveTheme('system'));
    media?.addEventListener('change', onChange);
    return () => media?.removeEventListener('change', onChange);
  }, [themeSetting]);

  const persistUi = (ui: Partial<BootSettings>) => {
    saveUiSettings(ui)
      .then(() => setSaveError(null))
      .catch((err) => {
        console.error(err);
        setSaveError({ ui });
      });
  };

  const changeLanguage = (language: LanguageSetting) => {
    i18n.changeLanguage(language);
    document.documentElement.lang = language;
    persistUi({ language });
  };

  const changeTheme = (next: ThemeSetting) => {
    setThemeSetting(next);
    persistUi({ theme: next });
  };

  const configLinks = [
    { to: '/agents', icon: Bot, label: t('agents') },
    { to: '/skills', icon: Sparkles, label: t('skills') },
    { to: '/commands', icon: Terminal, label: t('commands') },
    { to: '/memory', icon: Brain, label: t('memory') },
    { to: '/mcp', icon: Network, label: t('mcp') },
    { to: '/plugins', icon: Puzzle, label: t('plugins') },
  ];

  return (
    <ShellContext.Provider value={{ project: projects?.current ?? null, refreshApprovals, notify: setNotice }}>
      <div className="h-screen overflow-hidden flex flex-col bg-background text-foreground">
        <header className="h-12 border-b border-border px-4 flex items-center justify-between bg-card select-none">
          <div className="flex items-center gap-4">
            <NavLink to="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <span className="text-xl text-primary">◆</span>
              <span className="text-base">{t('appName')}</span>
            </NavLink>
            <div className="h-4 w-px bg-border" />
            <ProjectSwitcher />
          </div>

          <div className="flex items-center gap-2 text-sm">
            <div
              className={`flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-md border ${
                pendingApprovals > 0
                  ? 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800'
                  : 'text-muted-foreground border-border'
              }`}
              title={t('header.pendingTitle')}
            >
              <span aria-hidden>⚑</span>
              <span>{t('header.pending', { count: pendingApprovals })}</span>
            </div>
            <ThemeMenu value={themeSetting} onChange={changeTheme} />
            <LanguageMenu value={(i18n.language as LanguageSetting) ?? 'en'} onChange={changeLanguage} />
            <NavLink
              to="/settings"
              className="p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              title={t('header.openSettings')}
              aria-label={t('header.openSettings')}
            >
              <Settings className="w-4 h-4" />
            </NavLink>
          </div>
        </header>

        <div className="flex-1 flex overflow-hidden">
          <aside className="w-56 border-r border-border bg-card/50 flex flex-col justify-between p-3 select-none">
            <div className="space-y-4">
              <div>
                <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase px-2 mb-1.5">
                  {t('nav.workspace')}
                </div>
                <nav className="space-y-0.5 text-xs font-medium">
                  <NavLink to="/" end className={navItemClass}>
                    <Play className="w-3.5 h-3.5 text-primary" />
                    <span>{t('sessions')}</span>
                  </NavLink>
                </nav>
              </div>
              <div>
                <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase px-2 mb-1.5">
                  {t('nav.claudeConfig')}
                </div>
                <nav className="space-y-0.5 text-xs font-medium">
                  {configLinks.map(({ to, icon: Icon, label }) => (
                    <NavLink key={to} to={to} className={navItemClass}>
                      <Icon className="w-3.5 h-3.5" />
                      <span>{label}</span>
                    </NavLink>
                  ))}
                </nav>
              </div>
            </div>

            {/* Footer: Settings + Claude Code status (UI-WIREFRAMES 0) */}
            <div className="pt-3 border-t border-border space-y-2">
              <NavLink to="/settings" className={(s) => `${navItemClass(s)} text-xs font-medium`}>
                <Settings className="w-3.5 h-3.5" />
                <span>{t('settings')}</span>
              </NavLink>
              <ClaudeStatus status={claudeStatus} serverOnline={serverOnline} />
            </div>
          </aside>

          <Outlet />
        </div>

        {notice && (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 text-xs bg-foreground text-background rounded-lg px-3 py-2 shadow-lg">
            {notice}
          </div>
        )}
        {saveError && (
          <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 text-xs bg-destructive text-destructive-foreground rounded-lg px-3 py-2 shadow-lg">
            <span>{t('settingsSaveFailed')}</span>
            <button onClick={() => persistUi(saveError.ui)} className="font-semibold underline">
              {t('retry')}
            </button>
          </div>
        )}
      </div>
    </ShellContext.Provider>
  );
}
