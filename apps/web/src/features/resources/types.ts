// SPDX-License-Identifier: Apache-2.0
export type Scope = 'crewtree' | 'user' | 'project' | 'local' | 'plugin' | 'builtin';
export type WritableScope = 'crewtree' | 'user' | 'project';
export const WRITABLE_SCOPES: WritableScope[] = ['crewtree', 'user', 'project'];

export interface ResourceItem {
  id: string;
  kind: string;
  name: string;
  scope: Scope;
  path?: string;
  description: string;
  readOnly: boolean;
  plugin?: string;
  shadowedBy?: Scope;
  metadata: Record<string, any>;
}

export interface RevisionMeta {
  id: string;
  scope: Scope;
  path: string;
  name: string;
  action: 'baseline' | 'create' | 'update' | 'delete' | 'move' | 'rollback';
  createdAt: number;
}

export interface ResourceDetail extends ResourceItem {
  content?: string;
  revisions: RevisionMeta[];
}

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
