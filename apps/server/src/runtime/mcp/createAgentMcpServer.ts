// SPDX-License-Identifier: Apache-2.0
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import {
  AnswerChildInputSchema,
  AskParentInputSchema,
  CancelTaskInputSchema,
  CompleteTaskInputSchema,
  DelegateTaskInputSchema,
  GetTaskResultInputSchema,
  GetTaskStatusInputSchema,
  MessageAgentInputSchema,
  ReportProgressInputSchema,
  SpawnAgentInputSchema,
  WaitForTasksInputSchema,
} from '@crewtree/shared';
import { z } from 'zod';
import { EventBus } from '../../events/EventBus.js';

export const CREWTREE_MCP_SERVER_NAME = 'crewtree';
/** Auto-approved for every agent (PLAN.md 3.2). */
export const CREWTREE_TOOLS_PATTERN = `mcp__${CREWTREE_MCP_SERVER_NAME}__*`;
export const CREWTREE_TOOL_TIMEOUT_MS = 660_000;

export interface AgentMcpContext {
  sessionId: string;
  sessionAgentId: string;
  canDelegate: boolean;
}

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type Handler<S extends z.ZodObject<any>> = (args: z.infer<S>, ctx: AgentMcpContext) => Promise<ToolResult>;

/** Implemented by TaskManager in Phase 2. A tool is only exposed when its handler exists. */
export interface OrchestratorHandlers {
  // Every agent
  report_progress: Handler<typeof ReportProgressInputSchema>;
  complete_task: Handler<typeof CompleteTaskInputSchema>;
  ask_parent: Handler<typeof AskParentInputSchema>;
  // Delegating nodes only
  list_agents: Handler<z.ZodObject<Record<string, never>>>;
  spawn_agent: Handler<typeof SpawnAgentInputSchema>;
  delegate_task: Handler<typeof DelegateTaskInputSchema>;
  wait_for_tasks: Handler<typeof WaitForTasksInputSchema>;
  get_task_status: Handler<typeof GetTaskStatusInputSchema>;
  get_task_result: Handler<typeof GetTaskResultInputSchema>;
  answer_child: Handler<typeof AnswerChildInputSchema>;
  message_agent: Handler<typeof MessageAgentInputSchema>;
  cancel_task: Handler<typeof CancelTaskInputSchema>;
}

const TOOL_SPECS: Array<{
  name: keyof OrchestratorHandlers;
  description: string;
  schema: z.ZodObject<any>;
  delegateOnly: boolean;
}> = [
  {
    name: 'report_progress',
    description: 'Report a progress update to your parent without finishing the task.',
    schema: ReportProgressInputSchema,
    delegateOnly: false,
  },
  {
    name: 'complete_task',
    description: 'Finish your current task with a short factual summary.',
    schema: CompleteTaskInputSchema,
    delegateOnly: false,
  },
  {
    name: 'ask_parent',
    description: 'Ask your parent a question when you are blocked by missing information.',
    schema: AskParentInputSchema,
    delegateOnly: false,
  },
  {
    name: 'list_agents',
    description: 'List your direct child agents with name, description and status.',
    schema: z.object({}),
    delegateOnly: true,
  },
  {
    name: 'spawn_agent',
    description: 'Create a new child agent from your allowed delegates list.',
    schema: SpawnAgentInputSchema,
    delegateOnly: true,
  },
  {
    name: 'delegate_task',
    description: 'Give a task to a direct child. Returns a taskId immediately. Declare `scope` for file-editing tasks.',
    schema: DelegateTaskInputSchema,
    delegateOnly: true,
  },
  {
    name: 'wait_for_tasks',
    description: 'Wait until tasks finish or the timeout elapses. Returns results, still-running tasks and questions.',
    schema: WaitForTasksInputSchema,
    delegateOnly: true,
  },
  {
    name: 'get_task_status',
    description: 'Get status and latest progress of a task.',
    schema: GetTaskStatusInputSchema,
    delegateOnly: true,
  },
  {
    name: 'get_task_result',
    description: 'Get the full (not summarized) result of a finished task.',
    schema: GetTaskResultInputSchema,
    delegateOnly: true,
  },
  {
    name: 'answer_child',
    description: "Answer a child's ask_parent question.",
    schema: AnswerChildInputSchema,
    delegateOnly: true,
  },
  {
    name: 'message_agent',
    description: 'Send an extra message to a running child.',
    schema: MessageAgentInputSchema,
    delegateOnly: true,
  },
  {
    name: 'cancel_task',
    description: 'Cancel a task and its whole subtree.',
    schema: CancelTaskInputSchema,
    delegateOnly: true,
  },
];

/** Phase 1 default: report_progress only publishes an event. */
function defaultHandlers(): Partial<OrchestratorHandlers> {
  return {
    report_progress: async (args, ctx) => {
      EventBus.getInstance().emitEvent({
        sessionId: ctx.sessionId,
        sessionAgentId: ctx.sessionAgentId,
        type: 'task.updated',
        payload: { progress: args.text },
        ts: Date.now(),
      });
      return { content: [{ type: 'text', text: 'Progress reported.' }] };
    },
  };
}

/**
 * Creates an in-process MCP server per agent. The handlers close over the calling agent's
 * context, so the server can enforce tree permissions per sessionAgentId (PLAN.md 4.3).
 */
export function createAgentMcpServer(
  ctx: AgentMcpContext,
  handlers: Partial<OrchestratorHandlers> = {}
): McpSdkServerConfigWithInstance {
  const resolved = { ...defaultHandlers(), ...handlers };

  const tools = TOOL_SPECS.filter((spec) => resolved[spec.name] && (!spec.delegateOnly || ctx.canDelegate)).map(
    (spec) =>
      tool(spec.name, spec.description, spec.schema.shape, async (args: any) => {
        try {
          return await (resolved[spec.name] as Handler<any>)(args, ctx);
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `Error: ${err?.message ?? String(err)}` }], isError: true };
        }
      })
  );

  const server = createSdkMcpServer({
    name: CREWTREE_MCP_SERVER_NAME,
    version: '1.0.0',
    tools,
  });
  // In-process tool calls are unbounded by default (spike: a 7-minute call succeeded); bound them just
  // above wait_for_tasks' 600s maximum so a stuck handler cannot hold an agent forever.
  return { ...server, timeout: CREWTREE_TOOL_TIMEOUT_MS };
}
