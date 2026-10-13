ALTER TABLE `mother_account` ADD `contact` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `mother_account` ADD `label` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `mother_account` ADD `joined_date` text;
--> statement-breakpoint
ALTER TABLE `mother_account` ADD `monthly_payment_day` integer;
--> statement-breakpoint
ALTER TABLE `mother_account` ADD `next_payment_date` text;
--> statement-breakpoint
UPDATE `mother_account` SET `seat_type` = 'chatgpt', `can_change_seat_type` = 0;
--> statement-breakpoint
UPDATE `child_account` SET `seat_type` = 'chatgpt';
