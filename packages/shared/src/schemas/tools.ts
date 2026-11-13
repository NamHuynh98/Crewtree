// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

export const SpawnAgentInputSchema = z.object({
  agentName: z.string().min(1),
  alias: z.string().optional(),
});
export type SpawnAgentInput = z.infer<typeof SpawnAgentInputSchema>;

export const DelegateTaskInputSchema = z.object({
  agentId: z.string().min(1),
  title: z.string().min(1),
  instructions: z.string().min(1),
  scope: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
});
export type DelegateTaskInput = z.infer<typeof DelegateTaskInputSchema>;

export const WaitForTasksInputSchema = z.object({
  taskIds: z.array(z.string()),
  timeoutSec: z.number().int().min(1).max(600).default(300),
});
export type WaitForTasksInput = z.infer<typeof WaitForTasksInputSchema>;

export const GetTaskStatusInputSchema = z.object({
  taskId: z.string().min(1),
});
export type GetTaskStatusInput = z.infer<typeof GetTaskStatusInputSchema>;

export const GetTaskResultInputSchema = z.object({
  taskId: z.string().min(1),
});
export type GetTaskResultInput = z.infer<typeof GetTaskResultInputSchema>;

export const AnswerChildInputSchema = z.object({
  taskId: z.string().min(1),
  answer: z.string().min(1),
});
export type AnswerChildInput = z.infer<typeof AnswerChildInputSchema>;

export const MessageAgentInputSchema = z.object({
  agentId: z.string().min(1),
  message: z.string().min(1),
});
export type MessageAgentInput = z.infer<typeof MessageAgentInputSchema>;

export const CancelTaskInputSchema = z.object({
  taskId: z.string().min(1),
  reason: z.string().min(1),
});
export type CancelTaskInput = z.infer<typeof CancelTaskInputSchema>;

/**
 * The task a child tool call is about. The server rejects it unless it is the caller's current task, so a
 * call from an old turn or a restarted process cannot close or update a newer task. Optional only for the
 * Supervisor's root request, which has no task header.
 */
const OwnTaskIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe('ID of the task this call is about, from the "[Crewtree task …]" header. Required for delegated tasks.');

export const ReportProgressInputSchema = z.object({
  taskId: OwnTaskIdSchema,
  text: z.string().min(1),
});
export type ReportProgressInput = z.infer<typeof ReportProgressInputSchema>;

export const CompleteTaskInputSchema = z.object({
  taskId: OwnTaskIdSchema,
  summary: z.string().min(1),
  details: z.string().optional(),
  files: z.array(z.string()).optional(),
});
export type CompleteTaskInput = z.infer<typeof CompleteTaskInputSchema>;

export const AskParentInputSchema = z.object({
  taskId: OwnTaskIdSchema,
  question: z.string().min(1),
});
export type AskParentInput = z.infer<typeof AskParentInputSchema>;
