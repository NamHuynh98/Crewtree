CREATE INDEX `events_session_id_idx` ON `events` (`session_id`,`id`);--> statement-breakpoint
CREATE INDEX `messages_agent_created_idx` ON `messages` (`session_agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `session_agents_session_idx` ON `session_agents` (`session_id`);--> statement-breakpoint
CREATE INDEX `tasks_session_idx` ON `tasks` (`session_id`);