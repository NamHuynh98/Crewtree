// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Bot,
  ChevronsDownUp,
  ChevronsUpDown,
  ListTree,
  Loader2,
  Maximize,
  Pause,
  Play,
  Plus,
  Settings2,
  Square,
  X,
} from 'lucide-react';
import { useShell } from '@/app/shell';
import { relativePath, shortenPath } from '@/lib/paths';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { StatusBadge, sessionVisual } from '@/components/StatusBadge';
import { ApprovalList } from '@/components/workspace/ApprovalList';
import { Composer, type ComposerHandle } from '@/features/composer/Composer';
import { useModelCatalog } from '@/features/model-picker/ModelPicker';
import { useAgents } from '@/pages/AgentsPage';
import { AddAgentsDialog, sessionCandidates } from '@/features/sessions/AddAgentsDialog';
import { useWorkspace } from '@/features/workspace/useWorkspace';
import { MessageList } from '@/features/workspace/MessageList';
import { buildNodeInfo, canDelegate, formatTokens, snapshotFields } from '@/features/workspace/agentInfo';
import { AgentPalette, OutlinePanel, TreeCanvas } from '@/features/workspace/canvas/TreeCanvas';
import { descendantsOf } from '@/features/workspace/canvas/layout';
import { AgentDrawer, type DrawerTab } from '@/features/workspace/drawer/AgentDrawer';
import { FilesTab } from '@/features/workspace/files/FilesTab';
import { ChangeList } from '@/features/workspace/files/ChangesTab';
import type { ViewerMode } from '@/features/workspace/files/FileViewer';
import { SessionSettingsPanel } from '@/features/workspace/SessionSettingsPanel';
import { NodeContextMenu, ModelMenu } from '@/features/workspace/canvas/NodeMenus';

type MainTab = 'tree' | 'files' | 'changes';

function useIsDark() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** Session Workspace (UI-WIREFRAMES 2). */
export function WorkspacePage() {
  const { id } = useParams();
  return id ? <Workspace key={id} sessionId={id} /> : null;
}

function Workspace({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { project } = useShell();
  const dark = useIsDark();
  const ws = useWorkspace(sessionId);
  const { data: catalog } = useModelCatalog();
  const { data: library = [] } = useAgents();

  const [tab, setTab] = useState<MainTab>('tree');
  const [drawer, setDrawer] = useState<{ id: string; tab: DrawerTab } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const [fitSignal, setFitSignal] = useState(0);
  const [showOutline, setShowOutline] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [addDialog, setAddDialog] = useState<{ parent?: string } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [modelMenu, setModelMenu] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [openFile, setOpenFile] = useState<{ path: string; mode: ViewerMode } | null>(null);
  const [chatWidth, setChatWidth] = useState(() => Number(localStorage.getItem('crewtree.chatWidth')) || 380);
  const [showApprovals, setShowApprovals] = useState(true);
  const composer = useRef<ComposerHandle>(null);

  const supervisorId = ws.session?.supervisorAgentId;
  const cwdRef = useRef('');
  cwdRef.current = ws.session?.cwd ?? '';
  const info = useMemo(
    () => buildNodeInfo(ws.agents, ws.tasks, ws.approvals, ws.stats, supervisorId),
    [ws.agents, ws.tasks, ws.approvals, ws.stats, supervisorId]
  );
  const conflictIds = useMemo(
    () => new Set(ws.conflicts.flatMap((c) => [c.agentId, c.holderAgentId].filter(Boolean) as string[])),
    [ws.conflicts]
  );
  const candidates = useMemo(() => sessionCandidates(library), [library]);

  const focusAgent = useCallback((agentId: string) => {
    setTab('tree');
    setFocus((prev) => ({ id: agentId, n: (prev?.n ?? 0) + 1 }));
  }, []);
  const openAgent = useCallback(
    (agentId: string, drawerTab: DrawerTab = 'activity') => setDrawer({ id: agentId, tab: drawerTab }),
    []
  );
  const openFileAt = useCallback((path: string, mode: ViewerMode = 'view') => {
    setTab('files');
    setDrawer(null);
    setOpenFile({ path: relativePath(cwdRef.current, path), mode });
  }, []);
  const toggleCollapse = useCallback(
    (agentId: string) =>
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(agentId)) next.delete(agentId);
        else next.add(agentId);
        return next;
      }),
    []
  );

  // Parent choices: agents that can delegate (UI-WIREFRAMES 1 add agent dialog)
  const parentOptions = ws.agents
    .filter((a) => canDelegate(a, a.id === supervisorId))
    .map((a) => ({
      value: a.id,
      label: a.alias || a.agentName,
      delegates: a.id === supervisorId ? ('*' as const) : snapshotFields(a).delegates,
    }));

  const addAgents = async (names: string[], parent: string) => {
    for (const name of names) await ws.addAgent(name, parent === supervisorId ? undefined : parent);
  };

  const startResize = (e: React.MouseEvent) => {
    const startX = e.clientX;
    const start = chatWidth;
    const move = (ev: MouseEvent) => setChatWidth(Math.min(720, Math.max(280, start + ev.clientX - startX)));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setChatWidth((w) => {
        localStorage.setItem('crewtree.chatWidth', String(w));
        return w;
      });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  if (ws.notFound) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        {t('workspace.notFound')}
        <Button size="sm" variant="outline" onClick={() => navigate('/')}>
          {t('workspace.back')}
        </Button>
      </main>
    );
  }
  if (!ws.session) {
    return (
      <main className="flex flex-1 items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </main>
    );
  }

  const session = ws.session;
  const supervisorName = ws.supervisor ? ws.supervisor.alias || ws.supervisor.agentName : 'Supervisor';
  const rootQuestion = ws.tasks.find((x) => x.isRoot && x.status === 'needs_input');
  const totalTokens = session.totalTokens + ws.usage.inputTokens + ws.usage.outputTokens;
  const totalTurns = Object.values(ws.stats).reduce((n, s) => n + s.turns, 0);
  const allCollapsed = collapsed.size > 0;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex h-11 select-none items-center gap-3 border-b border-border bg-card px-3 text-xs">
        <button
          onClick={() => navigate('/')}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          title={t('workspace.back')}
          aria-label={t('workspace.back')}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="min-w-0 truncate text-sm font-semibold" title={session.title}>
          {session.title}
        </span>
        <StatusBadge
          visual={sessionVisual(session.status, ws.workspaceBusy ? 'running' : 'idle')}
          label={ws.workspaceBusy ? t('status.running') : t(`sessionStatus.${session.status}`)}
        />
        <span
          className="hidden min-w-0 max-w-[32%] truncate font-mono text-muted-foreground md:inline"
          title={session.cwd}
        >
          {shortenPath(session.cwd, project?.homeDir)}
        </span>
        <span className="ml-auto shrink-0 whitespace-nowrap text-muted-foreground">
          {formatTokens(totalTokens)} tok · {t('node.turns', { count: totalTurns })}
        </span>
        {ws.approvals.length > 0 && (
          <button
            type="button"
            className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400"
            onClick={() => setShowApprovals(true)}
          >
            ⚑ {ws.approvals.length}
          </button>
        )}
        <Button
          size="sm"
          variant={settingsOpen ? 'secondary' : 'outline'}
          className="h-7 text-[11px]"
          onClick={() => setSettingsOpen((v) => !v)}
        >
          <Settings2 />
          {t('workspace.sessionSettings')}
        </Button>
        {session.status === 'paused' ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            onClick={() => void ws.sessionAction('resume')}
            title={t('session.resume')}
          >
            <Play />
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            onClick={() => void ws.sessionAction('pause')}
            title={t('session.pause')}
          >
            <Pause />
          </Button>
        )}
        <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => void ws.sessionAction('stop')}>
          <Square />
          {t('session.stop')}
        </Button>
      </div>

      {ws.error && (
        <div className="flex items-center gap-2 border-b border-border bg-red-50 px-4 py-1 text-[11px] text-red-700 dark:bg-red-950/30 dark:text-red-400">
          {ws.error}
          <button type="button" className="ml-auto" onClick={ws.clearError} aria-label={t('actions.close')}>
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {/* Chat with the Supervisor */}
        <section className="flex shrink-0 flex-col border-r border-border" style={{ width: chatWidth }}>
          <div className="border-b border-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t('workspace.chatWith', { name: supervisorName })}
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {ws.chat.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-xs text-muted-foreground">
                <Bot className="mb-2 h-8 w-8 text-primary opacity-50" />
                <p>{t('workspace.emptyChatTitle')}</p>
                <p className="mt-0.5 text-[11px]">{t('workspace.emptyChatBody')}</p>
              </div>
            ) : (
              <MessageList
                messages={ws.chat}
                agents={ws.agents}
                agentName={supervisorName}
                onFocusAgent={focusAgent}
                onOpenFile={(p) => openFileAt(p)}
                onInterrupt={() => void ws.interrupt()}
              />
            )}
            {ws.supervisorBusy && (
              <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                {t('chat.thinking', { name: supervisorName })}
              </div>
            )}
            <ScrollAnchor dep={ws.chat} />
          </div>
          {(rootQuestion || (showApprovals && ws.approvals.length > 0)) && (
            <div className="max-h-[45%] space-y-2 overflow-y-auto border-t border-border bg-card/60 p-2">
              {rootQuestion && (
                <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-2.5 text-xs dark:border-amber-900 dark:bg-amber-950/20">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <span className="text-amber-500">⚑</span>
                    {t('session.needsInput')}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap">{rootQuestion.question}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">{t('session.answerHint')}</p>
                </div>
              )}
              {showApprovals && ws.approvals.length > 0 && (
                <>
                  <div className="flex items-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('approvals.title')}
                    <button type="button" className="ml-auto normal-case" onClick={() => setShowApprovals(false)}>
                      {t('workspace.hide')}
                    </button>
                  </div>
                  <ApprovalList approvals={ws.approvals} agents={ws.agents} onDecide={ws.decideApproval} />
                </>
              )}
            </div>
          )}
          <div className="border-t border-border bg-card p-2">
            <Composer
              handleRef={composer}
              ctx={{ sessionId }}
              agents={ws.agents.map((a) => a.alias || a.agentName)}
              placeholder={t('chat.placeholder', { name: supervisorName })}
              target={supervisorName}
              busy={ws.supervisorBusy}
              onStop={() => void ws.interrupt()}
              onSend={(payload) => ws.sendMessage(payload)}
            />
          </div>
        </section>
        <div
          className="w-1 shrink-0 cursor-col-resize hover:bg-primary/30"
          onMouseDown={startResize}
          role="separator"
          aria-orientation="vertical"
        />

        {/* Tree · Files · Changes */}
        <section className="relative flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b border-border px-2 py-1.5 text-xs">
            {(['tree', 'files', 'changes'] as const).map((x) => (
              <button
                key={x}
                type="button"
                onClick={() => setTab(x)}
                className={cn(
                  'rounded-md px-2.5 py-1',
                  tab === x ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent'
                )}
              >
                {t(`workspace.tabs.${x}`)}
              </button>
            ))}
            {tab === 'tree' && (
              <span className="ml-auto flex items-center gap-1">
                <Button
                  size="sm"
                  variant={showOutline ? 'secondary' : 'ghost'}
                  className="h-7 text-[11px]"
                  onClick={() => setShowOutline((v) => !v)}
                >
                  <ListTree />
                  {t('canvas.outline')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-[11px]"
                  onClick={() =>
                    setCollapsed(
                      allCollapsed
                        ? new Set()
                        : new Set(
                            ws.agents
                              .filter((a) => a.id !== supervisorId && descendantsOf(ws.agents, a.id).length)
                              .map((a) => a.id)
                          )
                    )
                  }
                >
                  {allCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
                  {allCollapsed ? t('canvas.expandAll') : t('canvas.collapseAll')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-[11px]"
                  onClick={() => setFitSignal((n) => n + 1)}
                >
                  <Maximize />
                  {t('canvas.fit')}
                </Button>
                <Button
                  size="sm"
                  variant={showPalette ? 'secondary' : 'ghost'}
                  className="h-7 text-[11px]"
                  onClick={() => setShowPalette((v) => !v)}
                  title={t('canvas.addAgents')}
                >
                  <Plus />
                </Button>
              </span>
            )}
          </div>
          <div className="relative min-h-0 flex-1">
            {tab === 'tree' && (
              <div className="absolute inset-0 flex">
                {showOutline && (
                  <div className="w-52 shrink-0 overflow-y-auto border-r border-border bg-card p-2">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {t('canvas.outline')}
                    </div>
                    <OutlinePanel
                      agents={ws.agents}
                      info={info}
                      onSelect={(agentId) => {
                        focusAgent(agentId);
                      }}
                    />
                  </div>
                )}
                <div className="relative min-w-0 flex-1">
                  <TreeCanvas
                    sessionId={sessionId}
                    agents={ws.agents}
                    tasks={ws.tasks}
                    info={info}
                    catalog={catalog}
                    collapsed={collapsed}
                    onToggleCollapse={toggleCollapse}
                    focus={focus}
                    fitSignal={fitSignal}
                    conflictIds={conflictIds}
                    onOpen={openAgent}
                    onApprove={(approvalId, allow) =>
                      void ws.decideApproval(approvalId, { decision: allow ? 'allow' : 'deny', rule: 'once' })
                    }
                    onContextMenu={(agentId, x, y) => setMenu({ id: agentId, x, y })}
                    onModelClick={(agentId, rect) => setModelMenu({ id: agentId, rect })}
                    onDropAgent={(name, parentId) =>
                      void ws.addAgent(name, parentId === supervisorId ? undefined : parentId)
                    }
                  />
                </div>
                {showPalette && (
                  <div className="w-56 shrink-0 border-l border-border bg-card">
                    <AgentPalette
                      agents={candidates}
                      title={t('canvas.library')}
                      hint={t('canvas.dragHint')}
                      addLabel={t('canvas.addEllipsis')}
                      onAddClick={() => setAddDialog({})}
                    />
                  </div>
                )}
              </div>
            )}
            {tab === 'files' && (
              <FilesTab
                ws={ws}
                dark={dark}
                open={openFile}
                onOpen={(path, mode = 'view') => setOpenFile(path ? { path, mode } : null)}
                onMention={(path, range) => composer.current?.insertFile(path, range)}
              />
            )}
            {tab === 'changes' && (
              <div className="absolute inset-0 overflow-y-auto p-4">
                <ChangeList
                  sessionId={sessionId}
                  subscribe={ws.subscribe}
                  tasks={ws.tasks}
                  onOpen={(p) => openFileAt(p, 'diff')}
                />
              </div>
            )}
          </div>

          {drawer && (
            <AgentDrawer
              ws={ws}
              agentId={drawer.id}
              tab={drawer.tab}
              onTab={(x) => setDrawer({ ...drawer, tab: x })}
              onClose={() => setDrawer(null)}
              onOpenFile={openFileAt}
              onFocusAgent={(agentId) => {
                focusAgent(agentId);
                setDrawer((d) => (d ? { ...d, id: agentId } : d));
              }}
            />
          )}
          {settingsOpen && <SessionSettingsPanel ws={ws} onClose={() => setSettingsOpen(false)} />}

          {/* File conflict warnings (UI-WIREFRAMES 5) */}
          <div className="pointer-events-none absolute bottom-3 left-3 z-40 space-y-2">
            {ws.conflicts.map((c) => {
              const who = ws.agents.find((a) => a.id === c.agentId);
              const holder = ws.agents.find((a) => a.id === c.holderAgentId);
              return (
                <div
                  key={c.id}
                  className="pointer-events-auto max-w-md rounded-lg border border-red-300 bg-card p-2.5 text-xs shadow-lg dark:border-red-900"
                >
                  <p>
                    ⚠{' '}
                    {t('conflict.message', {
                      agent: who ? who.alias || who.agentName : '?',
                      path: c.path,
                      holder: holder ? holder.alias || holder.agentName : '?',
                      task: c.holderTaskTitle ?? '—',
                    })}
                  </p>
                  <p className="text-muted-foreground">{t('conflict.reported')}</p>
                  <div className="mt-1.5 flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[11px]"
                      onClick={() => c.agentId && focusAgent(c.agentId)}
                    >
                      {t('conflict.view')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-[11px]"
                      onClick={() => ws.dismissConflict(c.id)}
                    >
                      {t('conflict.dismiss')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {menu && (
        <NodeContextMenu
          ws={ws}
          agentId={menu.id}
          x={menu.x}
          y={menu.y}
          collapsed={collapsed.has(menu.id)}
          canAddChild={parentOptions.some((p) => p.value === menu.id)}
          onClose={() => setMenu(null)}
          onOpen={openAgent}
          onToggleCollapse={toggleCollapse}
          onAddChild={(parent) => setAddDialog({ parent })}
          onChangeModel={(rect) => setModelMenu({ id: menu.id, rect })}
        />
      )}
      {modelMenu && (
        <ModelMenu
          ws={ws}
          agentId={modelMenu.id}
          rect={modelMenu.rect}
          catalog={catalog}
          onClose={() => setModelMenu(null)}
        />
      )}
      {addDialog && (
        <AddAgentsDialog
          agents={library}
          parents={parentOptions}
          defaultParent={addDialog.parent ?? supervisorId}
          onAdd={addAgents}
          onClose={() => setAddDialog(null)}
        />
      )}
    </div>
  );
}

function ScrollAnchor({ dep }: { dep: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'end' });
  }, [dep]);
  return <div ref={ref} />;
}
