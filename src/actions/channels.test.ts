// Adapted for Subscription Butler (订阅管家); see NOTICE for upstream attribution.
vi.mock("@/lib/action-auth", () => ({ hasAdminSession: vi.fn().mockResolvedValue(true) }));
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { TestDb } from "@/test/db-harness";

// The Server Actions import the production `db` singleton and `revalidatePath`.
// Point the singleton at a fresh in-memory test DB and no-op revalidation so the
// actions can be exercised end-to-end against the harness (D-06..D-08 behaviors).
const dbHolder = vi.hoisted(() => ({ current: null as unknown as TestDb }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/db", () => ({
  get db() {
    return dbHolder.current;
  },
}));

import { createTestDb } from "@/test/db-harness";
import {
  addChannel,
  renameChannel,
  archiveChannel,
  reactivateChannel,
  updateChannel,
  setChannelFavorite,
} from "@/actions/channels";
import { listChannels } from "@/db/channels";
import { paymentChannel } from "@/db/schema";

describe("channel server actions (REF-01)", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    ctx = createTestDb();
    dbHolder.current = ctx.db;
  });

  afterEach(() => {
    ctx.sqlite.close();
  });

  it("addChannel inserts an active row with a surrogate id", async () => {
    const res = await addChannel("支付宝");
    expect(res.ok).toBe(true);
    const rows = ctx.db.select().from(paymentChannel).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].isActive).toBe(true);
    expect(rows[0].id).toBeGreaterThan(0);
  });

  it("rejects an empty name via server-side Zod re-validation (T-03-INPUT)", async () => {
    const res = await addChannel("   ");
    expect(res.ok).toBe(false);
    expect(ctx.db.select().from(paymentChannel).all()).toHaveLength(0);
  });

  it("rejects a duplicate active name", async () => {
    await addChannel("支付宝");
    const res = await addChannel("支付宝");
    expect(res.ok).toBe(false);
    expect(ctx.db.select().from(paymentChannel).all()).toHaveLength(1);
  });

  it("archiveChannel soft-deletes: row preserved, excluded from active query (D-06/D-07)", async () => {
    await addChannel("支付宝");
    const { id } = ctx.db.select().from(paymentChannel).get()!;
    const res = await archiveChannel(id);
    expect(res.ok).toBe(true);
    expect(ctx.db.select().from(paymentChannel).all()).toHaveLength(1);
    expect(listChannels(ctx.db, false)).toHaveLength(0);
  });

  it("reactivateChannel restores an archived row to the active list (D-08)", async () => {
    await addChannel("微信");
    const { id } = ctx.db.select().from(paymentChannel).get()!;
    await archiveChannel(id);
    await reactivateChannel(id);
    expect(listChannels(ctx.db, false)).toHaveLength(1);
  });

  it("renameChannel updates name but keeps the same id (D-05)", async () => {
    await addChannel("支付宝");
    const before = ctx.db.select().from(paymentChannel).get()!;
    const res = await renameChannel(before.id, "支付宝-个人");
    expect(res.ok).toBe(true);
    const after = ctx.db.select().from(paymentChannel).get()!;
    expect(after.id).toBe(before.id);
    expect(after.name).toBe("支付宝-个人");
  });

  it("stores channel metadata and ignores attempts to set ids or archive through the form", async () => {
    const result = await addChannel({
      name: " Main card ", channelType: "card", provider: " Example Pay ",
      identifier: " 1234 ", note: " Recharge before renewal ", isFavorite: true,
      id: 999, isActive: false,
    });
    expect(result).toEqual({ ok: true });
    const row = listChannels(ctx.db)[0];
    expect(row).toMatchObject({ name: "Main card", provider: "Example Pay", channelType: "card",
      identifier: "1234", note: "Recharge before renewal", isFavorite: true, isActive: true });
    expect(row.id).not.toBe(999);
    expect(await updateChannel(row.id, { name: "Work card", note: "Updated" })).toEqual({ ok: true });
    expect(listChannels(ctx.db)[0]).toMatchObject({ id: row.id, provider: "Example Pay", identifier: "1234", note: "Updated" });
  });

  it.each([
    { name: "x".repeat(81) }, { name: "Card", channelType: "invalid" },
    { name: "Card", identifier: "x".repeat(81) }, { name: "Card", note: "x".repeat(1001) },
    { name: "Card", isFavorite: "yes" },
  ])("rejects invalid channel metadata", async data => {
    expect((await addChannel(data)).ok).toBe(false);
    expect(listChannels(ctx.db, true)).toHaveLength(0);
  });

  it("blocks active duplicate names irrespective of ASCII casing and surrounding spaces", async () => {
    await addChannel("Visa");
    expect((await addChannel(" visa ")).ok).toBe(false);
    expect(listChannels(ctx.db)).toHaveLength(1);
  });

  it("allows renaming an archived duplicate before restoring it", async () => {
    await addChannel("Visa");
    const original = listChannels(ctx.db)[0];
    await archiveChannel(original.id);
    await addChannel("VISA");
    expect((await reactivateChannel(original.id)).ok).toBe(false);
    expect(listChannels(ctx.db)).toHaveLength(1);
    expect(await updateChannel(original.id, { name: "Visa backup", provider: "Bank" })).toEqual({ ok: true });
    expect(await reactivateChannel(original.id)).toEqual({ ok: true });
    expect(listChannels(ctx.db)).toHaveLength(2);
  });

  it("prioritizes favorites and preserves their metadata through archive and restore", async () => {
    await addChannel("First");
    await addChannel({ name: "Second", identifier: "1234" });
    const second = listChannels(ctx.db)[1];
    expect(await setChannelFavorite(second.id, true)).toEqual({ ok: true });
    expect(listChannels(ctx.db)[0].id).toBe(second.id);
    await archiveChannel(second.id);
    expect(listChannels(ctx.db).map(row => row.name)).toEqual(["First"]);
    expect((await setChannelFavorite(second.id, false)).ok).toBe(false);
    await reactivateChannel(second.id);
    expect(listChannels(ctx.db)[0]).toMatchObject({ id: second.id, isFavorite: true, identifier: "1234" });
  });

  it("reports nonexistent channels instead of returning a false success", async () => {
    expect((await archiveChannel(999)).ok).toBe(false);
    expect((await reactivateChannel(999)).ok).toBe(false);
    expect((await updateChannel(999, { name: "Missing" })).ok).toBe(false);
    expect((await setChannelFavorite(999, true)).ok).toBe(false);
  });
});
