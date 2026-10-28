// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { AGENT_STATUSES, RESOURCE_SCOPES, RUNTIMES } from '../constants.js';

export const AgentFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  runtime: z.enum(RUNTIMES).default('claude'),
  model: z.string().optional(),
  tools: z.union([z.string(), z.array(z.string())]).optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
  canDelegate: z.boolean().default(false),
  delegates: z.union([z.literal('*'), z.array(z.string())]).default('*'),
  maxTurns: z.number().int().positive().optional(),
  skills: z.array(z.string()).optional(),
  mcpServers: z.array(z.string()).optional(),
  role: z.enum(['supervisor', 'worker']).optional(),
  freshContextPerTask: z.boolean().default(false),
});

export type AgentFrontmatter = z.infer<typeof AgentFrontmatterSchema>;

export const AgentDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  scope: z.enum(RESOURCE_SCOPES),
  path: z.string(),
  frontmatter: AgentFrontmatterSchema,
  systemPrompt: z.string(),
  isReadOnly: z.boolean().default(false),
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export const SessionAgentSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  agentName: z.string(),
  scope: z.enum(RESOURCE_SCOPES),
  snapshot: z.string(),
  parentId: z.string().nullable(),
  depth: z.number().int().nonnegative(),
  alias: z.string().nullable().optional(),
  spawnedBy: z.enum(['user', 'agent']).default('user'),
  modelOverride: z.string().nullable().optional(),
  canDelegateOverride: z.boolean().nullable().optional(),
  freshContextOverride: z.boolean().nullable().optional(),
  sdkSessionId: z.string().nullable().optional(),
  status: z.enum(AGENT_STATUSES).default('idle'),
  lastActiveAt: z.number().int(),
});

export type SessionAgent = z.infer<typeof SessionAgentSchema>;
