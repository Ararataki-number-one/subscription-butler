CREATE TABLE `account_receipt` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`space_id` integer NOT NULL,
	`received_date` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency_code` text NOT NULL,
	`rate_used` text NOT NULL,
	`rate_as_of` text NOT NULL,
	`rate_source` text NOT NULL,
	`amount_usd` integer NOT NULL,
	`payer` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`currency_code`) REFERENCES `currency`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `space` ADD `plan_type` text DEFAULT 'team' NOT NULL;--> statement-breakpoint
ALTER TABLE `space` ADD `custom_plan_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `space` ADD `contact` text DEFAULT '' NOT NULL;