// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import {
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_IDLE_SUSPEND_MINUTES,
  DEFAULT_EVENTS_RETENTION_DAYS,
} from '../constants.js';

export const AppSettingsSchema = z.object({
  ui: z.object({
    language: z.enum(['en', 'vi']).default('en'),
    theme: z.enum(['light', 'dark', 'system']).default('system'),
  }).default({ language: 'en', theme: 'system' }),
  ai: z.object({
    generatedContentLanguage: z.enum(['follow', 'en', 'vi']).default('follow'),
  }).default({ generatedContentLanguage: 'follow' }),
  models: z.object({
    defaults: z.object({
      supervisor: z.string().default('opus'),
      worker: z.string().default('sonnet'),
      generate: z.string().default('haiku'),
      fallback: z.string().default('sonnet'),
    }).default({
      supervisor: 'opus',
      worker: 'sonnet',
      generate: 'haiku',
      fallback: 'sonnet',
    }),
    custom: z.array(z.string()).default([]),
  }).default({
    defaults: {
      supervisor: 'opus',
      worker: 'sonnet',
      generate: 'haiku',
      fallback: 'sonnet',
    },
    custom: [],
  }),
  limits: z.object({
    defaults: z.object({
      maxConcurrentAgents: z.number().int().positive().default(DEFAULT_MAX_CONCURRENT_AGENTS),
      idleSuspendMinutes: z.number().int().nonnegative().default(DEFAULT_IDLE_SUSPEND_MINUTES),
      eventsRetentionDays: z.number().int().positive().default(DEFAULT_EVENTS_RETENTION_DAYS),
    }).default({
      maxConcurrentAgents: DEFAULT_MAX_CONCURRENT_AGENTS,
      idleSuspendMinutes: DEFAULT_IDLE_SUSPEND_MINUTES,
      eventsRetentionDays: DEFAULT_EVENTS_RETENTION_DAYS,
    }),
  }).default({
    defaults: {
      maxConcurrentAgents: DEFAULT_MAX_CONCURRENT_AGENTS,
      idleSuspendMinutes: DEFAULT_IDLE_SUSPEND_MINUTES,
      eventsRetentionDays: DEFAULT_EVENTS_RETENTION_DAYS,
    },
  }),
  update: z.object({
    check: z.boolean().default(true),
  }).default({ check: true }),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;
