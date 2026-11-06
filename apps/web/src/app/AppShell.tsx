// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Brain,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Puzzle,
  Settings,
  Sparkles,
  Terminal,
} from 'lucide-react';
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
import { UsageMeter } from '@/components/UsageMeter';
import { ShellContext, type ProjectInfo } from './shell';
import { ProjectSwitcher } from './ProjectSwitcher';
import { ApprovalInbox } from './ApprovalInbox';
import { CommandPalette } from './CommandPalette';
import { UpdateBanner } from './UpdateBanner';

const navItemClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2.5 px-2.5 py-1.5 rounded-md transition ${
    isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
  }`;

// Per-browser convenience: storage may be unavailable (private mode, blocked site data)
const SIDEBAR_KEY = 'crewtree.sidebarCollapsed';
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false;
  }
}
function writeCollapsed(value: boolean) {
  try {
    localStorage.setItem(SIDEBAR_KEY, value ? '1' : '0');
  } catch {
    // keeps working for this page only
  }
}

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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggleSidebar = () =>
    setCollapsed((v) => {
      writeCollapsed(!v);
      return !v;
    });
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

  // Ctrl+K / ⌘K command palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
    <ShellContext.Provider
      value={{
        project: projects?.current ?? null,
        refreshApprovals,
        notify: setNotice,
        themeSetting,
        changeTheme,
        changeLanguage,
        openPalette: () => setPaletteOpen(true),
      }}
    >
      <div className="h-screen overflow-hidden flex flex-col bg-background text-foreground">
        <header className="h-12 border-b border-border px-4 flex items-center justify-between bg-card select-none">
          <div className="flex min-w-0 flex-1 items-center gap-4 pr-4">
            <NavLink to="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-tight">
              <img src="/logo.png" alt="" aria-hidden className="h-6 w-6" />
              <span className="text-base">{t('appName')}</span>
            </NavLink>
            <div className="h-4 w-px shrink-0 bg-border" />
            <ProjectSwitcher />
          </div>

          <div className="flex shrink-0 items-center gap-2 text-sm">
            <ApprovalInbox count={pendingApprovals} onChanged={refreshApprovals} />
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
        <UpdateBanner />

        <div className="flex-1 flex overflow-hidden">
          <aside
            className={`${collapsed ? 'w-14 px-2' : 'w-56 px-3'} shrink-0 border-r border-border bg-card/50 flex flex-col justify-between py-3 select-none transition-[width] duration-150`}
          >
            <div className="space-y-4">
              <div>
                {collapsed ? (
                  <div className="mx-1 mb-1.5 h-px bg-border" aria-hidden />
                ) : (
                  <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase px-2 mb-1.5">
                    {t('nav.workspace')}
                  </div>
                )}
                <nav className="space-y-0.5 text-xs font-medium">
                  <NavLink
                    to="/"
                    end
                    className={(s) => `${navItemClass(s)} ${collapsed ? 'justify-center' : ''}`}
                    title={collapsed ? t('sessions') : undefined}
                    aria-label={t('sessions')}
                  >
                    <Play className="w-3.5 h-3.5 shrink-0 text-primary" />
                    {!collapsed && <span>{t('sessions')}</span>}
                  </NavLink>
                </nav>
              </div>
              <div>
                {collapsed ? (
                  <div className="mx-1 mb-1.5 h-px bg-border" aria-hidden />
                ) : (
                  <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase px-2 mb-1.5">
                    {t('nav.claudeConfig')}
                  </div>
                )}
                <nav className="space-y-0.5 text-xs font-medium">
                  {configLinks.map(({ to, icon: Icon, label }) => (
                    <NavLink
                      key={to}
                      to={to}
                      className={(s) => `${navItemClass(s)} ${collapsed ? 'justify-center' : ''}`}
                      title={collapsed ? label : undefined}
                      aria-label={label}
                    >
                      <Icon className="w-3.5 h-3.5 shrink-0" />
                      {!collapsed && <span>{label}</span>}
                    </NavLink>
                  ))}
                </nav>
              </div>
            </div>

            {/* Footer: Settings + Claude Code status (UI-WIREFRAMES 0), collapse toggle */}
            <div className="pt-3 border-t border-border space-y-2">
              <NavLink
                to="/settings"
                className={(s) => `${navItemClass(s)} text-xs font-medium ${collapsed ? 'justify-center' : ''}`}
                title={collapsed ? t('settings') : undefined}
                aria-label={t('settings')}
              >
                <Settings className="w-3.5 h-3.5 shrink-0" />
                {!collapsed && <span>{t('settings')}</span>}
              </NavLink>
              {serverOnline && claudeStatus?.login === 'logged_in' && <UsageMeter compact={collapsed} />}
              <ClaudeStatus status={claudeStatus} serverOnline={serverOnline} compact={collapsed} />
              <button
                type="button"
                onClick={toggleSidebar}
                className={`flex w-full items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground ${collapsed ? 'justify-center' : ''}`}
                title={collapsed ? t('nav.expand') : t('nav.collapse')}
                aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
                aria-expanded={!collapsed}
              >
                {collapsed ? (
                  <PanelLeftOpen className="w-3.5 h-3.5 shrink-0" />
                ) : (
                  <PanelLeftClose className="w-3.5 h-3.5 shrink-0" />
                )}
                {!collapsed && <span>{t('nav.collapse')}</span>}
              </button>
            </div>
          </aside>

          <Outlet />
          <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
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
