// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { TASK_STATUSES } from '../constants.js';

export const TaskScopeSchema = z.array(z.string()).default([]);

export const TaskSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  fromAgentId: z.string().nullable(), // null = user
  toAgentId: z.string(),
  parentTaskId: z.string().nullable().optional(),
  title: z.string(),
  instructions: z.string(),
  scope: TaskScopeSchema,
  status: z.enum(TASK_STATUSES).default('queued'),
  isRoot: z.boolean().default(false),
  question: z.string().nullable().optional(),
  answer: z.string().nullable().optional(),
  resultSummary: z.string().nullable().optional(),
  resultDetails: z.string().nullable().optional(),
  completedBy: z.enum(['tool', 'auto']).nullable().optional(),
  progress: z.string().nullable().optional(),
  files: z.array(z.string()).default([]),
  createdAt: z.number().int(),
  startedAt: z.number().int().nullable().optional(),
  endedAt: z.number().int().nullable().optional(),
});

export type Task = z.infer<typeof TaskSchema>;
