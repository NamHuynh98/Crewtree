import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './index.css';
import './i18n';
import { AppShell } from './app/AppShell';
import { SessionsListPage } from './pages/SessionsListPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { AgentsPage } from './pages/AgentsPage';
import { AgentEditorPage } from './pages/AgentEditorPage';
import { SkillsPage } from './pages/config/SkillsPage';
import { CommandsPage } from './pages/config/CommandsPage';
import { MemoryPage } from './pages/config/MemoryPage';
import { McpPage } from './pages/config/McpPage';
import { PluginsPage } from './pages/config/PluginsPage';
import { SettingsPage } from './pages/SettingsPage';

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <SessionsListPage /> },
      { path: 'sessions/:id', element: <WorkspacePage /> },
      { path: 'agents', element: <AgentsPage /> },
      { path: 'agents/new', element: <AgentEditorPage key="new" /> },
      { path: 'agents/:id', element: <AgentEditorPage /> },
      { path: 'skills', element: <SkillsPage /> },
      { path: 'commands', element: <CommandsPage /> },
      { path: 'memory', element: <MemoryPage /> },
      { path: 'mcp', element: <McpPage /> },
      { path: 'plugins', element: <PluginsPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>
);
