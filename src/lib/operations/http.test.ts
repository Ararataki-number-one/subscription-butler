import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../../../middleware";
import { createTestDb } from "@/test/db-harness";
import { seedCurrencies } from "@/db/seed";
import { createSessionToken } from "@/lib/auth";
import { createOperationsContext, handleOperationsApi, handleSyncApi } from "./http";
import type { OpsActor, OpsRole } from "./types";

const owner: OpsActor = { id: "local-admin", role: "admin" };
const endpoints = [
  ["operations", "snapshot", "GET"], ["operations", "report", "GET"], ["operations", "commands", "POST"], ["operations", "import", "POST"],
  ["operations", "access", "GET"], ["operations", "access", "POST"], ["operations", "access/test", "DELETE"], ["operations", "audit", "GET"],
  ["sync", "changes", "GET"], ["sync", "push", "POST"], ["sync", "status", "GET"], ["sync", "connect", "POST"], ["sync", "connect", "DELETE"],
  ["sync", "pull", "POST"], ["sync", "flush", "POST"], ["sync", "bootstrap", "POST"], ["sync", "conflicts", "GET"], ["sync", "conflicts/test/resolve", "POST"],
  ["sync", "outbox", "GET"], ["sync", "outbox/cancel", "POST"],
] as const;
describe("every operations and synchronization endpoint enforces authorization", () => {
  let database: ReturnType<typeof createTestDb>, context: ReturnType<typeof createOperationsContext>, cookie: string;
  beforeEach(async () => {
    vi.stubEnv("APP_AUTH_SECRET", "test-only-api-secret"); database = createTestDb(); seedCurrencies(database.db); context = createOperationsContext(database.sqlite);
    cookie = "tam_session=" + await createSessionToken();
    context.store.execute({ id: "ca", type: "customer.save", payload: { id: "customer:a", name: "Customer Alice", note: "private customer note" } }, owner);
    context.store.execute({ id: "cb", type: "customer.save", payload: { id: "customer:b", name: "Customer Bob" } }, owner);
    context.store.execute({ id: "sub", type: "subscription.save", payload: { id: "subscription:s", name: "Private subscription inventory", amountMinor: 1000, currency: "USD", period: { unit: "month", count: 1 }, startDate: "2026-10-01", endDate: "2026-11-01" } }, owner);
    for (const customerId of ["customer:a", "customer:b"]) {
      context.store.execute({ id: "bill-" + customerId.slice(-1), type: "bill.issue", payload: { id: "bill:" + customerId.slice(-1), subscriptionId: "subscription:s", customerId, startDate: "2026-10-01", endDate: "2026-11-01", amountMinor: 8000, currency: "USD", note: "private financial note" } }, owner);
    }
    context.store.execute({ id: "receipt-a", type: "entry.receive", payload: { billId: "bill:bill-a", amountMinor: 4000, currency: "USD", date: "2026-10-13" } }, owner);
  });
  afterEach(() => { database.sqlite.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  function request(group: string, route: string, method = "GET", token?: string, body?: unknown, headers?: HeadersInit) {
    return new Request("http://127.0.0.1/api/" + group + "/" + route, { method,
      headers: { ...(token ? { authorization: "Bearer " + token } : {}), "content-type": "application/json", ...headers }, body: ["GET", "DELETE"].includes(method) ? undefined : JSON.stringify(body ?? {}) });
  }
  const dispatch = (group: string, route: string, input: Request) => group === "operations" ? handleOperationsApi(input, route.split("?")[0], context) : handleSyncApi(input, route.split("?")[0], context);
  const member = (role: OpsRole) => context.access.invite(owner, { label: role, role, ...(role === "customer" ? { customerId: "customer:a" } : {}) });
  it("returns 401 at every endpoint without authentication and after credential revocation", async () => {
    const issued = member("admin"); context.access.revoke(owner, issued.credential.id);
    for (const [group, route, method] of endpoints) {
      expect((await dispatch(group, route, request(group, route, method))).status, group + "/" + route).toBe(401);
      expect((await dispatch(group, route, request(group, route, method, issued.token))).status, "revoked " + group + "/" + route).toBe(401);
    }
  });
  it.each(["read-only", "customer"] as const)("prevents %s from every write or administration endpoint", async role => {
    const issued = member(role);
    for (const [group, route, method] of endpoints) {
      if (method === "GET" && ["snapshot", "report", "changes"].includes(route)) continue;
      expect((await dispatch(group, route, request(group, route, method, issued.token))).status, group + "/" + route).toBe(403);
    }
  });
  it("allows operator business commands but forbids imports, invitations, replica uploads and connection administration", async () => {
    const issued = member("operator");
    const response = await handleOperationsApi(request("operations", "commands", "POST", issued.token, { id: "operator-customer", type: "customer.save", payload: { name: "Allowed" } }), "commands", context);
    expect(response.status).toBe(200);
    for (const [group, route, method] of endpoints) {
      if (route === "access" || route.startsWith("access/") || ["import", "connect", "bootstrap", "outbox/cancel", "conflicts/test/resolve"].includes(route)) {
        expect((await dispatch(group, route, request(group, route, method, issued.token))).status).toBe(403);
      }
    }
    const replica = { deviceId: "test-device", replica: { id: "illegal", records: [] } };
    expect((await handleSyncApi(request("sync", "push", "POST", issued.token, replica), "push", context)).status).toBe(403);
  });
  it("isolates customers in snapshots, change logs and reports, and rejects another customer filter", async () => {
    const token = member("customer").token;
    for (const [group, route] of [["operations", "snapshot"], ["sync", "changes"]]) {
      const response = await dispatch(group, route, request(group, route, "GET", token)); expect(response.status).toBe(200);
      const text = await response.text(); expect(text).toContain("Customer Alice"); expect(text).not.toContain("Customer Bob"); expect(text).not.toContain("Private subscription inventory"); expect(text).not.toContain("private financial note"); expect(text).not.toContain("private customer note");
    }
    const own = await handleOperationsApi(request("operations", "report", "GET", token), "report", context); expect(own.status).toBe(200);
    const other = await handleOperationsApi(request("operations", "report?customerId=customer:b", "GET", token), "report", context); expect(other.status).toBe(403);
    const unknown = await handleOperationsApi(request("operations", "report?subscriptionId=other", "GET", token), "report", context); expect(unknown.status).toBe(403);
  });
  it("rejects forged owner writes, oversized imports, and secret-bearing commands without leaking driver exceptions", async () => {
    const forged = request("operations", "commands", "POST", undefined, {}, { cookie, origin: "https://evil.example" });
    expect((await handleOperationsApi(forged, "commands", context)).status).toBe(403);
    const secret = request("operations", "commands", "POST", undefined, { id: "secret", type: "customer.save", payload: { name: "A", smtpUrl: "smtp://user:pass@smtp.example.com" } }, { cookie, origin: "http://127.0.0.1" });
    expect((await handleOperationsApi(secret, "commands", context)).status).toBe(400);
    const large = request("operations", "import", "POST", member("admin").token, { padding: "x".repeat(5 * 1024 * 1024 + 1) });
    expect((await handleOperationsApi(large, "import", context)).status).toBe(413);
    vi.spyOn(context.store, "snapshot").mockImplementation(() => { throw new Error("SQL failure with synthetic-secret password"); });
    const error = await handleOperationsApi(request("operations", "snapshot", "GET", member("admin").token), "snapshot", context);
    expect(error.status).toBe(503); const text = await error.text(); expect(text).not.toContain("SQL"); expect(text).not.toContain("synthetic-secret");
  });
  it("never treats member tokens as authentication for legacy pages", async () => {
    const token = member("admin").token;
    const result = await middleware(new NextRequest("http://127.0.0.1/spaces", { headers: { authorization: "Bearer " + token } }));
    expect(new URL(result.headers.get("location")!).pathname).toBe("/login");
  });
  it("issues tokens once and provides only credential metadata afterwards", async () => {
    const admin = member("admin").token;
    const created = await handleOperationsApi(request("operations", "access", "POST", admin, { label: "Customer portal", role: "customer", customerId: "customer:a" }), "access", context);
    expect(created.status).toBe(201); const body = await created.json(); expect(body.token).toMatch(/^sbm_/);
    const listed = await handleOperationsApi(request("operations", "access", "GET", admin), "access", context);
    expect(await listed.text()).not.toContain(body.token);
    expect(created.headers.get("cache-control")).toContain("no-store");
  });
  it("explicit member verification clears an ambient owner cookie, without clearing it on invalid or anonymous requests", async () => {
    const token = member("read-only").token;
    const verified = await handleOperationsApi(request("operations", "snapshot", "GET", token, undefined, { cookie }), "snapshot", context);
    expect(verified.status).toBe(200); expect((await verified.json()).actor.role).toBe("read-only");
    expect(verified.headers.get("set-cookie")).toContain("tam_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax");
    const invalid = await handleOperationsApi(request("operations", "snapshot", "GET", "invalid", undefined, { cookie }), "snapshot", context);
    expect(invalid.status).toBe(401); expect(invalid.headers.get("set-cookie")).toBeNull();
    const anonymous = await handleOperationsApi(request("operations", "snapshot"), "snapshot", context);
    expect(anonymous.status).toBe(401); expect(anonymous.headers.get("set-cookie")).toBeNull();
    const ownerRequest = await handleOperationsApi(request("operations", "snapshot", "GET", undefined, undefined, { cookie }), "snapshot", context);
    expect(ownerRequest.status).toBe(200); expect(ownerRequest.headers.get("set-cookie")).toBeNull();
    const legacy = await middleware(new NextRequest("http://127.0.0.1/spaces", { headers: { authorization: "Bearer " + token } }));
    expect(new URL(legacy.headers.get("location")!).pathname).toBe("/login");
  });
});
