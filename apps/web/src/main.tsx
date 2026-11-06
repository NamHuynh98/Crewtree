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

/*
 * Each page is its own chunk, loaded when first opened: the first screen does not pay for the tree canvas,
 * the code editors or the chat composer. The sessions list, the usual first screen, stays in the main chunk.
 */
const page = (load: () => Promise<{ Component: React.ComponentType }>) => ({ lazy: load });

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    // The first page chunk is local and loads in a few ms: show nothing rather than a flash of a spinner
    HydrateFallback: () => null,
    children: [
      { index: true, element: <SessionsListPage /> },
      {
        path: 'sessions/:id',
        ...page(() => import('./pages/WorkspacePage').then((m) => ({ Component: m.WorkspacePage }))),
      },
      { path: 'agents', ...page(() => import('./pages/AgentsPage').then((m) => ({ Component: m.AgentsPage }))) },
      {
        path: 'agents/new',
        ...page(() =>
          import('./pages/AgentEditorPage').then((m) => ({ Component: () => <m.AgentEditorPage key="new" /> }))
        ),
      },
      {
        path: 'agents/:id',
        ...page(() => import('./pages/AgentEditorPage').then((m) => ({ Component: m.AgentEditorPage }))),
      },
      { path: 'skills', ...page(() => import('./pages/config/SkillsPage').then((m) => ({ Component: m.SkillsPage }))) },
      {
        path: 'commands',
        ...page(() => import('./pages/config/CommandsPage').then((m) => ({ Component: m.CommandsPage }))),
      },
      { path: 'memory', ...page(() => import('./pages/config/MemoryPage').then((m) => ({ Component: m.MemoryPage }))) },
      { path: 'mcp', ...page(() => import('./pages/config/McpPage').then((m) => ({ Component: m.McpPage }))) },
      {
        path: 'plugins',
        ...page(() => import('./pages/config/PluginsPage').then((m) => ({ Component: m.PluginsPage }))),
      },
      { path: 'settings', ...page(() => import('./pages/SettingsPage').then((m) => ({ Component: m.SettingsPage }))) },
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
