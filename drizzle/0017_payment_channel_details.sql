ALTER TABLE `payment_channel` ADD `channel_type` text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_channel` ADD `provider` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_channel` ADD `identifier` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_channel` ADD `note` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_channel` ADD `is_favorite` integer DEFAULT false NOT NULL;