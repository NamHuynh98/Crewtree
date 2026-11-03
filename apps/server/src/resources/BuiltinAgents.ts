// SPDX-License-Identifier: Apache-2.0
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { builtinAgentItem } from './scan/agents.js';
import type { ResourceItem } from './types.js';

/** Shown until the SDK answers (and in FakeDriver mode). */
const FALLBACK: Array<{ name: string; description: string }> = [
  { name: 'general-purpose', description: 'General-purpose agent for researching and multi-step tasks.' },
  { name: 'Explore', description: 'Fast read-only agent for searching the codebase.' },
  { name: 'Plan', description: 'Software architect agent for designing implementation plans.' },
];

const idlePrompt: AsyncIterable<SDKUserMessage> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<SDKUserMessage>>(() => {}) }),
};

/** Claude Code's built-in agents, from `supportedAgents()` with no settings sources (so no file agents). */
export class BuiltinAgents {
  private static instance: BuiltinAgents;
  private items: ResourceItem[] = FALLBACK.map((a) => builtinAgentItem(a.name, a.description));
  private loading?: Promise<void>;

  public static getInstance(): BuiltinAgents {
    if (!BuiltinAgents.instance) BuiltinAgents.instance = new BuiltinAgents();
    return BuiltinAgents.instance;
  }

  public list(): ResourceItem[] {
    return this.items;
  }

  /** Loads the real list once; `onLoaded` lets the scanner refresh its cache. */
  public load(onLoaded?: () => void): Promise<void> {
    if (process.env.CREWTREE_DRIVER === 'fake') return Promise.resolve();
    if (!this.loading) {
      this.loading = (async () => {
        const q = query({ prompt: idlePrompt, options: { settingSources: [] } });
        try {
          const agents = await Promise.race([
            q.supportedAgents(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out')), 20_000)),
          ]);
          const builtins = agents.filter((a) => !a.name.includes(':'));
          if (builtins.length) {
            this.items = builtins.map((a) => builtinAgentItem(a.name, a.description, a.model));
            onLoaded?.();
          }
        } catch (err) {
          console.warn('[BuiltinAgents] supportedAgents() failed, keeping the fallback list:', err);
        } finally {
          q.close();
        }
      })();
    }
    return this.loading;
  }
}
