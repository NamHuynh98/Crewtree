ALTER TABLE `approvals` ADD `label` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `suggested_pattern` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `task_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `progress` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `files` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `created_at` integer DEFAULT 0 NOT NULL;