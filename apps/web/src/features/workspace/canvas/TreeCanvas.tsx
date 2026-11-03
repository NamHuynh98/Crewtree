// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Background,
  BaseEdge,
  EdgeLabelRenderer,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  getSmoothStepPath,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { SessionAgent, Task } from '@crewtree/shared';
import type { ModelCatalog, ResourceItem } from '@/features/resources/types';
import { StatusDot, agentVisual } from '@/components/StatusBadge';
import { BUSY_STATUSES } from '../chat';
import { isTerminalTask, type NodeInfo } from '../agentInfo';
import { AgentNode, type AgentFlowNode } from './AgentNode';
import { descendantsOf, layoutTree, visibleAgents } from './layout';

export interface CanvasHandlers {
  onOpen: (id: string, tab?: 'activity' | 'chat') => void;
  onApprove: (approvalId: string, allow: boolean) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
  onModelClick: (id: string, anchor: DOMRect) => void;
  /** An agent from the palette was dropped on a node */
  onDropAgent: (agentName: string, parentId: string) => void;
}

interface Props extends CanvasHandlers {
  sessionId: string;
  agents: SessionAgent[];
  tasks: Task[];
  info: Map<string, NodeInfo>;
  catalog?: ModelCatalog;
  collapsed: Set<string>;
  onToggleCollapse: (id: string) => void;
  focus: { id: string; n: number } | null;
  conflictIds: Set<string>;
  fitSignal: number;
}

export const AGENT_DRAG_TYPE = 'application/x-crewtree-agent';

interface TaskEdgeData extends Record<string, unknown> {
  active: Task[];
  total: number;
}

/** Dashed and animated while a task runs on that link; one edge per pair with a "3 tasks" badge. */
function TaskEdge(props: EdgeProps<Edge<TaskEdgeData>>) {
  const { t } = useTranslation();
  const [path, labelX, labelY] = getSmoothStepPath({ ...props, borderRadius: 10 });
  const active = props.data?.active ?? [];
  const total = props.data?.total ?? 0;
  return (
    <>
      <BaseEdge
        path={path}
        style={{
          stroke: active.length ? 'hsl(var(--primary))' : 'hsl(var(--border))',
          strokeWidth: active.length ? 1.6 : 1.2,
          strokeDasharray: active.length ? '6 4' : undefined,
          animation: active.length ? 'crewtree-dash 0.8s linear infinite' : undefined,
        }}
      />
      {total > 1 && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute rounded-full border border-border bg-card px-1.5 text-[9px] text-muted-foreground"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title={active.map((x) => x.title).join('\n')}
          >
            {t('canvas.tasks', { count: total })}
          </div>
        </EdgeLabelRenderer>
      )}
      {total === 1 && active[0] && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute h-3 w-3 rounded-full"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title={active[0].title}
          />
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { agent: AgentNode };
const edgeTypes = { task: TaskEdge };

function useIsDark() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

function positionsKey(sessionId: string) {
  return `crewtree.canvas.${sessionId}`;
}

function loadPinned(sessionId: string): Record<string, { x: number; y: number }> {
  try {
    return JSON.parse(localStorage.getItem(positionsKey(sessionId)) ?? '{}');
  } catch {
    return {};
  }
}

function Canvas(props: Props) {
  const { agents, tasks, info, collapsed, sessionId } = props;
  const { fitView } = useReactFlow();
  const dark = useIsDark();
  const [layout, setLayout] = useState<Record<string, { x: number; y: number }>>({});
  // Positions the user dragged: kept across relayouts (UI-WIREFRAMES 2)
  const [pinned, setPinned] = useState(() => loadPinned(sessionId));
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  // Measured sizes: a controlled flow has to keep them, or the minimap and fitView skip the nodes
  const [dims, setDims] = useState<Record<string, { width: number; height: number }>>({});
  const wrapper = useRef<HTMLDivElement>(null);
  const firstFit = useRef(true);

  const visible = useMemo(() => visibleAgents(agents, collapsed), [agents, collapsed]);
  const shapeKey = visible.map((a) => `${a.id}:${a.parentId}`).join('|');

  useEffect(() => {
    let cancelled = false;
    void layoutTree(visible).then((pos) => {
      if (!cancelled) setLayout(pos);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeKey]);

  useEffect(() => {
    if (!Object.keys(layout).length) return;
    if (firstFit.current) {
      firstFit.current = false;
      requestAnimationFrame(() => fitView({ padding: 0.2, maxZoom: 1 }));
    }
  }, [layout, fitView]);

  useEffect(() => {
    if (props.fitSignal) fitView({ padding: 0.2, maxZoom: 1, duration: 300 });
  }, [props.fitSignal, fitView]);

  useEffect(() => {
    if (props.focus) fitView({ nodes: [{ id: props.focus.id }], padding: 0.6, maxZoom: 1.2, duration: 400 });
  }, [props.focus, fitView]);

  const runningCount = agents.filter((a) => a.status === 'running').length;

  const nodes: AgentFlowNode[] = useMemo(
    () =>
      visible
        .filter((a) => layout[a.id])
        .map((a) => {
          const hidden = collapsed.has(a.id) ? descendantsOf(agents, a.id) : [];
          return {
            id: a.id,
            type: 'agent' as const,
            position: pinned[a.id] ?? layout[a.id],
            measured: dims[a.id],
            data: {
              info: info.get(a.id)!,
              catalog: props.catalog,
              collapsed: collapsed.has(a.id),
              hiddenSummary: hidden.length
                ? {
                    agents: hidden.length,
                    running: agents.filter((x) => hidden.includes(x.id) && BUSY_STATUSES.includes(x.status ?? 'idle'))
                      .length,
                  }
                : undefined,
              runningCount,
              highlighted: props.focus?.id === a.id || dragOverId === a.id,
              conflict: props.conflictIds.has(a.id),
              onOpen: props.onOpen,
              onToggleCollapse: props.onToggleCollapse,
              onApprove: props.onApprove,
              onModelClick: props.onModelClick,
            },
          };
        }),
    [visible, layout, pinned, dims, info, collapsed, agents, runningCount, props, dragOverId]
  );

  const edges: Edge<TaskEdgeData>[] = useMemo(() => {
    const ids = new Set(visible.map((a) => a.id));
    return visible
      .filter((a) => a.parentId && ids.has(a.parentId))
      .map((a) => {
        const between = tasks.filter((x) => x.fromAgentId === a.parentId && x.toAgentId === a.id);
        return {
          id: `${a.parentId}->${a.id}`,
          source: a.parentId!,
          target: a.id,
          type: 'task',
          data: { active: between.filter((x) => !isTerminalTask(x)), total: between.length },
        };
      });
  }, [visible, tasks]);

  const onNodesChange = useCallback(
    (changes: NodeChange<AgentFlowNode>[]) => {
      const sized = changes.filter((c) => c.type === 'dimensions' && c.dimensions);
      if (sized.length) {
        setDims((prev) => {
          const next = { ...prev };
          for (const c of sized) if (c.type === 'dimensions' && c.dimensions) next[c.id] = c.dimensions;
          return next;
        });
      }
      const moved = changes.filter((c) => c.type === 'position' && c.position);
      if (!moved.length) return;
      setPinned((prev) => {
        const next = { ...prev };
        for (const c of moved) if (c.type === 'position' && c.position) next[c.id] = c.position;
        try {
          localStorage.setItem(positionsKey(sessionId), JSON.stringify(next));
        } catch {
          // positions are a convenience only
        }
        return next;
      });
    },
    [sessionId]
  );

  const nodeIdAt = (x: number, y: number): string | null =>
    (document.elementFromPoint(x, y)?.closest('.react-flow__node') as HTMLElement | null)?.dataset.id ?? null;

  return (
    <div
      ref={wrapper}
      className="h-full w-full"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(AGENT_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragOverId(nodeIdAt(e.clientX, e.clientY));
      }}
      onDragLeave={() => setDragOverId(null)}
      onDrop={(e) => {
        const name = e.dataTransfer.getData(AGENT_DRAG_TYPE);
        setDragOverId(null);
        if (!name) return;
        e.preventDefault();
        const target = nodeIdAt(e.clientX, e.clientY);
        if (target) props.onDropAgent(name, target);
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, node) => props.onOpen(node.id)}
        onNodeContextMenu={(e, node) => {
          e.preventDefault();
          props.onContextMenu(node.id, e.clientX, e.clientY);
        }}
        nodesConnectable={false}
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        colorMode={dark ? 'dark' : 'light'}
      >
        <Background gap={20} size={1} />
        <MiniMap
          pannable
          zoomable
          maskColor="rgba(120, 120, 140, 0.12)"
          className="!bg-card"
          nodeColor={(n) => {
            const status = (n.data as any)?.info?.agent?.status;
            return status === 'running'
              ? '#3b82f6'
              : status === 'error'
                ? '#ef4444'
                : (n.data as any)?.info?.approval
                  ? '#f59e0b'
                  : '#a1a1aa';
          }}
        />
      </ReactFlow>
    </div>
  );
}

export function TreeCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

/** Outline panel for large trees (UI-WIREFRAMES 2). */
export function OutlinePanel({
  agents,
  info,
  onSelect,
}: {
  agents: SessionAgent[];
  info: Map<string, NodeInfo>;
  onSelect: (id: string) => void;
}) {
  const roots = agents.filter((a) => !a.parentId);
  const render = (agent: SessionAgent, depth: number): React.ReactNode => {
    const children = agents.filter((a) => a.parentId === agent.id);
    const node = info.get(agent.id);
    return (
      <li key={agent.id}>
        <button
          type="button"
          onClick={() => onSelect(agent.id)}
          className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-accent"
          style={{ paddingLeft: 6 + depth * 12 }}
        >
          <span className="truncate">{agent.alias || agent.agentName}</span>
          <span className="ml-auto">
            {node?.approval ? (
              <span className="text-amber-500">⚑</span>
            ) : (
              <StatusDot visual={agentVisual(agent.status)} />
            )}
          </span>
        </button>
        {children.length > 0 && <ul>{children.map((c) => render(c, depth + 1))}</ul>}
      </li>
    );
  };
  return <ul className="space-y-0.5 text-[11px]">{roots.map((r) => render(r, 0))}</ul>;
}

/** Palette of library agents to drag onto a node (UI-WIREFRAMES 2 `[+]`). */
export function AgentPalette({
  agents,
  onAddClick,
  title,
  hint,
  addLabel,
}: {
  agents: ResourceItem[];
  onAddClick: () => void;
  title: string;
  hint: string;
  addLabel: string;
}) {
  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
        <span className="font-semibold">{title}</span>
        <button type="button" className="text-primary hover:underline" onClick={onAddClick}>
          {addLabel}
        </button>
      </div>
      <p className="px-2 py-1 text-[10px] text-muted-foreground">{hint}</p>
      <ul className="flex-1 space-y-0.5 overflow-y-auto px-1 pb-2">
        {agents.map((a) => (
          <li
            key={a.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(AGENT_DRAG_TYPE, a.name);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            className="cursor-grab rounded border border-transparent px-2 py-1 hover:border-border hover:bg-accent active:cursor-grabbing"
            title={a.description}
          >
            <div className="truncate font-medium">{a.name}</div>
            <div className="truncate text-[10px] text-muted-foreground">{a.description}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
