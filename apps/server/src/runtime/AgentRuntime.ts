// SPDX-License-Identifier: Apache-2.0
import { AgentDriver } from './AgentDriver.js';
import { SdkDriver } from './drivers/SdkDriver.js';
import { FakeDriver } from './drivers/FakeDriver.js';
import { CliDriver } from './drivers/CliDriver.js';
import { createAgentMcpServer } from './mcp/createAgentMcpServer.js';
import { EventNormalizer } from './eventNormalizer.js';
import { EventBus } from '../events/EventBus.js';
import { AgentStatus, SessionAgent } from '@crewtree/shared';
import { getDb } from '../db/index.js';
import { sessionAgentsTable } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export interface AgentRuntimeOptions {
  sessionId: string;
  sessionAgent: SessionAgent;
  cwd: string;
  driverType?: 'sdk' | 'cli' | 'fake';
  useFakeDriver?: boolean;
  configGroups?: {
    claudemd?: boolean;
    skillsPlugins?: boolean;
    hooks?: boolean;
    permissions?: boolean;
  };
  canUseTool?: (toolName: string, input: any) => Promise<{ allow: boolean; reason?: string }>;
}

export class AgentRuntime {
  private driver: AgentDriver;
  private normalizer: EventNormalizer;
  private eventBus = EventBus.getInstance();
  private status: AgentStatus = 'idle';
  private idleTimer?: NodeJS.Timeout;
  private throttleTimer?: NodeJS.Timeout;
  private isSuspended = false;

  constructor(private options: AgentRuntimeOptions) {
    this.normalizer = new EventNormalizer({
      sessionId: options.sessionId,
      sessionAgentId: options.sessionAgent.id,
    });

    if (options.useFakeDriver || options.driverType === 'fake') {
      this.driver = new FakeDriver();
    } else if (options.driverType === 'cli') {
      this.driver = new CliDriver();
    } else {
      this.driver = new SdkDriver();
    }
  }

  public getStatus(): AgentStatus {
    return this.status;
  }

  public setStatus(newStatus: AgentStatus) {
    this.status = newStatus;
    const db = getDb();
    db.update(sessionAgentsTable)
      .set({ status: newStatus, lastActiveAt: Date.now() })
      .where(eq(sessionAgentsTable.id, this.options.sessionAgent.id))
      .run();

    this.eventBus.emitEvent({
      sessionId: this.options.sessionId,
      sessionAgentId: this.options.sessionAgent.id,
      type: 'agent.status',
      payload: { status: newStatus },
      ts: Date.now(),
    });
  }

  public async start(): Promise<void> {
    const agent = this.options.sessionAgent;

    // Append standard language guidance rule to system prompt (PLAN.md 11.2)
    const languageRule = `\n\nReply to the user in the language of their most recent message. Write code, comments, and files following the project's existing conventions.`;
    const fullSystemPrompt = agent.snapshot + languageRule;

    // Create in-process MCP server with closure over sessionAgentId
    const agentMcp = createAgentMcpServer({
      sessionId: this.options.sessionId,
      sessionAgentId: agent.id,
    });

    const driverOpts = {
      cwd: this.options.cwd,
      systemPrompt: fullSystemPrompt,
      model: agent.modelOverride || undefined,
      sessionAgentId: agent.id,
      resumeSessionId: agent.sdkSessionId || undefined,
      mcpServers: {
        crewtree: agentMcp,
      },
      configGroups: this.options.configGroups,
      canUseTool: async (toolName: string, input: any) => {
        this.setStatus('waiting_input');
        if (this.options.canUseTool) {
          const res = await this.options.canUseTool(toolName, input);
          this.setStatus('running');
          return res;
        }
        this.setStatus('running');
        return { allow: true };
      },
      onEvent: (rawMsg: any) => {
        this.handleDriverEvent(rawMsg);
      },
    };

    try {
      await this.driver.init(driverOpts);
    } catch (err) {
      if (this.driver instanceof SdkDriver && !this.options.driverType) {
        console.warn('[AgentRuntime] SdkDriver failed to initialize, falling back to CliDriver:', err);
        this.driver = new CliDriver();
        await this.driver.init(driverOpts);
      } else {
        throw err;
      }
    }

    this.setStatus('idle');
  }

  private handleDriverEvent(rawMsg: any) {
    // Handle rate limiting directly — SDK emits rate_limit_event
    if (rawMsg.type === 'rate_limit_event') {
      const retryAfterMs = (rawMsg.retry_after_seconds || 60) * 1000;
      this.setStatus('throttled');
      if (this.throttleTimer) clearTimeout(this.throttleTimer);
      this.throttleTimer = setTimeout(() => {
        if (this.status === 'throttled') {
          this.setStatus('idle');
        }
      }, retryAfterMs);
      return;
    }

    // If receiving output, mark as running
    if (this.status !== 'running' && this.status !== 'waiting_input' && this.status !== 'throttled') {
      this.setStatus('running');
    }

    const events = this.normalizer.normalize(rawMsg);
    for (const evt of events) {
      this.eventBus.emitEvent(evt);
    }

    // Capture SDK session id if newly available
    if (this.driver instanceof SdkDriver) {
      const sdkSessionId = this.driver.getSessionId();
      if (sdkSessionId && sdkSessionId !== this.options.sessionAgent.sdkSessionId) {
        this.options.sessionAgent.sdkSessionId = sdkSessionId;
        const db = getDb();
        db.update(sessionAgentsTable)
          .set({ sdkSessionId })
          .where(eq(sessionAgentsTable.id, this.options.sessionAgent.id))
          .run();
      }
    }

    // Check if turn ended
    if (rawMsg.type === 'assistant') {
      const textDone = this.normalizer.flushTextDone();
      if (textDone) {
        this.eventBus.emitEvent(textDone);
      }
      this.setStatus('idle');
      this.resetIdleTimer();
    }
  }

  public async sendMessage(content: string): Promise<void> {
    if (this.isSuspended) {
      await this.resumeFromSuspend();
    }

    this.clearIdleTimer();
    this.setStatus('running');
    await this.driver.sendMessage(content);
  }

  public async interrupt(): Promise<void> {
    await this.driver.interrupt();
    this.setStatus('idle');
  }

  private resetIdleTimer() {
    this.clearIdleTimer();
    // Use configurable idle timeout; default 5 minutes
    const suspendIdleMinutes = (this.options.sessionAgent as any).suspendIdleMinutes ?? 5;
    const timeoutMs = suspendIdleMinutes * 60 * 1000;
    this.idleTimer = setTimeout(() => {
      this.suspend();
    }, timeoutMs);
  }

  private clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  public async suspend() {
    if (this.status === 'running') return; // Do not suspend while active
    this.clearIdleTimer();
    await this.driver.dispose();
    this.isSuspended = true;
    this.setStatus('suspended');
  }

  private async resumeFromSuspend() {
    if (!this.isSuspended) return;
    this.isSuspended = false;

    // If agent requires fresh context per task, clear the SDK session so start() creates a new session
    if (this.options.sessionAgent.freshContextOverride === true) {
      this.options.sessionAgent.sdkSessionId = null;
    }

    await this.start();
  }

  public async dispose(): Promise<void> {
    this.clearIdleTimer();
    if (this.throttleTimer) clearTimeout(this.throttleTimer);
    await this.driver.dispose();
  }
}
