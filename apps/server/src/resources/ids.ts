// SPDX-License-Identifier: Apache-2.0
import type { ResourceKind, ResourceScope } from '@crewtree/shared';

/** Opaque, URL-safe, stable id: kind + scope + key (name, plugin/name or file path). */
export function encodeResourceId(kind: ResourceKind, scope: ResourceScope, key: string): string {
  return Buffer.from(JSON.stringify([kind, scope, key]), 'utf8').toString('base64url');
}

export function decodeResourceId(id: string): { kind: ResourceKind; scope: ResourceScope; key: string } {
  try {
    const [kind, scope, key] = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
    if (typeof kind === 'string' && typeof scope === 'string' && typeof key === 'string') {
      return { kind: kind as ResourceKind, scope: scope as ResourceScope, key };
    }
  } catch {
    // fall through
  }
  throw new Error('Resource not found');
}
