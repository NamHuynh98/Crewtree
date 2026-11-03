// SPDX-License-Identifier: Apache-2.0
import type { ResourceKind, ResourceScope } from '@crewtree/shared';

/** One entry of the Claude Config pages (PLAN.md 6.1). Files are the source of truth; nothing is synced. */
export interface ResourceItem {
  id: string;
  kind: ResourceKind;
  name: string;
  scope: ResourceScope;
  /** Absolute file path; absent for built-ins and MCP servers stored inside a JSON file */
  path?: string;
  description: string;
  /** Plugin / built-in / synced sources cannot be edited ("Duplicate as mine") */
  readOnly: boolean;
  /** Plugin id when scope is `plugin` */
  plugin?: string;
  /** Set when an item with the same name in a higher-precedence scope hides this one */
  shadowedBy?: ResourceScope;
  metadata: Record<string, unknown>;
}

export interface ResourceDetail extends ResourceItem {
  content?: string;
}
