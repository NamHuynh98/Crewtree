// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { RESOURCE_KINDS, RESOURCE_SCOPES } from '../constants.js';

export const ResourceRevisionSchema = z.object({
  id: z.string(),
  kind: z.enum(RESOURCE_KINDS),
  scope: z.enum(RESOURCE_SCOPES),
  path: z.string(),
  content: z.string(),
  createdAt: z.number().int(),
});

export type ResourceRevision = z.infer<typeof ResourceRevisionSchema>;

export const ResourceItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(RESOURCE_KINDS),
  scope: z.enum(RESOURCE_SCOPES),
  path: z.string(),
  description: z.string().optional(),
  content: z.string().optional(),
  isReadOnly: z.boolean().default(false),
  metadata: z.record(z.any()).optional(),
});

export type ResourceItem = z.infer<typeof ResourceItemSchema>;
