// SPDX-License-Identifier: Apache-2.0
export type ThemeSetting = 'light' | 'dark' | 'system';
export type LanguageSetting = 'en' | 'vi';

export interface BootSettings {
  language: LanguageSetting;
  theme: ThemeSetting;
}

declare global {
  interface Window {
    __BOOT__?: Partial<BootSettings>;
  }
}

/** Injected into index.html by the server (or the Vite dev plugin) before React renders. */
export function getBoot(): BootSettings {
  return { language: window.__BOOT__?.language ?? 'en', theme: window.__BOOT__?.theme ?? 'system' };
}

export function resolveTheme(theme: ThemeSetting): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Persists UI settings to app_settings (PATCH /api/settings). Throws when the server rejects it. */
export async function saveUiSettings(ui: Partial<BootSettings>): Promise<void> {
  const res = await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ui }),
  });
  if (!res.ok) throw new Error(`Saving settings failed (${res.status})`);
}
