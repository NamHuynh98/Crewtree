// SPDX-License-Identifier: Apache-2.0
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const appSettingsTable = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(), // JSON
  updatedAt: integer('updated_at').notNull(),
});

export const resourceRevisionsTable = sqliteTable(
  'resource_revisions',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    scope: text('scope').notNull(),
    path: text('path').notNull(),
    /** Resource name: the history follows an agent across moves between scopes */
    name: text('name').notNull().default(''),
    /** baseline | create | update | delete | move | rollback */
    action: text('action').notNull().default('update'),
    content: text('content').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('resource_revisions_kind_name_idx').on(t.kind, t.name)]
);

export const projectsTable = sqliteTable('projects', {
  id: text('id').primaryKey(),
  path: text('path').notNull().unique(),
  lastOpenedAt: integer('last_opened_at').notNull(),
});

export const sessionsTable = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  projectId: text('project_id'),
  title: text('title').notNull(),
  cwd: text('cwd').notNull(),
  supervisorAgentId: text('supervisor_agent_id').notNull(),
  status: text('status').notNull().default('active'),
  settings: text('settings').notNull(), // JSON
  totalTokens: integer('total_tokens').notNull().default(0),
  totalTurns: integer('total_turns').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const sessionAgentsTable = sqliteTable(
  'session_agents',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    agentName: text('agent_name').notNull(),
    scope: text('scope').notNull(),
    snapshot: text('snapshot').notNull(), // Markdown definition
    parentId: text('parent_id'),
    depth: integer('depth').notNull().default(0),
    alias: text('alias'),
    spawnedBy: text('spawned_by').notNull().default('user'),
    modelOverride: text('model_override'),
    canDelegateOverride: integer('can_delegate_override', { mode: 'boolean' }),
    freshContextOverride: integer('fresh_context_override', { mode: 'boolean' }),
    sdkSessionId: text('sdk_session_id'),
    status: text('status').notNull().default('idle'),
    lastActiveAt: integer('last_active_at').notNull(),
  },
  (t) => [index('session_agents_session_idx').on(t.sessionId)]
);

export const tasksTable = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    fromAgentId: text('from_agent_id'), // null = user
    toAgentId: text('to_agent_id').notNull(),
    parentTaskId: text('parent_task_id'),
    title: text('title').notNull(),
    instructions: text('instructions').notNull(),
    scope: text('scope').notNull(), // JSON array
    status: text('status').notNull().default('queued'),
    isRoot: integer('is_root', { mode: 'boolean' }).notNull().default(false),
    question: text('question'),
    answer: text('answer'),
    resultSummary: text('result_summary'),
    resultDetails: text('result_details'),
    completedBy: text('completed_by'),
    progress: text('progress'),
    files: text('files'), // JSON array of attachment paths forwarded to the child
    createdAt: integer('created_at').notNull().default(0),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
  },
  (t) => [index('tasks_session_idx').on(t.sessionId)]
);

export const messagesTable = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    sessionAgentId: text('session_agent_id').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(), // JSON blocks
    taskId: text('task_id'),
    delivery: text('delivery').notNull().default('delivered'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('messages_agent_created_idx').on(t.sessionAgentId, t.createdAt)]
);

export const eventsTable = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    sessionAgentId: text('session_agent_id'),
    type: text('type').notNull(),
    payload: text('payload').notNull(), // JSON
    ts: integer('ts').notNull(),
  },
  (t) => [index('events_session_id_idx').on(t.sessionId, t.id)]
);

export const attachmentsTable = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  filename: text('filename').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  path: text('path').notNull(),
});

export const approvalsTable = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  sessionAgentId: text('session_agent_id').notNull(),
  tool: text('tool').notNull(),
  input: text('input').notNull(), // JSON
  status: text('status').notNull().default('pending'),
  rule: text('rule'),
  pattern: text('pattern'),
  reason: text('reason'),
  label: text('label'), // e.g. 'outside_scope'
  suggestedPattern: text('suggested_pattern'),
  taskId: text('task_id'),
  createdAt: integer('created_at').notNull(),
  decidedAt: integer('decided_at'),
});

export const fileTouchesTable = sqliteTable('file_touches', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  sessionAgentId: text('session_agent_id').notNull(),
  taskId: text('task_id'),
  path: text('path').notNull(),
  op: text('op').notNull(), // 'edit' | 'write' | 'bash'
  snapshotPath: text('snapshot_path'),
  ts: integer('ts').notNull(),
});
