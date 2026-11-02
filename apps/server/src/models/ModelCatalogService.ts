// SPDX-License-Identifier: Apache-2.0
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export interface CatalogModel {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
}

export interface ModelCatalog {
  models: CatalogModel[];
  fetchedAt: number;
  source: 'account' | 'fallback';
}

const TTL_MS = 6 * 60 * 60_000;
const TIMEOUT_MS = 20_000;

export const FALLBACK_MODELS: CatalogModel[] = [
  { value: 'opus', displayName: 'Opus', description: 'Most capable; default for coordinating nodes' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Balanced; default for worker nodes' },
  { value: 'haiku', displayName: 'Haiku', description: 'Fast and lightweight' },
  { value: 'inherit', displayName: 'Inherit', description: 'Use the Claude Code default model' },
];

const idlePrompt: AsyncIterable<SDKUserMessage> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<SDKUserMessage>>(() => {}) }),
};

/** Models the logged-in account can use, from the Agent SDK's `supportedModels()` (PLAN.md 7). */
export class ModelCatalogService {
  private static instance: ModelCatalogService;
  private cache?: ModelCatalog;
  private inflight?: Promise<ModelCatalog>;

  public static getInstance(): ModelCatalogService {
    if (!ModelCatalogService.instance) ModelCatalogService.instance = new ModelCatalogService();
    return ModelCatalogService.instance;
  }

  public async getCatalog(force = false): Promise<ModelCatalog> {
    if (!force && this.cache && Date.now() - this.cache.fetchedAt < TTL_MS) return this.cache;
    if (!this.inflight) {
      this.inflight = this.fetch().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async fetch(): Promise<ModelCatalog> {
    if (process.env.CREWTREE_DRIVER === 'fake') {
      return { models: FALLBACK_MODELS, fetchedAt: Date.now(), source: 'fallback' };
    }
    const q = query({ prompt: idlePrompt, options: { settingSources: [] } });
    try {
      const models = await Promise.race([
        q.supportedModels(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out')), TIMEOUT_MS)),
      ]);
      this.cache = {
        models: models.map((m) => ({
          value: m.value,
          resolvedModel: m.resolvedModel,
          displayName: m.displayName,
          description: m.description,
        })),
        fetchedAt: Date.now(),
        source: 'account',
      };
      return this.cache;
    } catch (err) {
      console.warn('[ModelCatalog] supportedModels() failed, using fallback aliases:', err);
      return { models: FALLBACK_MODELS, fetchedAt: Date.now(), source: 'fallback' };
    } finally {
      q.close();
    }
  }
}

const FAMILY_RANK: Record<string, number> = { opus: 3, sonnet: 2, haiku: 1 };

/**
 * Best model for the default Supervisor (PLAN.md 4.1): Opus > Sonnet > Haiku, then newest version,
 * then the large-context (1M) variant. Returns a concrete model id, or undefined when none qualifies.
 */
export function pickBestModel(models: CatalogModel[]): string | undefined {
  const ranked = models
    .map((m) => {
      const id = (m.resolvedModel ?? m.value).toLowerCase();
      const match = /(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(id);
      if (!match) return null;
      const large = /\[1m\]|1m/i.test(m.value) || /1m/i.test(m.displayName);
      return {
        id: m.resolvedModel && !/\[1m\]/i.test(m.value) ? m.resolvedModel : m.value,
        key: [FAMILY_RANK[match[1]], Number(match[2]), Number(match[3] ?? 0), large ? 1 : 0],
      };
    })
    .filter((x): x is { id: string; key: number[] } => x !== null)
    .sort((a, b) => {
      for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return b.key[i] - a.key[i];
      return 0;
    });
  return ranked[0]?.id;
}
