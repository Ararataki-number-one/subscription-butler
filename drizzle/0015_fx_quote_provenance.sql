ALTER TABLE `fx_rate` ADD `quote_date` text;--> statement-breakpoint
ALTER TABLE `fx_rate` ADD `source` text DEFAULT 'frankfurter' NOT NULL;