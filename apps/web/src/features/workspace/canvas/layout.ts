// SPDX-License-Identifier: Apache-2.0
import type { ELK } from 'elkjs/lib/elk-api.js';
import type { SessionAgent } from '@crewtree/shared';

export const NODE_WIDTH = 248;
export const NODE_HEIGHT = 128;

let elkReady: Promise<ELK> | undefined;

/**
 * elkjs is about 1.6 MB, more than the rest of the app: load it only when a tree is drawn, and run it in a Web
 * Worker so a large layout never blocks the UI. Without workers, the bundled build lays out on the main thread.
 */
function getElk(): Promise<ELK> {
  elkReady ??= (async () => {
    if (typeof Worker !== 'undefined') {
      const [{ default: ElkApi }, { default: workerUrl }] = await Promise.all([
        import('elkjs/lib/elk-api.js'),
        import('elkjs/lib/elk-worker.min.js?url'),
      ]);
      return new ElkApi({ workerUrl });
    }
    const { default: ElkBundled } = await import('elkjs/lib/elk.bundled.js');
    return new ElkBundled();
  })();
  return elkReady;
}

/** Top-down tree layout (elkjs layered), PLAN.md 12 / UI-WIREFRAMES 2. */
export async function layoutTree(agents: SessionAgent[]): Promise<Record<string, { x: number; y: number }>> {
  const ids = new Set(agents.map((a) => a.id));
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '64',
      'elk.spacing.nodeNode': '32',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.edgeRouting': 'ORTHOGONAL',
    },
    children: agents.map((a) => ({ id: a.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
    edges: agents
      .filter((a) => a.parentId && ids.has(a.parentId))
      .map((a) => ({ id: `${a.parentId}->${a.id}`, sources: [a.parentId!], targets: [a.id] })),
  };
  const result = await (await getElk()).layout(graph);
  const out: Record<string, { x: number; y: number }> = {};
  for (const n of result.children ?? []) out[n.id] = { x: n.x ?? 0, y: n.y ?? 0 };
  return out;
}

/** Ids of every descendant of `id`. */
export function descendantsOf(agents: SessionAgent[], id: string): string[] {
  const children = new Map<string, string[]>();
  for (const a of agents) {
    if (!a.parentId) continue;
    if (!children.has(a.parentId)) children.set(a.parentId, []);
    children.get(a.parentId)!.push(a.id);
  }
  const out: string[] = [];
  const stack = [...(children.get(id) ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    out.push(next);
    stack.push(...(children.get(next) ?? []));
  }
  return out;
}

/** Agents still visible when the given branches are collapsed. */
export function visibleAgents(agents: SessionAgent[], collapsed: Set<string>): SessionAgent[] {
  const hidden = new Set<string>();
  for (const id of collapsed) for (const d of descendantsOf(agents, id)) hidden.add(d);
  return agents.filter((a) => !hidden.has(a.id));
}
