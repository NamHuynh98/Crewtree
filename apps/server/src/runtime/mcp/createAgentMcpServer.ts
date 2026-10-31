// SPDX-License-Identifier: Apache-2.0
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { EventBus } from '../../events/EventBus.js';

export interface AgentMcpContext {
  sessionId: string;
  sessionAgentId: string;
}

/**
 * Creates an in-process MCP server per agent using the Claude Agent SDK.
 * The tools closure over sessionAgentId and sessionId to attribute orchestration
 * actions directly to the calling agent.
 */
export function createAgentMcpServer(ctx: AgentMcpContext) {
  const eventBus = EventBus.getInstance();

  const delegateTaskTool = tool(
    'delegate_task',
    'Delegate a subtask to another agent in the hierarchy.',
    {
      agentName: z.string().describe('The name of the agent to delegate the task to'),
      taskDescription: z.string().describe('Detailed instructions for the assigned task'),
      context: z.string().optional().describe('Additional context or background information'),
    },
    async (args) => {
      eventBus.emitEvent({
        sessionId: ctx.sessionId,
        sessionAgentId: ctx.sessionAgentId,
        type: 'agent.tool.start',
        payload: {
          tool: 'delegate_task',
          input: args,
        },
        ts: Date.now(),
      });

      return {
        content: [
          {
            type: 'text',
            text: `Task successfully registered and assigned to agent "${args.agentName}".`,
          },
        ],
      };
    }
  );

  const sendMessageTool = tool(
    'send_message_to_agent',
    'Send an asynchronous or conversational message to another agent in the session.',
    {
      targetAgentId: z.string().describe('Target agent ID or alias'),
      message: z.string().describe('Message content to deliver'),
    },
    async (args) => {
      return {
        content: [
          {
            type: 'text',
            text: `Message queued for agent ${args.targetAgentId}.`,
          },
        ],
      };
    }
  );

  const askUserQuestionTool = tool(
    'ask_user_question',
    'Ask the user a clarifying question when human input or decision is required.',
    {
      question: z.string().describe('The question for the user'),
      options: z.array(z.string()).optional().describe('Optional list of suggested choices'),
    },
    async (args) => {
      eventBus.emitEvent({
        sessionId: ctx.sessionId,
        sessionAgentId: ctx.sessionAgentId,
        type: 'approval.created',
        payload: {
          question: args.question,
          options: args.options,
        },
        ts: Date.now(),
      });

      return {
        content: [
          {
            type: 'text',
            text: `Question dispatched to user: "${args.question}". Awaiting reply.`,
          },
        ],
      };
    }
  );

  return createSdkMcpServer({
    name: 'crewtree',
    version: '1.0.0',
    tools: [delegateTaskTool, sendMessageTool, askUserQuestionTool],
  });
}
