// SPDX-License-Identifier: Apache-2.0
import { RuntimeType } from '@crewtree/shared';
import type { ClaudeConfigOptions } from './claudeConfig.js';
import type { BoundTool } from './mcp/createAgentMcpServer.js';

/** Result a tool hook returns to the runtime (subset of Claude Code's PreToolUse output). */
export interface ToolHookDecision {
  decision?: 'allow' | 'deny' | 'ask';
  reason?: string;
}

/** Crewtree's tool hooks (PLAN.md 5): file locks, scope checks, file_touches, Bash attribution. */
export interface DriverToolHooks {
  preToolUse?: (toolName: string, input: any, toolUseId?: string) => Promise<ToolHookDecision>;
  postToolUse?: (toolName: string, input: any, response: unknown, toolUseId?: string) => Promise<void>;
}

export interface DriverCapabilities {
  supportsPreToolHook: boolean;
  supportsPermissionCallback: boolean;
  supportsStreamingInput: boolean;
  supportsResume: boolean;
  supportsModelList: boolean;
  supportsSkills: boolean;
  supportsPlugins: boolean;
  supportsMemoryFiles: boolean;
}

export interface PermissionDecision {
  allow: boolean;
  reason?: string;
}

export interface DriverOptions {
  cwd: string;
  systemPrompt: string;
  model?: string;
  /** Used by Claude Code when `model` is overloaded or unavailable (never equal to `model`). */
  fallbackModel?: string;
  /** Built-in tools available to the agent (frontmatter `tools`); undefined = all. */
  tools?: string[];
  /** Tools auto-approved without asking (always includes `mcp__crewtree__*`). */
  allowedTools?: string[];
  resumeSessionId?: string;
  sessionAgentId: string;
  mcpServers?: Record<string, any>;
  claudeConfig?: ClaudeConfigOptions;
  hooks?: DriverToolHooks;
  /** Claude Code permission mode; Try it uses `plan` when file writes are off (PLAN.md 6.4). Never bypassPermissions. */
  permissionMode?: 'default' | 'plan' | 'acceptEdits';
  /** Max agentic turns per user message (session/agent limit) */
  maxTurns?: number;
  /** The same tools as `mcpServers.crewtree`, callable directly (FakeDriver) */
  boundTools?: BoundTool[];
  /** Raw runtime messages (SDK message shape) plus synthetic `crewtree.*` messages. */
  onEvent?: (event: any) => void;
  canUseTool?: (toolName: string, input: any) => Promise<PermissionDecision>;
}

/** Synthetic message a driver emits when its underlying process fails or exits unexpectedly. */
export interface DriverErrorMessage {
  type: 'crewtree.error';
  error: string;
}

export interface AgentDriver {
  readonly runtime: RuntimeType;
  readonly capabilities: DriverCapabilities;

  init(options: DriverOptions): Promise<void>;
  sendMessage(content: string): Promise<void>;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
  /** Runtime session id used for `resume` (Claude Code: sdk_session_id). */
  getSessionId(): string | undefined;
  /** Switches the model from the next turn, keeping context (optional capability). */
  setModel?(model: string | undefined): Promise<void>;
}
