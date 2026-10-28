// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { EVENT_TYPES } from '../constants.js';

export const AgentEventSchema = z.object({
  id: z.number().int().optional(),
  sessionId: z.string(),
  sessionAgentId: z.string().nullable().optional(),
  type: z.enum(EVENT_TYPES),
  payload: z.record(z.any()),
  ts: z.number().int(),
});

export type AgentEvent = z.infer<typeof AgentEventSchema>;
