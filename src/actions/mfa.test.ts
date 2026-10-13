import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/db-harness";

const dbHolder = vi.hoisted(() => ({ current: null as unknown as TestDb }));
const cookieHolder = vi.hoisted(() => ({ token: "", authorization: null as string | null }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(cookieHolder.authorization === null ? {} : { authorization: cookieHolder.authorization }),
  cookies: vi.fn(async () => ({
    get: () => ({ value: cookieHolder.token }),
  })),
}));
vi.mock("@/db", () => ({
  get db() {
    return dbHolder.current;
  },
}));

import { beginMfaEnrollment, disableMfa, enableMfa } from "@/actions/mfa";
import {
  confirmMfaEnrollment,
  getMfaStatus,
  startMfaEnrollment,
} from "@/db/mfa";
import { createSessionToken, hashLoginKey } from "@/lib/auth";
import { generateTotp } from "@/lib/mfa";
import { createTestDb } from "@/test/db-harness";

const originalEnv = { ...process.env };

describe("MFA server actions", () => {
  let ctx: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    process.env.APP_AUTH_SECRET = "test-auth-secret";
    process.env.APP_LOGIN_KEY_HASH = await hashLoginKey("local-secret");
    ctx = createTestDb();
    dbHolder.current = ctx.db;
    cookieHolder.token = await createSessionToken();
    cookieHolder.authorization = null;

    const enrollment = startMfaEnrollment(ctx.db, {
      issuer: "Team Account Manager",
      accountName: "admin",
      now: 59_000,
    });
    const code = generateTotp(enrollment.secret, { timestamp: 59_000 });
    confirmMfaEnrollment(ctx.db, code, 59_000);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    ctx.sqlite.close();
  });

  it("requires the login key before disabling MFA", async () => {
    await expect(disableMfa("wrong-secret")).resolves.toEqual({
      ok: false,
      error: "访问密钥不正确。",
    });
    expect(getMfaStatus(ctx.db)).toEqual({ enabled: true });

    await expect(disableMfa("local-secret")).resolves.toEqual({ ok: true });
    expect(getMfaStatus(ctx.db)).toEqual({ enabled: false });
  });
  it.each(["read-only", "customer"])("does not let %s bearer credentials use an ambient owner session to change MFA", async role => {
    cookieHolder.authorization = "Bearer sbm_test_" + role;
    const before = ctx.sqlite.serialize();
    const denied = { ok: false, error: "登录状态已失效，请重新登录。" };
    await expect(beginMfaEnrollment()).resolves.toEqual(denied);
    await expect(enableMfa("123456")).resolves.toEqual(denied);
    await expect(disableMfa("local-secret")).resolves.toEqual(denied);
    expect(ctx.sqlite.serialize()).toEqual(before);
    expect(getMfaStatus(ctx.db)).toEqual({ enabled: true });
  });
});
