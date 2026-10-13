import { desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { accountReceipt, currency } from "./schema";

type Db = BetterSQLite3Database<Record<string, unknown>>;
export type AccountReceiptRow = typeof accountReceipt.$inferSelect;
export type AccountReceiptListRow = {
  receipt: AccountReceiptRow;
  currency: typeof currency.$inferSelect;
};

export function listAccountReceipts(db: Db, spaceId: number): AccountReceiptListRow[] {
  return db.select({ receipt: accountReceipt, currency }).from(accountReceipt)
    .innerJoin(currency, eq(currency.code, accountReceipt.currencyCode))
    .where(eq(accountReceipt.spaceId, spaceId))
    .orderBy(desc(accountReceipt.receivedDate), desc(accountReceipt.id)).all();
}
