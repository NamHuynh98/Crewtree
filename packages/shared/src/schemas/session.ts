// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import {
  SESSION_STATUSES,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_TOTAL_AGENTS,
  DEFAULT_MAX_TURNS_PER_AGENT,
  DEFAULT_MAX_TOKENS_PER_SESSION,
  DEFAULT_IDLE_SUSPEND_MINUTES,
} from '../constants.js';

export const SessionLimitsSchema = z.object({
  maxConcurrentAgents: z.number().int().positive().default(DEFAULT_MAX_CONCURRENT_AGENTS),
  maxDepth: z.number().int().positive().default(DEFAULT_MAX_DEPTH),
  maxTotalAgents: z.number().int().positive().default(DEFAULT_MAX_TOTAL_AGENTS),
  maxTurns: z.number().int().positive().default(DEFAULT_MAX_TURNS_PER_AGENT),
  maxTokens: z.number().int().positive().default(DEFAULT_MAX_TOKENS_PER_SESSION),
});

export const SessionConfigGroupsSchema = z.object({
  claudemd: z.boolean().default(true),
  skillsPlugins: z.boolean().default(true),
  hooks: z.boolean().default(true),
  permissions: z.boolean().default(true),
});

export const SessionSettingsSchema = z.object({
  limits: SessionLimitsSchema.default({}),
  configGroups: SessionConfigGroupsSchema.default({}),
  checkpoint: z.boolean().default(false),
  idleSuspendMinutes: z.number().int().nonnegative().default(DEFAULT_IDLE_SUSPEND_MINUTES),
});

export type SessionSettings = z.infer<typeof SessionSettingsSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable().optional(),
  title: z.string(),
  cwd: z.string(),
  supervisorAgentId: z.string(),
  status: z.enum(SESSION_STATUSES).default('active'),
  settings: SessionSettingsSchema.default({}),
  totalTokens: z.number().int().default(0),
  totalTurns: z.number().int().default(0),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export type Session = z.infer<typeof SessionSchema>;
