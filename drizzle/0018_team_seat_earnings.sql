ALTER TABLE `child_account` ADD `usage_status` text;--> statement-breakpoint
ALTER TABLE `mother_account` ADD `usage_status` text;--> statement-breakpoint
ALTER TABLE `mother_account` ADD `expected_amount_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `mother_account` ADD `expected_currency_code` text REFERENCES currency(code);--> statement-breakpoint
ALTER TABLE `mother_account` ADD `expected_amount_usd` integer;--> statement-breakpoint
ALTER TABLE `mother_account` ADD `expected_rate_used` text;--> statement-breakpoint
ALTER TABLE `mother_account` ADD `expected_rate_as_of` text;--> statement-breakpoint
ALTER TABLE `mother_account` ADD `expected_rate_source` text;--> statement-breakpoint
ALTER TABLE `mother_account` ADD `billing_period_unit` text DEFAULT 'month' NOT NULL;--> statement-breakpoint
ALTER TABLE `mother_account` ADD `billing_period_count` integer DEFAULT 1 NOT NULL;