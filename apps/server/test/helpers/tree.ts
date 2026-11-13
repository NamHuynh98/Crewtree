// SPDX-License-Identifier: Apache-2.0
import fs from 'fs';
import path from 'path';
import type { AgentEvent } from '@crewtree/shared';
import { EventBus } from '../../src/events/EventBus.js';

/** Writes an agent definition into the Crewtree scope of the test's temp CREWTREE_DIR. */
export function writeAgent(name: string, frontmatter: Record<string, string>, body = `You are ${name}.`) {
  const dir = path.join(process.env.CREWTREE_DIR!, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const fm = Object.entries({ name, description: `${name} agent`, ...frontmatter })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\n${fm}\n---\n${body}\n`);
}

export function recordEvents(sessionId?: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  EventBus.getInstance().on('event', (e: AgentEvent) => {
    if (!sessionId || e.sessionId === sessionId) events.push(e);
  });
  return events;
}

export async function waitFor(check: () => boolean, ms = 5000, label = 'condition') {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const parse = (text: string) => JSON.parse(text);

/** The task ID from a "[Crewtree task …]" header (the fenced child tools must name it). */
export function taskIdIn(content: string): string {
  const id = /\[Crewtree task ([^\]\s]+)\]/.exec(content)?.[1];
  if (!id) throw new Error(`No task header in: ${content.slice(0, 80)}`);
  return id;
}
