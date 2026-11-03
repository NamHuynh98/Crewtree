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
import { ComingSoonPage, ResourceListPage } from './pages/ResourceListPage';

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
      { path: 'skills', element: <ResourceListPage kind="skills" key="skills" /> },
      { path: 'commands', element: <ResourceListPage kind="commands" key="commands" /> },
      { path: 'memory', element: <ResourceListPage kind="memory" key="memory" /> },
      { path: 'mcp', element: <ResourceListPage kind="mcp" key="mcp" /> },
      { path: 'plugins', element: <ResourceListPage kind="plugins" key="plugins" /> },
      { path: 'settings', element: <ComingSoonPage titleKey="settings" /> },
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
