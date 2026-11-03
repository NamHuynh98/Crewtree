// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { ModelCatalog } from '@/features/resources/types';
import { useAgents } from '@/pages/AgentsPage';
import { effectiveModel, isTerminalTask } from '../agentInfo';
import type { Workspace } from '../useWorkspace';
import type { DrawerTab } from '../drawer/AgentDrawer';

function useDismiss(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return ref;
}

const item = 'flex w-full items-center rounded px-2 py-1.5 text-left text-xs hover:bg-accent disabled:opacity-40';

/** Node context menu (UI-WIREFRAMES 2). */
export function NodeContextMenu({
  ws,
  agentId,
  x,
  y,
  collapsed,
  canAddChild,
  onClose,
  onOpen,
  onToggleCollapse,
  onAddChild,
  onChangeModel,
}: {
  ws: Workspace;
  agentId: string;
  x: number;
  y: number;
  collapsed: boolean;
  canAddChild: boolean;
  onClose: () => void;
  onOpen: (id: string, tab?: DrawerTab) => void;
  onToggleCollapse: (id: string) => void;
  onAddChild: (parentId: string) => void;
  onChangeModel: (rect: DOMRect) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const ref = useDismiss(onClose);
  const { data: library = [] } = useAgents();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const agent = ws.agents.find((a) => a.id === agentId);
  if (!agent) return null;
  const isSupervisor = agent.id === ws.session?.supervisorAgentId;
  const current = ws.tasks.find((task) => task.toAgentId === agent.id && !isTerminalTask(task));
  const libraryItem = library.find((a) => a.name === agent.agentName && a.scope === agent.scope);
  const hasChildren = ws.agents.some((a) => a.parentId === agent.id);
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 w-56 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{ left: Math.min(x, window.innerWidth - 232), top: Math.min(y, window.innerHeight - 320) }}
    >
      <button type="button" className={item} onClick={act(() => onOpen(agent.id, 'activity'))}>
        {t('menu.viewDetails')}
      </button>
      <button type="button" className={item} onClick={act(() => onOpen(agent.id, 'chat'))}>
        {t('menu.chat')}
      </button>
      <button
        type="button"
        className={item}
        onClick={(e) => {
          onChangeModel((e.currentTarget as HTMLElement).getBoundingClientRect());
          onClose();
        }}
      >
        {t('menu.changeModel')} <span className="ml-auto">▸</span>
      </button>
      <button type="button" className={item} disabled={!canAddChild} onClick={act(() => onAddChild(agent.id))}>
        {t('menu.addChild')}
      </button>
      <button type="button" className={item} disabled={!hasChildren} onClick={act(() => onToggleCollapse(agent.id))}>
        {collapsed ? t('menu.expand') : t('menu.collapse')}
      </button>
      <button
        type="button"
        className={item}
        disabled={!current}
        onClick={act(() => current && void ws.cancelTask(current.id))}
      >
        {t('menu.stopTask')}
      </button>
      <button
        type="button"
        className={item}
        disabled={!libraryItem}
        onClick={act(() => libraryItem && navigate(`/agents/${libraryItem.id}`))}
      >
        {t('menu.openInEditor')}
      </button>
      {!isSupervisor && (
        <>
          <div className="my-1 border-t border-border" />
          {confirmRemove ? (
            <button
              type="button"
              className={`${item} font-medium text-red-600`}
              onClick={act(() => void ws.removeAgent(agent.id))}
            >
              {t('menu.removeConfirm')}
            </button>
          ) : (
            <button type="button" className={`${item} text-red-600`} onClick={() => setConfirmRemove(true)}>
              {t('menu.remove')}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** "Change model (this session)": override without editing the agent file (PLAN.md 7). */
export function ModelMenu({
  ws,
  agentId,
  rect,
  catalog,
  onClose,
}: {
  ws: Workspace;
  agentId: string;
  rect: DOMRect;
  catalog?: ModelCatalog;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useDismiss(onClose);
  const agent = ws.agents.find((a) => a.id === agentId);
  if (!agent) return null;
  const current = effectiveModel(agent);
  const choose = (model: string | null) => {
    void ws.updateAgent(agent.id, { modelOverride: model });
    onClose();
  };
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 max-h-80 w-64 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{
        left: Math.min(rect.left, window.innerWidth - 272),
        top: Math.min(rect.bottom + 4, window.innerHeight - 330),
      }}
    >
      <div className="px-2 py-1 text-[10px] text-muted-foreground">{t('menu.modelHint')}</div>
      {(catalog?.models ?? []).map((m) => (
        <button key={m.value} type="button" className={item} onClick={() => choose(m.value)}>
          <span className="w-4">{current === m.value ? '●' : ''}</span>
          <span className="truncate">{m.displayName}</span>
        </button>
      ))}
      {agent.modelOverride && (
        <>
          <div className="my-1 border-t border-border" />
          <button type="button" className={item} onClick={() => choose(null)}>
            {t('drawer.resetOverride')}
          </button>
        </>
      )}
    </div>
  );
}
