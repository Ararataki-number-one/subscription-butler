import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ token: undefined as string | undefined, challenge: undefined as string | undefined, authorization: null as string | null, dbCalls: 0, fxCalls: 0, mailCalls: 0 }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "tam_session" && state.token ? { value: state.token } : name === "tam_mfa_challenge" && state.challenge ? { value: state.challenge } : undefined }),
  headers: async () => new Headers(state.authorization === null ? {} : { authorization: state.authorization }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/db", () => ({ db: new Proxy({}, { get() { state.dbCalls++; throw new Error("Unauthorized database access"); } }) }));
vi.mock("@/lib/fx/frankfurter", () => ({ ensureFreshRates: async () => { state.fxCalls++; throw new Error("Unexpected FX call"); }, refreshFromApi: async () => { state.fxCalls++; throw new Error("Unexpected FX call"); } }));
vi.mock("@/lib/email/smtp", () => ({ sendSmtpEmail: async () => { state.mailCalls++; throw new Error("Unexpected email"); } }));
import { hasAdminSession } from "./action-auth";
import { createMfaChallengeToken, createSessionToken } from "./auth";
import * as receipts from "@/actions/accountReceipts";
import * as channels from "@/actions/channels";
import * as children from "@/actions/childAccounts";
import * as currencies from "@/actions/currencies";
import * as fx from "@/actions/fx";
import * as settings from "@/actions/settings";
import * as spaces from "@/actions/spaces";
import * as seats from "@/actions/teamSeats";

const actions = Object.entries({ ...receipts, ...channels, ...children, ...currencies, ...fx, ...settings, ...spaces, ...seats });
async function assertAllRejected() {
  expect(actions).toHaveLength(29);
  for (const [name, action] of actions) {
    const result = await (action as (...args: unknown[]) => Promise<unknown>)(undefined, undefined, undefined);
    expect(result, name).toEqual({ ok: false, error: "登录状态已失效，请重新登录。" });
  }
  expect(state.dbCalls).toBe(0); expect(state.fxCalls).toBe(0); expect(state.mailCalls).toBe(0);
}
describe("legacy actions authenticate independently of their dispatching page", () => {
  beforeEach(() => { vi.stubEnv("APP_AUTH_SECRET", "test-only-legacy-signing-secret"); state.token = undefined; state.challenge = undefined; state.authorization = null; state.dbCalls = 0; state.fxCalls = 0; state.mailCalls = 0; });
  afterEach(() => vi.unstubAllEnvs());
  it("denies every exported business action before validation, database, FX or email work", async () => { await assertAllRejected(); });
  it("denies MFA-challenge-only sessions and challenge tokens supplied as owner cookies", async () => {
    state.challenge = await createMfaChallengeToken(); await assertAllRejected(); state.token = state.challenge; await assertAllRejected();
  });
  it("denies an invalid or expired owner token", async () => {
    state.token = "invalid"; await assertAllRejected(); state.token = await createSessionToken(Date.now() - 8 * 86400000); await assertAllRejected();
  });
  it("denies member bearer credentials even when a valid owner cookie is present", async () => {
    state.token = await createSessionToken(); state.authorization = "Bearer sbm_readonly_test_only"; await assertAllRejected();
  });
  it("accepts a real signed owner cookie, without any test-environment bypass", async () => { state.token = await createSessionToken(); expect(await hasAdminSession()).toBe(true); });
});
