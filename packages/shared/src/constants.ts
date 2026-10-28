// SPDX-License-Identifier: Apache-2.0

export const AGENT_STATUSES = [
  'idle',
  'running',
  'queued',
  'waiting_children',
  'waiting_input',
  'needs_input',
  'throttled',
  'suspended',
  'error',
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const TASK_STATUSES = [
  'queued',
  'running',
  'needs_input',
  'done',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const SESSION_STATUSES = [
  'active',
  'paused',
  'completed',
  'stopped',
  'error',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const RESOURCE_KINDS = [
  'agent',
  'skill',
  'command',
  'memory',
  'mcp',
  'plugin',
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export const RESOURCE_SCOPES = [
  'crewtree',
  'user',
  'project',
  'plugin',
  'builtin',
] as const;
export type ResourceScope = (typeof RESOURCE_SCOPES)[number];

export const RUNTIMES = [
  'claude',
  'opencode',
  'codex',
  'gemini-cli',
] as const;
export type RuntimeType = (typeof RUNTIMES)[number];

export const EVENT_TYPES = [
  'agent.status',
  'agent.text.delta',
  'agent.text.done',
  'agent.tool.start',
  'agent.tool.end',
  'agent.permission.request',
  'approval.created',
  'approval.resolved',
  'agent.spawned',
  'agent.removed',
  'task.created',
  'task.updated',
  'task.question',
  'message.created',
  'usage.updated',
  'file.touched',
  'file.conflict',
  'session.status',
  'resource.changed',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const DEFAULT_SUPERVISOR_NAME = 'crewtree-supervisor';
export const DEFAULT_PORT = 4317;
export const DEFAULT_MAX_CONCURRENT_AGENTS = 3;
export const DEFAULT_MAX_DEPTH = 4;
export const DEFAULT_MAX_TOTAL_AGENTS = 10;
export const DEFAULT_MAX_TURNS_PER_AGENT = 60;
export const DEFAULT_MAX_TOKENS_PER_SESSION = 500_000;
export const DEFAULT_IDLE_SUSPEND_MINUTES = 5;
export const DEFAULT_EVENTS_RETENTION_DAYS = 30;
