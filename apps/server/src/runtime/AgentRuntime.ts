// SPDX-License-Identifier: Apache-2.0
import { AgentDriver } from './AgentDriver.js';
import { SdkDriver } from './drivers/SdkDriver.js';
import { FakeDriver } from './drivers/FakeDriver.js';
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
  useFakeDriver?: boolean;
  canUseTool?: (toolName: string, input: any) => Promise<{ allow: boolean; reason?: string }>;
}

export class AgentRuntime {
  private driver: AgentDriver;
  private normalizer: EventNormalizer;
  private eventBus = EventBus.getInstance();
  private status: AgentStatus = 'idle';
  private idleTimer?: NodeJS.Timeout;
  private isSuspended = false;

  constructor(private options: AgentRuntimeOptions) {
    this.normalizer = new EventNormalizer({
      sessionId: options.sessionId,
      sessionAgentId: options.sessionAgent.id,
    });

    if (options.useFakeDriver) {
      this.driver = new FakeDriver();
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

    await this.driver.init({
      cwd: this.options.cwd,
      systemPrompt: fullSystemPrompt,
      model: agent.modelOverride || undefined,
      sessionAgentId: agent.id,
      resumeSessionId: agent.sdkSessionId || undefined,
      canUseTool: async (toolName, input) => {
        this.setStatus('waiting_input');
        if (this.options.canUseTool) {
          const res = await this.options.canUseTool(toolName, input);
          this.setStatus('running');
          return res;
        }
        this.setStatus('running');
        return { allow: true };
      },
      onEvent: (rawMsg) => {
        this.handleDriverEvent(rawMsg);
      },
    });

    this.setStatus('idle');
  }

  private handleDriverEvent(rawMsg: any) {
    // If receiving output, status is running
    if (this.status !== 'running' && this.status !== 'waiting_input') {
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
    const timeoutMs = 5 * 60 * 1000; // 5 minutes default
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
    await this.start();
  }

  public async dispose(): Promise<void> {
    this.clearIdleTimer();
    await this.driver.dispose();
  }
}
