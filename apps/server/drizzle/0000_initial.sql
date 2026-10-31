CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`session_agent_id` text NOT NULL,
	`tool` text NOT NULL,
	`input` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`rule` text,
	`pattern` text,
	`reason` text,
	`created_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`path` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`session_agent_id` text,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `file_touches` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`session_agent_id` text NOT NULL,
	`task_id` text,
	`path` text NOT NULL,
	`op` text NOT NULL,
	`snapshot_path` text,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_agent_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`task_id` text,
	`delivery` text DEFAULT 'delivered' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`last_opened_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_path_unique` ON `projects` (`path`);--> statement-breakpoint
CREATE TABLE `resource_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`scope` text NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`agent_name` text NOT NULL,
	`scope` text NOT NULL,
	`snapshot` text NOT NULL,
	`parent_id` text,
	`depth` integer DEFAULT 0 NOT NULL,
	`alias` text,
	`spawned_by` text DEFAULT 'user' NOT NULL,
	`model_override` text,
	`can_delegate_override` integer,
	`fresh_context_override` integer,
	`sdk_session_id` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`last_active_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`title` text NOT NULL,
	`cwd` text NOT NULL,
	`supervisor_agent_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`settings` text NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`total_turns` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`from_agent_id` text,
	`to_agent_id` text NOT NULL,
	`parent_task_id` text,
	`title` text NOT NULL,
	`instructions` text NOT NULL,
	`scope` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`is_root` integer DEFAULT false NOT NULL,
	`question` text,
	`answer` text,
	`result_summary` text,
	`result_details` text,
	`completed_by` text,
	`started_at` integer,
	`ended_at` integer
);
