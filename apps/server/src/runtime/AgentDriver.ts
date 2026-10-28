// SPDX-License-Identifier: Apache-2.0
import { RuntimeType } from '@crewtree/shared';

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

export interface DriverOptions {
  cwd: string;
  systemPrompt: string;
  model?: string;
  allowedTools?: string[];
  resumeSessionId?: string;
  sessionAgentId: string;
  mcpServers?: Record<string, any>;
  onEvent?: (event: any) => void;
  canUseTool?: (toolName: string, input: any) => Promise<{ allow: boolean; reason?: string }>;
}

export interface AgentDriver {
  readonly runtime: RuntimeType;
  readonly capabilities: DriverCapabilities;

  init(options: DriverOptions): Promise<void>;
  sendMessage(content: string): Promise<void>;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}
