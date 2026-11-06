// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import type { AppSettings } from '@crewtree/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { shortenPath } from '@/lib/paths';
import { useShell } from '@/app/shell';
import { Button } from '@/components/ui/button';
import { ModelPicker, useModelCatalog } from '@/features/model-picker/ModelPicker';
import { formatTokens } from '@/features/workspace/agentInfo';

type Tab = 'general' | 'models' | 'defaults' | 'limits' | 'account';
const TABS: Tab[] = ['general', 'models', 'defaults', 'limits', 'account'];

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

interface Account {
  dataDir: string;
  claudeDir: string;
  server: string;
  version: string;
  claude: { login: string; subscriptionType?: string; error?: string };
  throttled: boolean;
}

const section = 'text-[10px] font-semibold uppercase tracking-wider text-muted-foreground';
const row = 'flex flex-wrap items-center gap-3';
const label = 'w-56 shrink-0';
const select = 'rounded-md border border-input bg-background px-2 py-1';
const num = 'w-24 rounded-md border border-input bg-background px-2 py-1';

/** Settings (UI-WIREFRAMES 13): General, Models, Defaults, Limits, Account. */
export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { themeSetting, changeTheme, changeLanguage, project } = useShell();
  const [tab, setTab] = useState<Tab>('general');
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => api<AppSettings>('/api/settings') });
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const patch = async (body: DeepPartial<AppSettings>) => {
    try {
      const next = await api<AppSettings>('/api/settings', { method: 'PATCH', body });
      queryClient.setQueryData(['settings'], next);
      if (body.models) void queryClient.invalidateQueries({ queryKey: ['models'] });
      setStatus({ ok: true, text: t('settingsPage.saved') });
    } catch (err: any) {
      setStatus({ ok: false, text: err.message });
    }
  };

  useEffect(() => {
    if (!status?.ok) return;
    const timer = setTimeout(() => setStatus(null), 2000);
    return () => clearTimeout(timer);
  }, [status]);

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-4 text-xs">
        <h1 className="text-sm font-semibold">{t('settings')}</h1>
        <div className="flex gap-1">
          {TABS.map((x) => (
            <button
              key={x}
              type="button"
              onClick={() => setTab(x)}
              className={cn(
                'rounded-md px-2.5 py-1',
                tab === x ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent'
              )}
            >
              {t(`settingsPage.tabs.${x}`)}
            </button>
          ))}
        </div>
        {status && (
          <span className={cn('ml-auto', status.ok ? 'text-emerald-600' : 'text-red-600')}>{status.text}</span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-6 text-xs">
        <div className="mx-auto max-w-3xl space-y-6">
          {!settings ? (
            <p className="text-muted-foreground">{t('composer.loading')}</p>
          ) : tab === 'general' ? (
            <>
              <section className="space-y-3">
                <div className={section}>{t('settingsPage.language')}</div>
                <div className={row}>
                  <span className={label}>{t('settingsPage.interfaceLanguage')}</span>
                  <select
                    className={select}
                    value={i18n.language?.startsWith('vi') ? 'vi' : 'en'}
                    onChange={(e) => changeLanguage(e.target.value as 'en' | 'vi')}
                  >
                    <option value="en">English</option>
                    <option value="vi">Tiếng Việt</option>
                  </select>
                </div>
                <div className={row}>
                  <span className={label}>{t('settingsPage.generatedLanguage')}</span>
                  <select
                    className={select}
                    value={settings.ai.generatedContentLanguage}
                    onChange={(e) =>
                      void patch({ ai: { generatedContentLanguage: e.target.value as 'follow' | 'en' | 'vi' } })
                    }
                  >
                    <option value="follow">{t('settingsPage.followInterface')}</option>
                    <option value="en">English</option>
                    <option value="vi">Tiếng Việt</option>
                  </select>
                </div>
                <p className="pl-[236px] text-[11px] text-muted-foreground">
                  {t('settingsPage.generatedLanguageHint')}
                </p>
              </section>
              <section className="space-y-3">
                <div className={section}>{t('settingsPage.window')}</div>
                <div className={row}>
                  <span className={label}>{t('settingsPage.openIn')}</span>
                  <select
                    className={select}
                    value={settings.launch.openIn}
                    onChange={(e) => void patch({ launch: { openIn: e.target.value as 'app' | 'browser' } })}
                  >
                    <option value="app">{t('settingsPage.openInApp')}</option>
                    <option value="browser">{t('settingsPage.openInBrowser')}</option>
                  </select>
                </div>
                <p className="pl-[236px] text-[11px] text-muted-foreground">{t('settingsPage.openInHint')}</p>
              </section>
              <section className="space-y-3">
                <div className={section}>{t('settingsPage.updates')}</div>
                <label className={row}>
                  <span className={label}>{t('settingsPage.checkUpdates')}</span>
                  <input
                    type="checkbox"
                    checked={settings.update.check}
                    onChange={(e) => {
                      void patch({ update: { check: e.target.checked } }).then(() =>
                        queryClient.invalidateQueries({ queryKey: ['version'] })
                      );
                    }}
                  />
                  <span className="text-[11px] text-muted-foreground">{t('settingsPage.checkUpdatesHint')}</span>
                </label>
              </section>
              <section className="space-y-3">
                <div className={section}>{t('settingsPage.appearance')}</div>
                <div className={row}>
                  <span className={label}>{t('settingsPage.theme')}</span>
                  <select
                    className={select}
                    value={themeSetting}
                    onChange={(e) => changeTheme(e.target.value as 'light' | 'dark' | 'system')}
                  >
                    {(['light', 'dark', 'system'] as const).map((x) => (
                      <option key={x} value={x}>
                        {t(`theme.${x}`)}
                      </option>
                    ))}
                  </select>
                </div>
              </section>
            </>
          ) : tab === 'models' ? (
            <ModelsTab />
          ) : tab === 'defaults' ? (
            <section className="space-y-3">
              <div className={section}>{t('settingsPage.defaultModels')}</div>
              {(['supervisor', 'worker', 'generate', 'fallback'] as const).map((k) => (
                <div key={k} className={row}>
                  <span className={label}>{t(`settingsPage.defaultModel.${k}`)}</span>
                  <div className="w-72">
                    <ModelPicker
                      value={settings.models.defaults[k]}
                      onChange={(model) => void patch({ models: { defaults: { [k]: model ?? 'inherit' } } })}
                    />
                  </div>
                </div>
              ))}
              <p className="text-[11px] text-muted-foreground">{t('settingsPage.defaultsHint')}</p>
            </section>
          ) : tab === 'limits' ? (
            <LimitsTab settings={settings} patch={patch} />
          ) : (
            <AccountTab projectPath={project?.path} homeDir={project?.homeDir} />
          )}
        </div>
      </div>
    </main>
  );
}

/** Exactly the models Claude Code offers this account (`/model`); nothing typed by hand. */
function ModelsTab() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { data: catalog, isFetching } = useModelCatalog();
  const refresh = async () => {
    const next = await api('/api/models/refresh', { body: {} });
    queryClient.setQueryData(['models'], next);
  };
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <span className={section}>{t('settingsPage.modelsFromAccount')}</span>
        <span className="ml-auto text-muted-foreground">
          {catalog?.fetchedAt &&
            t('settingsPage.updatedAt', {
              time: new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' }).format(
                new Date(catalog.fetchedAt)
              ),
            })}
          {catalog?.source === 'fallback' && ` · ${t('settingsPage.fallbackList')}`}
        </span>
        <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => void refresh()}>
          <RefreshCw className={isFetching ? 'animate-spin' : ''} />
          {t('settingsPage.refresh')}
        </Button>
      </div>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {(catalog?.models ?? []).map((m) => (
          <li key={m.value} className="flex items-center gap-3 px-3 py-1.5">
            <span className="text-emerald-600">✓</span>
            <span className="w-48 font-medium">{m.displayName}</span>
            <span className="w-56 truncate font-mono text-muted-foreground">{m.resolvedModel ?? m.value}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{m.description}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LimitsTab({
  settings,
  patch,
}: {
  settings: AppSettings;
  patch: (b: DeepPartial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [cleanup, setCleanup] = useState<string | null>(null);
  const d = settings.limits.defaults;
  const s = settings.limits.session;
  const field = (value: number, onCommit: (n: number) => void, min = 1) => (
    <input
      type="number"
      min={min}
      defaultValue={value}
      key={value}
      className={num}
      onBlur={(e) => {
        const n = Math.max(min, Math.floor(Number(e.target.value) || min));
        if (n !== value) onCommit(n);
      }}
    />
  );
  return (
    <>
      <section className="space-y-3">
        <div className={section}>{t('settingsPage.global')}</div>
        <div className={row}>
          <span className={label}>{t('settingsPage.maxConcurrent')}</span>
          {field(d.maxConcurrentAgents, (n) => void patch({ limits: { defaults: { maxConcurrentAgents: n } } }))}
          <span className="text-[11px] text-muted-foreground">{t('settingsPage.maxConcurrentHint')}</span>
        </div>
        <div className={row}>
          <span className={label}>{t('settingsPage.idleSuspend')}</span>
          {field(d.idleSuspendMinutes, (n) => void patch({ limits: { defaults: { idleSuspendMinutes: n } } }), 0)}
          <span className="text-muted-foreground">{t('sessionSettings.minutes')}</span>
        </div>
        <div className={row}>
          <span className={label}>{t('settingsPage.retention')}</span>
          {field(d.eventsRetentionDays, (n) => void patch({ limits: { defaults: { eventsRetentionDays: n } } }))}
          <span className="text-muted-foreground">{t('settingsPage.days')}</span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            onClick={async () => {
              const res = await api<{ deleted: number }>('/api/settings/cleanup', { body: {} });
              setCleanup(t('settingsPage.cleanedUp', { count: res.deleted }));
            }}
          >
            {t('settingsPage.cleanUpNow')}
          </Button>
          {cleanup && <span className="text-emerald-600">{cleanup}</span>}
        </div>
      </section>
      <section className="space-y-3">
        <div className={section}>{t('settingsPage.sessionDefaults')}</div>
        <div className={row}>
          <span className={label}>{t('sessionSettings.maxDepth')}</span>
          {field(s.maxDepth, (n) => void patch({ limits: { session: { maxDepth: n } } }))}
        </div>
        <div className={row}>
          <span className={label}>{t('sessionSettings.maxTotal')}</span>
          {field(s.maxTotalAgents, (n) => void patch({ limits: { session: { maxTotalAgents: n } } }))}
        </div>
        <div className={row}>
          <span className={label}>{t('sessionSettings.maxTokens')}</span>
          {field(s.maxTokens, (n) => void patch({ limits: { session: { maxTokens: n } } }))}
          <span className="text-muted-foreground">{formatTokens(s.maxTokens)}</span>
        </div>
        <div className={row}>
          <span className={label}>{t('sessionSettings.maxTurns')}</span>
          {field(s.maxTurns, (n) => void patch({ limits: { session: { maxTurns: n } } }))}
        </div>
        <p className="text-[11px] text-muted-foreground">{t('settingsPage.sessionDefaultsHint')}</p>
      </section>
    </>
  );
}

function AccountTab({ homeDir, projectPath }: { homeDir?: string; projectPath?: string }) {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: ['account'], queryFn: () => api<Account>('/api/account') });
  if (!data) return <p className="text-muted-foreground">{t('composer.loading')}</p>;
  const loggedIn = data.claude.login === 'logged_in';
  // One line per value; a long path is cut at the start (like the header) and shown whole on hover
  const line = (k: string, v: string) => (
    <div className="flex items-center gap-3">
      <span className={label}>{k}</span>
      <span dir="rtl" className="min-w-0 truncate text-left font-mono" title={v}>
        <bdi dir="ltr">{v}</bdi>
      </span>
    </div>
  );
  return (
    <section className="space-y-2">
      <div className={row}>
        <span className={label}>Claude Code</span>
        <span className={loggedIn ? 'text-emerald-600' : 'text-red-600'}>
          ● {loggedIn ? t('settingsPage.loggedIn') : t('settingsPage.notLoggedIn')}
          {data.claude.subscriptionType && ` · ${data.claude.subscriptionType}`}
        </span>
        <span className="text-muted-foreground">
          {t('settingsPage.rateLimit')}: {data.throttled ? t('settingsPage.rateLimited') : t('settingsPage.normal')}
        </span>
      </div>
      {!loggedIn && <p className="pl-[236px] text-[11px] text-muted-foreground">{t('settingsPage.loginHint')}</p>}
      {line(t('settingsPage.dataDir'), shortenPath(data.dataDir, homeDir))}
      {line(t('settingsPage.claudeDir'), shortenPath(data.claudeDir, homeDir))}
      {line(t('settingsPage.server'), data.server)}
      {projectPath && line(t('project'), shortenPath(projectPath, homeDir))}
      {line(t('settingsPage.version'), data.version)}
    </section>
  );
}
