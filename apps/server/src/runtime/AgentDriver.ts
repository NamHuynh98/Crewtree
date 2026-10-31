// SPDX-License-Identifier: Apache-2.0
import { RuntimeType } from '@crewtree/shared';
import type { ClaudeConfigOptions } from './claudeConfig.js';

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
  /** Built-in tools available to the agent (frontmatter `tools`); undefined = all. */
  tools?: string[];
  /** Tools auto-approved without asking (always includes `mcp__crewtree__*`). */
  allowedTools?: string[];
  resumeSessionId?: string;
  sessionAgentId: string;
  mcpServers?: Record<string, any>;
  claudeConfig?: ClaudeConfigOptions;
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
}
