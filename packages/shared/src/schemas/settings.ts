// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import {
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_IDLE_SUSPEND_MINUTES,
  DEFAULT_EVENTS_RETENTION_DAYS,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_TOTAL_AGENTS,
  DEFAULT_MAX_TOKENS_PER_SESSION,
  DEFAULT_MAX_TURNS_PER_AGENT,
} from '../constants.js';

/** Settings → Limits → Session defaults: applied to new sessions (UI-WIREFRAMES 13). */
const SESSION_DEFAULTS = {
  maxDepth: DEFAULT_MAX_DEPTH,
  maxTotalAgents: DEFAULT_MAX_TOTAL_AGENTS,
  maxTokens: DEFAULT_MAX_TOKENS_PER_SESSION,
  maxTurns: DEFAULT_MAX_TURNS_PER_AGENT,
};

export const AppSettingsSchema = z.object({
  ui: z
    .object({
      language: z.enum(['en', 'vi']).default('en'),
      theme: z.enum(['light', 'dark', 'system']).default('system'),
    })
    .default({ language: 'en', theme: 'system' }),
  ai: z
    .object({
      generatedContentLanguage: z.enum(['follow', 'en', 'vi']).default('follow'),
    })
    .default({ generatedContentLanguage: 'follow' }),
  models: z
    .object({
      defaults: z
        .object({
          supervisor: z.string().default('opus'),
          worker: z.string().default('sonnet'),
          generate: z.string().default('haiku'),
          fallback: z.string().default('sonnet'),
        })
        .default({
          supervisor: 'opus',
          worker: 'sonnet',
          generate: 'haiku',
          fallback: 'sonnet',
        }),
    })
    .default({
      defaults: {
        supervisor: 'opus',
        worker: 'sonnet',
        generate: 'haiku',
        fallback: 'sonnet',
      },
    }),
  limits: z
    .object({
      defaults: z
        .object({
          maxConcurrentAgents: z.number().int().positive().default(DEFAULT_MAX_CONCURRENT_AGENTS),
          idleSuspendMinutes: z.number().int().nonnegative().default(DEFAULT_IDLE_SUSPEND_MINUTES),
          eventsRetentionDays: z.number().int().positive().default(DEFAULT_EVENTS_RETENTION_DAYS),
        })
        .default({
          maxConcurrentAgents: DEFAULT_MAX_CONCURRENT_AGENTS,
          idleSuspendMinutes: DEFAULT_IDLE_SUSPEND_MINUTES,
          eventsRetentionDays: DEFAULT_EVENTS_RETENTION_DAYS,
        }),
      session: z
        .object({
          maxDepth: z.number().int().positive().default(DEFAULT_MAX_DEPTH),
          maxTotalAgents: z.number().int().positive().default(DEFAULT_MAX_TOTAL_AGENTS),
          maxTokens: z.number().int().positive().default(DEFAULT_MAX_TOKENS_PER_SESSION),
          maxTurns: z.number().int().positive().default(DEFAULT_MAX_TURNS_PER_AGENT),
        })
        .default(SESSION_DEFAULTS),
    })
    .default({
      defaults: {
        maxConcurrentAgents: DEFAULT_MAX_CONCURRENT_AGENTS,
        idleSuspendMinutes: DEFAULT_IDLE_SUSPEND_MINUTES,
        eventsRetentionDays: DEFAULT_EVENTS_RETENTION_DAYS,
      },
      session: SESSION_DEFAULTS,
    }),
  update: z
    .object({
      check: z.boolean().default(true),
    })
    .default({ check: true }),
  // Where `crewtree` opens the UI: its own app window (Chrome / Edge / Brave / Chromium) or a browser tab
  launch: z
    .object({
      openIn: z.enum(['app', 'browser']).default('app'),
    })
    .default({ openIn: 'app' }),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;
