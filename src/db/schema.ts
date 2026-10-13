// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { SPACE_PLAN_TYPES, SHARING_MODES } from "@/lib/space-plans";
import { CHANNEL_TYPES } from "@/lib/payment-channels";
import { SEAT_USAGE_STATUSES } from "@/lib/seat-usage";

/**
 * REF-02 — curated, seeded currency list (D-01/02/03).
 *
 * `minorUnit` is the authoritative ISO-4217 exponent (JPY = 0, others = 2) that
 * drives all integer-minor-unit money math downstream.
 */
export const currency = sqliteTable("currency", {
  code: text("code").primaryKey(), // ISO-4217 code, e.g. USD/CNY/THB/SGD
  name: text("name").notNull(),
  symbol: text("symbol").notNull().default(""),
  countryCode: text("country_code").notNull().default(""),
  countryName: text("country_name").notNull().default(""),
  minorUnit: integer("minor_unit").notNull(), // JPY=0, others=2 — money authority
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
});

/**
 * REF-01 — user-maintained payment channels.
 *
 * Surrogate `id` PK + FK reference (D-05, never name strings). Uniform
 * soft-delete via `isActive` (D-06) — there is no hard-delete path.
 */
export const paymentChannel = sqliteTable("payment_channel", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  channelType: text("channel_type", { enum: CHANNEL_TYPES }).notNull().default("other"),
  provider: text("provider").notNull().default(""),
  identifier: text("identifier").notNull().default(""),
  note: text("note").notNull().default(""),
  isFavorite: integer("is_favorite", { mode: "boolean" }).notNull().default(false),
  feePercent: text("fee_percent").notNull().default("0"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

/**
 * FX-01 — exchange-rate cache (Phase 2, D-01/D-02/D-03).
 *
 * One row per currency (`currencyCode` text PK, FK → `currency.code`) so the
 * cache is limited to locally enabled currencies. `rateToUsd` is the X→USD value
 * as a decimal STRING — never a float column (D-02). `fetchedAt` is the ISO
 * wall-clock of the successful fetch and drives both the "rates as of" label
 * (D-05) and the staleness age check (D-07). Staleness itself is computed
 * per-request in Plan 02 (Pattern 3) and is intentionally NOT persisted here.
 */
export const fxRate = sqliteTable("fx_rate", {
  currencyCode: text("currency_code")
    .primaryKey() // one row per currency (D-01)
    .references(() => currency.code), // FK to the seeded currency list
  rateToUsd: text("rate_to_usd").notNull(), // X→USD decimal STRING, never float (D-02)
  quoteDate: text("quote_date"), // Provider's quotation date; unknown for old cache rows.
  source: text("source").notNull().default("frankfurter"),
  fetchedAt: text("fetched_at").notNull(), // ISO wall-clock of successful fetch (D-05/D-07)
});
export type FxRateRow = typeof fxRate.$inferSelect;

export const appSetting = sqliteTable("app_setting", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
export type AppSettingRow = typeof appSetting.$inferSelect;

/**
 * Phase 3 entity — DECLARED NOW (Pattern 2) so the money/FX-snapshot/period
 * columns never require a backfill migration over live data. All FX/period
 * columns are nullable until Phase 3 populates them.
 */
export const space = sqliteTable("space", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  planType: text("plan_type", { enum: SPACE_PLAN_TYPES }).notNull().default("team"),
  sharingMode: text("sharing_mode", { enum: SHARING_MODES }).notNull().default("single"),
  customPlanName: text("custom_plan_name").notNull().default(""),
  contact: text("contact").notNull().default(""),
  country: text("country").notNull(), // ISO-3166 alpha-2 (D-11)
  paymentChannelId: integer("payment_channel_id")
    .notNull()
    .references(() => paymentChannel.id), // FK preserves integrity (D-07)
  currencyCode: text("currency_code")
    .notNull()
    .references(() => currency.code),
  // money as integer minor units (Pattern 3)
  amountMinor: integer("amount_minor").notNull(),
  feePercent: text("fee_percent").notNull().default("0"),
  feeAmountMinor: integer("fee_amount_minor").notNull().default(0),
  baseAmountUsd: integer("base_amount_usd"),
  // structured subscription period {unit, count} (locked names)
  periodUnit: text("period_unit"), // 'month' | 'quarter' | 'year'
  periodCount: integer("period_count"),
  // FX-snapshot reserved columns (locked names; nullable until Phase 3)
  rateUsed: text("rate_used"), // decimal string, not float
  rateAsOf: text("rate_as_of"),
  rateSource: text("rate_source"),
  amountUsd: integer("amount_usd"), // USD minor units, frozen at payment
  openingDate: text("opening_date"), // first activation date, YYYY-MM-DD
  currentPeriodStartDate: text("current_period_start_date"), // current paid period start, YYYY-MM-DD
  expiryDate: text("expiry_date"), // derived from currentPeriodStartDate + period
});

/** Actual receipts for an independent subscription, retained across renewals. */
export const accountReceipt = sqliteTable("account_receipt", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  spaceId: integer("space_id").notNull().references(() => space.id, { onDelete: "cascade" }),
  receivedDate: text("received_date").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currencyCode: text("currency_code").notNull().references(() => currency.code),
  rateUsed: text("rate_used").notNull(),
  rateAsOf: text("rate_as_of").notNull(),
  rateSource: text("rate_source").notNull(),
  amountUsd: integer("amount_usd").notNull(),
  payer: text("payer").notNull().default(""),
  note: text("note").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const motherAccount = sqliteTable("mother_account", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  spaceId: integer("space_id")
    .notNull()
    .unique()
    .references(() => space.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  contact: text("contact").notNull().default(""),
  label: text("label").notNull().default(""),
  joinedDate: text("joined_date"),
  monthlyPaymentDay: integer("monthly_payment_day"),
  nextPaymentDate: text("next_payment_date"),
  usageStatus: text("usage_status", { enum: SEAT_USAGE_STATUSES }),
  expectedAmountMinor: integer("expected_amount_minor").notNull().default(0),
  expectedCurrencyCode: text("expected_currency_code").references(() => currency.code),
  expectedAmountUsd: integer("expected_amount_usd"),
  expectedRateUsed: text("expected_rate_used"),
  expectedRateAsOf: text("expected_rate_as_of"),
  expectedRateSource: text("expected_rate_source"),
  billingPeriodUnit: text("billing_period_unit").notNull().default("month"),
  billingPeriodCount: integer("billing_period_count").notNull().default(1),
  // Retain legacy SQL defaults; writes always supply the fixed chatgpt type.
  seatType: text("seat_type").notNull().default("codex"),
  canChangeSeatType: integer("can_change_seat_type", { mode: "boolean" })
    .notNull()
    .default(true),
});
export type MotherAccountRow = typeof motherAccount.$inferSelect;

export const childAccount = sqliteTable("child_account", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  spaceId: integer("space_id")
    .notNull()
    .references(() => space.id, { onDelete: "cascade" }),
  isMotherAccount: integer("is_mother_account", { mode: "boolean" }).notNull().default(false),
  seatType: text("seat_type").notNull().default("codex"),
  usageStatus: text("usage_status", { enum: SEAT_USAGE_STATUSES }),
  email: text("email").notNull(),
  contact: text("contact").notNull().default(""),
  label: text("label").notNull().default(""),
  joinedDate: text("joined_date").notNull(),
  monthlyAmountMinor: integer("monthly_amount_minor").notNull(),
  monthlyCurrencyCode: text("monthly_currency_code")
    .notNull()
    .references(() => currency.code),
  monthlyRateUsed: text("monthly_rate_used").notNull(),
  monthlyRateAsOf: text("monthly_rate_as_of").notNull(),
  monthlyRateSource: text("monthly_rate_source").notNull(),
  monthlyAmountUsd: integer("monthly_amount_usd").notNull(),
  monthlyPaymentDay: integer("monthly_payment_day").notNull(),
  billingPeriodUnit: text("billing_period_unit").notNull().default("month"),
  billingPeriodCount: integer("billing_period_count").notNull().default(1),
  nextPaymentDate: text("next_payment_date"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});
export type ChildAccountRow = typeof childAccount.$inferSelect;

export const childAccountReminderSubscription = sqliteTable(
  "child_account_reminder_subscription",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    childAccountId: integer("child_account_id")
      .notNull()
      .references(() => childAccount.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    uniqueIndex("child_account_reminder_subscription_once_idx").on(
      table.childAccountId,
    ),
  ],
);
export type ChildAccountReminderSubscriptionRow =
  typeof childAccountReminderSubscription.$inferSelect;

export const childAccountReminderLog = sqliteTable(
  "child_account_reminder_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    childAccountId: integer("child_account_id")
      .notNull()
      .references(() => childAccount.id, { onDelete: "cascade" }),
    nextPaymentDate: text("next_payment_date").notNull(),
    recipientEmail: text("recipient_email").notNull(),
    sentAt: text("sent_at").notNull(),
  },
  (table) => [
    uniqueIndex("child_account_reminder_log_once_idx").on(
      table.childAccountId,
      table.nextPaymentDate,
      table.recipientEmail,
    ),
  ],
);
export type ChildAccountReminderLogRow =
  typeof childAccountReminderLog.$inferSelect;

export const spaceExpiryReminderLog = sqliteTable(
  "space_expiry_reminder_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    spaceId: integer("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    expiryDate: text("expiry_date").notNull(),
    thresholdDays: integer("threshold_days").notNull(),
    reminderDate: text("reminder_date"),
    recipientEmail: text("recipient_email").notNull(),
    sentAt: text("sent_at").notNull(),
  },
  (table) => [
    uniqueIndex("space_expiry_reminder_log_once_idx").on(
      table.spaceId,
      table.expiryDate,
      table.thresholdDays,
      table.reminderDate,
    ),
  ],
);
export type SpaceExpiryReminderLogRow =
  typeof spaceExpiryReminderLog.$inferSelect;
