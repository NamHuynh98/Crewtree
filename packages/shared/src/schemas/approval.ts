// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

export const ApprovalStatusSchema = z.enum(['pending', 'allowed', 'denied']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalRuleSchema = z.enum(['once', 'pattern']);
export type ApprovalRule = z.infer<typeof ApprovalRuleSchema>;

export const ApprovalSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  sessionAgentId: z.string(),
  tool: z.string(),
  input: z.record(z.any()),
  status: ApprovalStatusSchema.default('pending'),
  rule: ApprovalRuleSchema.optional(),
  pattern: z.string().optional(),
  reason: z.string().optional(),
  /** Why the request exists beyond the normal permission flow, e.g. `outside_scope` (PLAN.md 5) */
  label: z.string().optional(),
  /** Claude Code permission syntax offered for "Always allow", e.g. `Bash(npm test:*)` (PLAN.md 10) */
  suggestedPattern: z.string().optional(),
  taskId: z.string().optional(),
  createdAt: z.number().int(),
  decidedAt: z.number().int().optional(),
});

export type Approval = z.infer<typeof ApprovalSchema>;

export const ApprovalDecisionSchema = z.object({
  decision: z.enum(['allow', 'deny']),
  rule: ApprovalRuleSchema.default('once'),
  pattern: z.string().optional(),
  reason: z.string().optional(),
});

export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
