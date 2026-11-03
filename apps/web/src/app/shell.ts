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
}

export const ShellContext = createContext<ShellContextValue>({
  project: null,
  refreshApprovals: () => undefined,
  notify: () => undefined,
});

export const useShell = () => useContext(ShellContext);
