ALTER TABLE payment_channel ADD fee_percent text DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE space ADD fee_percent text DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE space ADD fee_amount_minor integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE space ADD base_amount_usd integer;
--> statement-breakpoint
UPDATE space SET base_amount_usd = amount_usd;
--> statement-breakpoint
ALTER TABLE child_account ADD is_mother_account integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE child_account SET is_mother_account = 1 WHERE EXISTS (
  SELECT 1 FROM space s JOIN mother_account m ON m.space_id = s.id
  WHERE s.id = child_account.space_id AND s.plan_type = 'team'
  AND lower(trim(m.email)) = lower(trim(child_account.email))
);
--> statement-breakpoint
UPDATE mother_account SET
  usage_status = (SELECT COALESCE(c.usage_status, CASE WHEN c.monthly_rate_source = 'self-use' THEN 'self' ELSE 'rented' END) FROM child_account c WHERE c.space_id = mother_account.space_id AND c.is_mother_account = 1 ORDER BY c.updated_at DESC, c.id DESC LIMIT 1),
  contact = (SELECT c.contact FROM child_account c WHERE c.space_id = mother_account.space_id AND c.is_mother_account = 1 ORDER BY c.updated_at DESC, c.id DESC LIMIT 1),
  label = (SELECT c.label FROM child_account c WHERE c.space_id = mother_account.space_id AND c.is_mother_account = 1 ORDER BY c.updated_at DESC, c.id DESC LIMIT 1),
  joined_date = (SELECT c.joined_date FROM child_account c WHERE c.space_id = mother_account.space_id AND c.is_mother_account = 1 ORDER BY c.updated_at DESC, c.id DESC LIMIT 1),
  monthly_payment_day = (SELECT c.monthly_payment_day FROM child_account c WHERE c.space_id = mother_account.space_id AND c.is_mother_account = 1 ORDER BY c.updated_at DESC, c.id DESC LIMIT 1),
  next_payment_date = (SELECT c.next_payment_date FROM child_account c WHERE c.space_id = mother_account.space_id AND c.is_mother_account = 1 ORDER BY c.updated_at DESC, c.id DESC LIMIT 1),
  expected_amount_minor = (SELECT c.monthly_amount_minor FROM child_account c WHERE c.space_id = mother_account.space_id AND c.is_mother_account = 1 ORDER BY c.updated_at DESC, c.id DESC LIMIT 1),
  expected_currency_code = (SELECT c.monthly_currency_code FROM child_account c WHERE c.space_id = mother_account.space_id AND c.is_mother_account = 1 ORDER BY c.updated_at DESC, c.id DESC LIMIT 1),
  expected_amount_usd = (SELECT c.monthly_amount_usd FROM child_account c WHERE c.space_id = mother_account.space_id AND c.is_mother_account = 1 ORDER BY c.updated_at DESC, c.id DESC LIMIT 1),
  expected_rate_used = (SELECT c.monthly_rate_used FROM child_account c WHERE c.space_id = mother_account.space_id AND c.is_mother_account = 1 ORDER BY c.updated_at DESC, c.id DESC LIMIT 1),
  expected_rate_as_of = (SELECT c.monthly_rate_as_of FROM child_account c WHERE c.space_id = mother_account.space_id AND c.is_mother_account = 1 ORDER BY c.updated_at DESC, c.id DESC LIMIT 1),
  expected_rate_source = (SELECT c.monthly_rate_source FROM child_account c WHERE c.space_id = mother_account.space_id AND c.is_mother_account = 1 ORDER BY c.updated_at DESC, c.id DESC LIMIT 1),
  billing_period_unit = (SELECT c.billing_period_unit FROM child_account c WHERE c.space_id = mother_account.space_id AND c.is_mother_account = 1 ORDER BY c.updated_at DESC, c.id DESC LIMIT 1),
  billing_period_count = (SELECT c.billing_period_count FROM child_account c WHERE c.space_id = mother_account.space_id AND c.is_mother_account = 1 ORDER BY c.updated_at DESC, c.id DESC LIMIT 1)
WHERE EXISTS (SELECT 1 FROM child_account c WHERE c.space_id = mother_account.space_id AND c.is_mother_account = 1);
--> statement-breakpoint
UPDATE space SET sharing_mode = 'shared' WHERE plan_type IN ('pro5x', 'pro20x');

