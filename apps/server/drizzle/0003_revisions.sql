ALTER TABLE `resource_revisions` ADD `name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `resource_revisions` ADD `action` text DEFAULT 'update' NOT NULL;--> statement-breakpoint
CREATE INDEX `resource_revisions_kind_name_idx` ON `resource_revisions` (`kind`,`name`);