// SPDX-License-Identifier: Apache-2.0
import { AgentDriver, DriverOptions, DriverToolHooks, PermissionDecision } from './AgentDriver.js';
import { SdkDriver } from './drivers/SdkDriver.js';
import { FakeDriver } from './drivers/FakeDriver.js';
import { CliDriver } from './drivers/CliDriver.js';
import {
  bindTools,
  createAgentMcpServer,
  CREWTREE_MCP_SERVER_NAME,
  CREWTREE_TOOLS_PATTERN,
  OrchestratorHandlers,
} from './mcp/createAgentMcpServer.js';
import type { ConcurrencyLimiter } from './ConcurrencyLimiter.js';
import { EventNormalizer } from './eventNormalizer.js';
import { parseAgentSnapshot, normalizeToolList, ParsedAgentSnapshot } from './agentDefinition.js';
import { buildClaudeConfigOptions, ConfigGroups } from './claudeConfig.js';
import { EventBus } from '../events/EventBus.js';
import { AgentStatus, SessionAgent, SessionConfigGroupsSchema, DEFAULT_IDLE_SUSPEND_MINUTES } from '@crewtree/shared';
import { getDb } from '../db/index.js';
import { sessionAgentsTable, messagesTable } from '../db/schema.js';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';

export type DriverType = 'sdk' | 'cli' | 'fake';

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  numTurns: number;
  isError: boolean;
  /** Last top-level text block of the turn: the final answer, used as auto summary (PLAN.md 4.2) */
  lastText: string;
}

export interface AgentRuntimeOptions {
  sessionId: string;
  sessionAgent: SessionAgent;
  cwd: string;
  /** Omitted = SDK with automatic fallback to the CLI when the SDK fails before producing output. */
  driverType?: DriverType;
  /** Test hook: build the driver yourself. */
  driverFactory?: (type: DriverType) => AgentDriver;
  configGroups?: ConfigGroups;
  idleSuspendMinutes?: number;
  /** Used when neither the session override nor the agent's frontmatter sets a model. */
  defaultModel?: string;
  mcpHandlers?: Partial<OrchestratorHandlers>;
  /** `onPending` is called when the request actually waits for the user (status waiting_input). */
  canUseTool?: (toolName: string, input: any, onPending: () => void) => Promise<PermissionDecision>;
  onTurnComplete?: (usage: TurnUsage) => void;
  /** The process failed (status `error`) */
  onError?: (error: string) => void;
  /** Slots for agents generating output (PLAN.md 4.3) */
  limiter?: ConcurrencyLimiter;
  hooks?: DriverToolHooks;
  /** Runtime-only additions to the system prompt (Appendix A.2 / A.3) */
  promptAppendix?: string;
  maxTurns?: number;
}

/** Appended at runtime, never written to the .md file (PLAN.md 11.2). */
export const LANGUAGE_RULE =
  'Unless the instructions above specify a language: reply to the user in the language of their most recent message. ' +
  "Write code, comments, and files following the project's existing conventions.";

const THROTTLE_BASE_MS = 30_000;
const THROTTLE_MAX_MS = 15 * 60_000;
const BUSY_STATUSES: AgentStatus[] = ['running', 'queued', 'waiting_input', 'waiting_children', 'throttled'];

export class AgentRuntime {
  private driver?: AgentDriver;
  private driverType: DriverType;
  private driverProducedOutput = false;
  private starting?: Promise<void>;
  private normalizer: EventNormalizer;
  private eventBus = EventBus.getInstance();
  private parsed: ParsedAgentSnapshot;
  private status: AgentStatus;
  private turnActive = false;
  private lastUserMessage?: string;
  private throttleRetries = 0;
  private idleTimer?: NodeJS.Timeout;
  private throttleTimer?: NodeJS.Timeout;
  private disposed = false;
  private lastText = '';

  constructor(private options: AgentRuntimeOptions) {
    const agent = options.sessionAgent;
    this.parsed = parseAgentSnapshot(agent.snapshot, agent.agentName);
    this.driverType = options.driverType ?? 'sdk';
    this.status = agent.status === 'suspended' ? 'suspended' : 'idle';
    this.normalizer = new EventNormalizer({ sessionId: options.sessionId, sessionAgentId: agent.id });
  }

  public get sessionId(): string {
    return this.options.sessionId;
  }

  public get canDelegate(): boolean {
    return this.options.sessionAgent.canDelegateOverride ?? this.parsed.frontmatter.canDelegate;
  }

  public get freshContextPerTask(): boolean {
    return this.options.sessionAgent.freshContextOverride ?? this.parsed.frontmatter.freshContextPerTask;
  }

  public get model(): string | undefined {
    const model = this.options.sessionAgent.modelOverride || this.parsed.frontmatter.model || this.options.defaultModel;
    return model && model !== 'inherit' ? model : undefined;
  }

  public getStatus(): AgentStatus {
    return this.status;
  }

  public getDriver(): AgentDriver | undefined {
    return this.driver;
  }

  public isTurnActive(): boolean {
    return this.turnActive;
  }

  public get sessionAgent(): SessionAgent {
    return this.options.sessionAgent;
  }

  public get description(): string {
    return this.parsed.frontmatter.description;
  }

  public get delegates(): '*' | string[] {
    return this.parsed.frontmatter.delegates;
  }

  /** Status shown between turns, set by the TaskManager (`needs_input` after ask_parent). */
  public setRestingStatus(status: 'idle' | 'needs_input'): void {
    if (!this.turnActive && this.status !== 'suspended' && this.status !== 'error') this.setStatus(status);
  }

  private async acquireSlot(): Promise<void> {
    const limiter = this.options.limiter;
    if (!limiter || limiter.holds(this.options.sessionAgent.id)) return;
    const acquired = limiter.acquire(this.options.sessionId, this.options.sessionAgent.id);
    if (!limiter.holds(this.options.sessionAgent.id)) {
      this.setStatus('queued', { runningAgents: limiter.runningCount() });
    }
    await acquired;
  }

  private releaseSlot(): void {
    this.options.limiter?.release(this.options.sessionAgent.id);
  }

  /** wait_for_tasks: waiting children does not hold a concurrency slot, so the tree cannot deadlock. */
  public enterWaitingChildren(waitingFor: number): void {
    this.releaseSlot();
    this.setStatus('waiting_children', { waitingFor });
  }

  /** Back from wait_for_tasks: may queue for a slot before the agent continues generating. */
  public async leaveWaitingChildren(): Promise<void> {
    await this.reacquireSlotForTurn();
  }

  /**
   * Gets a slot back to continue the current turn. The turn may have ended (interrupt, cancel) while
   * the agent waited: then the slot must not be kept, or it would leak for good.
   */
  private async reacquireSlotForTurn(): Promise<void> {
    if (!this.turnActive || this.disposed) return;
    await this.acquireSlot().catch(() => undefined);
    if (!this.turnActive || this.disposed) {
      this.releaseSlot();
      return;
    }
    this.setStatus('running');
  }

  private setStatus(newStatus: AgentStatus, extra: Record<string, unknown> = {}) {
    if (newStatus === this.status && Object.keys(extra).length === 0) return;
    this.status = newStatus;
    this.options.sessionAgent.status = newStatus;
    getDb()
      .update(sessionAgentsTable)
      .set({ status: newStatus, lastActiveAt: Date.now() })
      .where(eq(sessionAgentsTable.id, this.options.sessionAgent.id))
      .run();

    this.eventBus.emitEvent({
      sessionId: this.options.sessionId,
      sessionAgentId: this.options.sessionAgent.id,
      type: 'agent.status',
      payload: { status: newStatus, ...extra },
      ts: Date.now(),
    });
  }

  /** Starts the runtime process (resuming `sdkSessionId` if present). */
  public async start(): Promise<void> {
    await this.ensureDriver();
    if (!this.turnActive) {
      this.setStatus('idle');
      this.resetIdleTimer();
    }
  }

  private ensureDriver(): Promise<void> {
    if (this.driver) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.startDriver().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  private createDriver(type: DriverType): AgentDriver {
    if (this.options.driverFactory) return this.options.driverFactory(type);
    if (type === 'fake') return new FakeDriver();
    if (type === 'cli') return new CliDriver();
    return new SdkDriver();
  }

  private buildDriverOptions(): DriverOptions {
    const agent = this.options.sessionAgent;
    const groups = this.options.configGroups ?? SessionConfigGroupsSchema.parse({});
    const claudeConfig = buildClaudeConfigOptions(groups, this.options.cwd);
    for (const warning of claudeConfig.warnings) {
      console.warn(`[AgentRuntime] ${agent.agentName}: ${warning}`);
    }

    const ctx = { sessionId: this.options.sessionId, sessionAgentId: agent.id, canDelegate: this.canDelegate };
    const prompt = [this.parsed.systemPrompt, this.options.promptAppendix, LANGUAGE_RULE].filter(Boolean).join('\n\n');

    return {
      cwd: this.options.cwd,
      systemPrompt: prompt,
      model: this.model,
      tools: normalizeToolList(this.parsed.frontmatter.tools),
      // Only Crewtree's own tools are auto-approved; everything else goes through settings rules / Approval.
      allowedTools: [CREWTREE_TOOLS_PATTERN],
      resumeSessionId: agent.sdkSessionId || undefined,
      sessionAgentId: agent.id,
      mcpServers: { [CREWTREE_MCP_SERVER_NAME]: createAgentMcpServer(ctx, this.options.mcpHandlers) },
      boundTools: bindTools(ctx, this.options.mcpHandlers),
      hooks: this.options.hooks,
      maxTurns: this.options.maxTurns ?? this.parsed.frontmatter.maxTurns,
      claudeConfig,
      canUseTool: (toolName, input) => this.handleCanUseTool(toolName, input),
      onEvent: (raw) => this.handleDriverEvent(raw),
    };
  }

  private async startDriver(): Promise<void> {
    const driver = this.createDriver(this.driverType);
    this.driverProducedOutput = false;
    await driver.init(this.buildDriverOptions());
    if (this.disposed) {
      await driver.dispose();
      return;
    }
    this.driver = driver;
  }

  private async disposeDriver() {
    const driver = this.driver;
    this.driver = undefined;
    await driver?.dispose();
  }

  private async handleCanUseTool(toolName: string, input: any): Promise<PermissionDecision> {
    // Phase 2 wires ApprovalService here; until then tools not covered by settings rules are allowed.
    if (!this.options.canUseTool) return { allow: true };
    let waited = false;
    const onPending = () => {
      waited = true;
      this.releaseSlot();
      this.setStatus('waiting_input', { tool: toolName });
    };
    try {
      return await this.options.canUseTool(toolName, input, onPending);
    } finally {
      if (waited) await this.reacquireSlotForTurn();
    }
  }

  private handleDriverEvent(raw: any) {
    if (this.disposed || !raw || typeof raw !== 'object') return;

    switch (raw.type) {
      case 'crewtree.error':
        void this.handleDriverError(raw.error);
        return;
      case 'crewtree.interrupted':
        this.endTurn();
        return;
      case 'rate_limit_event':
        this.handleRateLimitInfo(raw.rate_limit_info);
        return;
      case 'system':
        if (raw.subtype === 'api_retry' && (raw.error_status === 429 || raw.error === 'rate_limit')) {
          // The SDK retries by itself; just surface the wait.
          this.setStatus('throttled', { retryAfterMs: raw.retry_delay_ms, attempt: raw.attempt });
          return;
        }
        break;
    }

    if (['stream_event', 'assistant', 'user'].includes(raw.type)) {
      this.driverProducedOutput = true;
      if (this.turnActive && this.status !== 'running' && this.status !== 'waiting_input') {
        this.setStatus('running');
      }
    }

    for (const evt of this.normalizer.normalize(raw)) {
      this.eventBus.emitEvent(evt);
      if (evt.type === 'agent.text.done' && !evt.payload.parentToolUseId) {
        this.lastText = evt.payload.text;
        this.persistAssistantText(evt.payload.text);
      }
    }

    this.syncSdkSessionId();

    if (raw.type === 'result') {
      this.handleTurnResult(raw);
    }
  }

  private persistAssistantText(text: string) {
    try {
      getDb()
        .insert(messagesTable)
        .values({
          id: nanoid(),
          sessionAgentId: this.options.sessionAgent.id,
          role: 'assistant',
          content: JSON.stringify([{ type: 'text', text }]),
          delivery: 'delivered',
          createdAt: Date.now(),
        })
        .run();
    } catch (e) {
      console.error('Failed to persist assistant message to DB:', e);
    }
  }

  private syncSdkSessionId() {
    const sdkSessionId = this.driver?.getSessionId();
    const agent = this.options.sessionAgent;
    if (!sdkSessionId || sdkSessionId === agent.sdkSessionId) return;
    agent.sdkSessionId = sdkSessionId;
    getDb().update(sessionAgentsTable).set({ sdkSessionId }).where(eq(sessionAgentsTable.id, agent.id)).run();
  }

  private handleRateLimitInfo(info: any) {
    if (info?.status !== 'rejected') return; // 'allowed' / 'allowed_warning' are informational
    const resetsAt =
      typeof info.resetsAt === 'number' ? (info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt) : 0;
    const retryAfterMs = resetsAt > Date.now() ? resetsAt - Date.now() : this.backoffMs();
    this.setStatus('throttled', { retryAfterMs, rateLimitType: info.rateLimitType });
  }

  private backoffMs(): number {
    return Math.min(THROTTLE_BASE_MS * 2 ** this.throttleRetries, THROTTLE_MAX_MS);
  }

  private handleTurnResult(raw: any) {
    const u = raw.usage ?? {};
    const usage: TurnUsage = {
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      cacheReadTokens: u.cache_read_input_tokens || 0,
      cacheCreationTokens: u.cache_creation_input_tokens || 0,
      numTurns: raw.num_turns || 0,
      isError: !!raw.is_error,
      lastText: this.lastText,
    };

    if (this.status === 'throttled' && raw.is_error) {
      this.turnActive = false;
      this.releaseSlot();
      this.scheduleThrottleRetry();
      return;
    }

    this.throttleRetries = 0;
    this.lastUserMessage = undefined;
    this.endTurn();
    // After endTurn so listeners see an idle agent and can deliver the next message
    this.options.onTurnComplete?.(usage);
  }

  /** Rate limited turn failed: retry the same message with backoff (PLAN.md 3.3). */
  private scheduleThrottleRetry() {
    if (this.throttleTimer) clearTimeout(this.throttleTimer);
    const delay = this.backoffMs();
    this.throttleRetries++;
    this.setStatus('throttled', { retryAfterMs: delay, attempt: this.throttleRetries });
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = undefined;
      const pending = this.lastUserMessage;
      if (this.disposed || this.status !== 'throttled') return;
      if (pending === undefined) {
        this.endTurn();
        return;
      }
      void this.sendMessage(pending).catch((err) => this.handleDriverError(err?.message ?? String(err)));
    }, delay);
  }

  private endTurn() {
    this.turnActive = false;
    this.releaseSlot();
    this.setStatus('idle');
    this.resetIdleTimer();
  }

  private async handleDriverError(error: string) {
    if (this.disposed) return;

    // SDK could not run (e.g. credentials): fall back to the CLI once and replay the pending message.
    const canFallback =
      this.options.driverType === undefined && this.driverType === 'sdk' && !this.driverProducedOutput;
    if (canFallback) {
      console.warn(`[AgentRuntime] SdkDriver failed before producing output (${error}); falling back to CliDriver.`);
      this.driverType = 'cli';
      await this.disposeDriver();
      try {
        await this.ensureDriver();
        if (this.lastUserMessage !== undefined && this.driver) await this.driver.sendMessage(this.lastUserMessage);
        return;
      } catch (err: any) {
        error = err?.message ?? String(err);
      }
    }

    this.turnActive = false;
    this.releaseSlot();
    this.clearIdleTimer();
    await this.disposeDriver();
    this.setStatus('error', { error });
    this.options.onError?.(error);
  }

  /**
   * Sends a user/parent message. `newTask` marks the start of a task: with `freshContextPerTask`
   * the agent then starts a new runtime session instead of resuming (PLAN.md 3.2).
   */
  public async sendMessage(content: string, opts: { newTask?: boolean } = {}): Promise<void> {
    if (this.disposed) throw new Error('Agent runtime has been disposed');
    this.clearIdleTimer();

    // A message during a turn is queued by the runtime itself (streaming input) and needs no new slot
    if (this.turnActive && this.driver) {
      await this.driver.sendMessage(content);
      return;
    }
    // Claimed synchronously so concurrent callers see a busy agent while it waits for a slot
    this.turnActive = true;
    this.lastText = '';
    if (this.throttleTimer && content !== this.lastUserMessage) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = undefined;
    }

    if (opts.newTask && this.freshContextPerTask) {
      await this.disposeDriver();
      this.options.sessionAgent.sdkSessionId = null;
      getDb()
        .update(sessionAgentsTable)
        .set({ sdkSessionId: null })
        .where(eq(sessionAgentsTable.id, this.options.sessionAgent.id))
        .run();
    }

    try {
      // Rebuilds the process after suspend / error / fresh context, resuming sdkSessionId.
      await this.ensureDriver();
      if (!this.driver) throw new Error('Agent runtime failed to start');
      await this.acquireSlot();
    } catch (err) {
      this.turnActive = false;
      this.releaseSlot();
      if (!this.disposed) this.setStatus('idle');
      throw err;
    }
    if (this.disposed || !this.turnActive) {
      this.releaseSlot();
      return; // interrupted / disposed while queued
    }

    this.lastUserMessage = content;
    this.setStatus('running');
    await this.driver.sendMessage(content);
  }

  public async interrupt(): Promise<void> {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = undefined;
      this.lastUserMessage = undefined;
      if (!this.turnActive) {
        this.endTurn();
        return;
      }
    }
    if (this.turnActive && this.options.limiter?.isWaiting(this.options.sessionAgent.id)) {
      // Still queued for a slot: drop the pending turn
      this.options.limiter.cancel(this.options.sessionAgent.id, 'Interrupted');
      this.endTurn();
      this.options.onTurnComplete?.({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        numTurns: 0,
        isError: true,
        lastText: '',
      });
      return;
    }
    if (!this.driver || !this.turnActive) return;
    this.lastUserMessage = undefined;
    // The driver reports the end of the interrupted turn (result / crewtree.interrupted).
    await this.driver.interrupt();
  }

  /** Session model override (PLAN.md 7): applies from the next turn and keeps the context. */
  public async setModelOverride(model: string | null): Promise<void> {
    this.options.sessionAgent.modelOverride = model;
    if (this.driver?.setModel) await this.driver.setModel(this.model);
    else if (this.driver && !this.turnActive) await this.disposeDriver(); // restarted with resume on next message
  }

  public updateSettings(settings: { configGroups?: ConfigGroups; idleSuspendMinutes?: number }) {
    if (settings.configGroups) this.options.configGroups = settings.configGroups;
    if (settings.idleSuspendMinutes !== undefined) {
      this.options.idleSuspendMinutes = settings.idleSuspendMinutes;
      if (this.idleTimer) this.resetIdleTimer();
    }
  }

  private resetIdleTimer() {
    this.clearIdleTimer();
    const minutes = this.options.idleSuspendMinutes ?? DEFAULT_IDLE_SUSPEND_MINUTES;
    if (minutes <= 0 || this.disposed) return;
    this.idleTimer = setTimeout(() => void this.suspend(), minutes * 60_000);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** Stops the process of an idle agent; the next message rebuilds it with `resume` (PLAN.md 3.2). */
  public async suspend(): Promise<void> {
    if (this.turnActive || BUSY_STATUSES.includes(this.status) || this.disposed) return;
    this.clearIdleTimer();
    await this.disposeDriver();
    this.setStatus('suspended');
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    this.turnActive = false;
    this.options.limiter?.cancel(this.options.sessionAgent.id, 'Agent disposed');
    this.clearIdleTimer();
    if (this.throttleTimer) clearTimeout(this.throttleTimer);
    this.throttleTimer = undefined;
    await this.starting?.catch(() => undefined);
    await this.disposeDriver();
  }
}
