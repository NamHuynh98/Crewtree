// SPDX-License-Identifier: Apache-2.0
import { nanoid } from 'nanoid';
import type { AgentEvent } from '@crewtree/shared';
import type { AgentDriver } from '../runtime/AgentDriver.js';
import { SdkDriver } from '../runtime/drivers/SdkDriver.js';
import { FakeDriver } from '../runtime/drivers/FakeDriver.js';
import { EventNormalizer } from '../runtime/eventNormalizer.js';
import { normalizeToolList, parseAgentSnapshot } from '../runtime/agentDefinition.js';
import { LANGUAGE_RULE } from '../runtime/AgentRuntime.js';
import {
  CREWTREE_MCP_SERVER_NAME,
  CREWTREE_TOOLS_PATTERN,
  bindTools,
  createAgentMcpServer,
  type OrchestratorHandlers,
  type ToolResult,
} from '../runtime/mcp/createAgentMcpServer.js';
import { composeMessage, type ComposeInput } from '../uploads/composeMessage.js';

/** Tools that change files; refused while "Allow file writes" is off (plan mode refuses them too). */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_SANDBOXES = 3;
const IDLE_DISPOSE_MS = 15 * 60_000;

export const SANDBOX_NOTE =
  'You are running in the Crewtree Agent Editor sandbox ("Try it"). Orchestration tools are simulated: ' +
  'delegate_task, wait_for_tasks and similar calls return placeholder results and no child agent is started. ' +
  'Say so briefly when you rely on such a result.';

export interface TryItEvent {
  type: 'event' | 'status' | 'permission' | 'permission.resolved' | 'error';
  data: any;
}

interface PendingPermission {
  id: string;
  tool: string;
  input: any;
  resolve: (allow: boolean) => void;
}

const simulated = (text: string): Promise<ToolResult> =>
  Promise.resolve({ content: [{ type: 'text', text: `[sandbox] ${text}` }] });

/** Orchestration tools return placeholder results in the sandbox (PLAN.md 6.4). */
function simulatedHandlers(): Partial<OrchestratorHandlers> {
  let n = 0;
  return {
    report_progress: () => simulated('Progress noted.'),
    complete_task: (args) => simulated(`Task completed. Summary: ${args.summary}`),
    ask_parent: (args) =>
      simulated(`No parent in the sandbox. Question was: ${args.question}. Continue with your best assumption.`),
    list_agents: () => simulated('No child agents exist in the sandbox; spawn_agent/delegate_task are simulated.'),
    spawn_agent: (args) => simulated(`Would spawn ${args.agentName}. Simulated child id: sim-${args.agentName}.`),
    delegate_task: (args) =>
      simulated(`Would delegate "${args.title}" to ${args.agentId}. Simulated task id: sim-task-${++n}.`),
    wait_for_tasks: () => simulated('All simulated tasks finished. Each child would report its result here.'),
    get_task_status: () => simulated('Simulated task status: done.'),
    get_task_result: () => simulated('Simulated result: the child completed the task as instructed.'),
    answer_child: () => simulated('Answer delivered (simulated).'),
    message_agent: () => simulated('Message delivered (simulated).'),
    cancel_task: () => simulated('Task cancelled (simulated).'),
  };
}

export interface StartOptions {
  /** Agent .md as currently in the editor (unsaved changes included) */
  content: string;
  cwd: string;
  allowWrites: boolean;
}

class Sandbox {
  readonly id = nanoid(10);
  private driver?: AgentDriver;
  private normalizer: EventNormalizer;
  private listeners = new Set<(e: TryItEvent) => void>();
  private pending = new Map<string, PendingPermission>();
  private history: TryItEvent[] = [];
  status: 'idle' | 'running' | 'error' = 'idle';
  lastActiveAt = Date.now();

  constructor(
    readonly opts: StartOptions,
    private driverType: 'sdk' | 'fake'
  ) {
    this.normalizer = new EventNormalizer({ sessionId: 'tryit', sessionAgentId: this.id });
  }

  private emit(e: TryItEvent) {
    // Live text deltas are not replayed to late subscribers; completed blocks are
    if (!(e.type === 'event' && e.data.type === 'agent.text.delta')) this.history.push(e);
    if (this.history.length > 500) this.history.shift();
    for (const l of this.listeners) l(e);
  }

  private setStatus(status: Sandbox['status']) {
    this.status = status;
    this.emit({ type: 'status', data: { status } });
  }

  subscribe(listener: (e: TryItEvent) => void): () => void {
    for (const e of this.history) listener(e);
    listener({ type: 'status', data: { status: this.status } });
    for (const p of this.pending.values())
      listener({ type: 'permission', data: { id: p.id, tool: p.tool, input: p.input } });
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start() {
    const parsed = parseAgentSnapshot(this.opts.content, 'agent');
    const fm = parsed.frontmatter;
    const ctx = { sessionId: 'tryit', sessionAgentId: this.id, canDelegate: fm.canDelegate };
    const handlers = simulatedHandlers();
    this.driver = this.driverType === 'fake' ? new FakeDriver() : new SdkDriver();
    await this.driver.init({
      cwd: this.opts.cwd,
      systemPrompt: [parsed.systemPrompt, SANDBOX_NOTE, LANGUAGE_RULE].filter(Boolean).join('\n\n'),
      model: fm.model && fm.model !== 'inherit' ? fm.model : undefined,
      tools: normalizeToolList(fm.tools),
      allowedTools: [CREWTREE_TOOLS_PATTERN],
      permissionMode: this.opts.allowWrites ? 'default' : 'plan',
      sessionAgentId: this.id,
      mcpServers: { [CREWTREE_MCP_SERVER_NAME]: createAgentMcpServer(ctx, handlers) },
      boundTools: bindTools(ctx, handlers),
      maxTurns: fm.maxTurns ?? 30,
      // The sandbox never loads a session's config groups: same defaults as a new session
      canUseTool: (tool, input) => this.canUseTool(tool, input),
      onEvent: (raw) => this.onDriverEvent(raw),
    });
  }

  private async canUseTool(tool: string, input: any) {
    if (!this.opts.allowWrites && WRITE_TOOLS.has(tool)) {
      return { allow: false, reason: 'File writes are turned off in the sandbox (Try it).' };
    }
    const id = nanoid(8);
    const allow = await new Promise<boolean>((resolve) => {
      this.pending.set(id, { id, tool, input, resolve });
      this.emit({ type: 'permission', data: { id, tool, input } });
    });
    return allow ? { allow: true } : { allow: false, reason: 'Denied by the user' };
  }

  decide(permissionId: string, allow: boolean) {
    const p = this.pending.get(permissionId);
    if (!p) throw new Error('Permission request not found');
    this.pending.delete(permissionId);
    this.emit({ type: 'permission.resolved', data: { id: permissionId, allow } });
    p.resolve(allow);
  }

  private onDriverEvent(raw: any) {
    if (raw?.type === 'crewtree.error') {
      this.emit({ type: 'error', data: { error: raw.error } });
      this.setStatus('error');
      return;
    }
    for (const event of this.normalizer.normalize(raw) as AgentEvent[]) this.emit({ type: 'event', data: event });
    if (raw?.type === 'result') {
      this.lastActiveAt = Date.now();
      if (raw.is_error && raw.subtype !== 'error_max_turns') {
        this.emit({ type: 'error', data: { error: raw.result || raw.subtype } });
      }
      this.setStatus('idle');
    }
  }

  async send(input: ComposeInput) {
    if (!this.driver) throw new Error('Sandbox is not running');
    const text = composeMessage(input, this.opts.cwd);
    this.lastActiveAt = Date.now();
    this.emit({
      type: 'event',
      data: { type: 'message.created', payload: { role: 'user', content: text }, ts: Date.now() },
    });
    this.setStatus('running');
    await this.driver.sendMessage(text);
  }

  async interrupt() {
    for (const p of this.pending.values()) p.resolve(false);
    this.pending.clear();
    await this.driver?.interrupt();
  }

  async dispose() {
    for (const p of this.pending.values()) p.resolve(false);
    this.pending.clear();
    this.listeners.clear();
    await this.driver?.dispose();
  }
}

/** Agent Editor "Try it": a real agent run outside any session (PLAN.md 6.4, UI-WIREFRAMES 8). */
export class TryItService {
  private static instance: TryItService;
  private sandboxes = new Map<string, Sandbox>();
  private timer = setInterval(() => void this.sweep(), 60_000);

  private constructor() {
    this.timer.unref?.();
  }

  public static getInstance(): TryItService {
    if (!TryItService.instance) TryItService.instance = new TryItService();
    return TryItService.instance;
  }

  private driverType(): 'sdk' | 'fake' {
    return process.env.CREWTREE_DRIVER === 'fake' ? 'fake' : 'sdk';
  }

  public async start(opts: StartOptions): Promise<{ id: string }> {
    if (this.sandboxes.size >= MAX_SANDBOXES) {
      // Drop the least recently used sandbox instead of refusing
      const oldest = [...this.sandboxes.values()].sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
      await this.stop(oldest.id);
    }
    const sandbox = new Sandbox(opts, this.driverType());
    await sandbox.start();
    this.sandboxes.set(sandbox.id, sandbox);
    return { id: sandbox.id };
  }

  public get(id: string): Sandbox {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox) throw new Error('Sandbox not found');
    return sandbox;
  }

  public async stop(id: string): Promise<void> {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox) return;
    this.sandboxes.delete(id);
    await sandbox.dispose();
  }

  private async sweep() {
    const now = Date.now();
    for (const s of [...this.sandboxes.values()]) {
      if (s.status !== 'running' && now - s.lastActiveAt > IDLE_DISPOSE_MS) await this.stop(s.id);
    }
  }

  public async disposeAll(): Promise<void> {
    clearInterval(this.timer);
    await Promise.all([...this.sandboxes.keys()].map((id) => this.stop(id)));
  }
}
