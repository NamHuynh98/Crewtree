// SPDX-License-Identifier: Apache-2.0
import type { ModelCatalog } from '@/features/resources/types';

const ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable', 'inherit', 'default']);

/**
 * Whether the account can still use a model (PLAN.md 7: ⚠ on cards/nodes). Unknown (undefined) when the
 * list came from the fallback, so nothing is flagged without real data.
 */
export function modelAvailable(model: string | undefined, catalog?: ModelCatalog): boolean | undefined {
  if (!model || !catalog || catalog.source !== 'account') return undefined;
  const base = model.replace(/\[1m\]$/i, '');
  if (ALIASES.has(base)) return true;
  return catalog.models.some((m) => m.value === model || m.value === base || m.resolvedModel === base);
}

export function modelLabel(model: string | undefined, catalog?: ModelCatalog): string {
  if (!model) return 'inherit';
  const models = catalog?.models ?? [];
  // A concrete id (claude-opus-5-5) shows the name of the alias that resolves to it (Opus 5.5)
  const match =
    models.find((m) => m.value === model) ?? models.find((m) => m.resolvedModel === model && m.value !== 'default');
  return match?.displayName ?? model;
}
