// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext } from 'react';

export interface ProjectInfo {
  path: string;
  name: string;
  homeDir: string;
}

export interface ShellContextValue {
  project: ProjectInfo | null;
  refreshApprovals: () => void;
  notify: (message: string) => void;
  /** Theme and language, shared by the header menus and Settings → General */
  themeSetting: 'light' | 'dark' | 'system';
  changeTheme: (theme: 'light' | 'dark' | 'system') => void;
  changeLanguage: (language: 'en' | 'vi') => void;
  /** Opens the Ctrl+K command palette */
  openPalette: () => void;
}

export const ShellContext = createContext<ShellContextValue>({
  project: null,
  refreshApprovals: () => undefined,
  notify: () => undefined,
  themeSetting: 'system',
  changeTheme: () => undefined,
  changeLanguage: () => undefined,
  openPalette: () => undefined,
});

export const useShell = () => useContext(ShellContext);
