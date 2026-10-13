import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken } from "@/lib/auth";
import { assertNoSecrets, assertOperationsAccess, authenticateOperationsRequest, boundedJson, filterOperationsSnapshot, OperationsAccessStore } from "./access";
import type { OperationsSnapshot, OpsActor, OpsRecord } from "./types";

const admin: OpsActor = { id: "local-admin", role: "admin" };
const empty = (): OperationsSnapshot => ({ version: 1, changeSeq: 0, channels: [], customers: [], templates: [], plans: [], subscriptions: [], slots: [], rentals: [], bills: [], entries: [] });
function record(id: string, kind: OpsRecord["kind"], data: Record<string, unknown>) { return { id, kind, data, revision: 1, updatedAt: "2026-10-13T00:00:00Z" } as OpsRecord; }
describe("operations credentials and customer isolation", () => {
  let sqlite: Database.Database, access: OperationsAccessStore;
  beforeEach(() => { sqlite = new Database(":memory:"); access = new OperationsAccessStore(sqlite); vi.stubEnv("APP_AUTH_SECRET", "test-only-signing-key"); });
  afterEach(() => { sqlite.close(); vi.unstubAllEnvs(); vi.useRealTimers(); });
  it("stores only token hashes, revokes immediately, and keeps raw tokens out of audits", () => {
    const issued = access.invite(admin, { label: "Operator", role: "operator" });
    const row = sqlite.prepare("SELECT * FROM ops_access").get();
    expect(JSON.stringify(row)).not.toContain(issued.token);
    expect(access.authenticateToken(issued.token)).toEqual({ id: issued.credential.id, role: "operator", customerId: undefined });
    access.revoke(admin, issued.credential.id);
    expect(access.authenticateToken(issued.token)).toBeNull();
    expect(JSON.stringify(access.securityAudit(admin))).not.toContain(issued.token);
    expect(access.securityAudit(admin)).toHaveLength(2);
  });
  it("expires credentials and never lets an invalid member bearer fall back to the owner cookie", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-13T00:00:00Z"));
    const issued = access.invite(admin, { label: "Viewer", role: "read-only", expiresInDays: 1 });
    vi.setSystemTime(new Date("2026-10-14T00:00:01Z"));
    expect(access.authenticateToken(issued.token)).toBeNull();
    const cookie = "tam_session=" + await createSessionToken();
    const request = new Request("http://localhost/api/operations/snapshot", { headers: { cookie, authorization: "Bearer invalid" } });
    await expect(authenticateOperationsRequest(request, access)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("requires same-origin writes for cookie owners and preserves the bearer role", async () => {
    const cookie = "tam_session=" + await createSessionToken();
    const request = (origin?: string) => new Request("http://localhost/api/operations/commands", { method: "POST", headers: { cookie, ...(origin ? { origin } : {}) } });
    await expect(authenticateOperationsRequest(request("http://localhost"), access)).resolves.toEqual(admin);
    await expect(authenticateOperationsRequest(request(), access)).rejects.toMatchObject({ code: "CSRF" });
    await expect(authenticateOperationsRequest(request("https://evil.example"), access)).rejects.toMatchObject({ code: "CSRF" });
    const issued = access.invite(admin, { label: "Reader", role: "read-only" });
    const reader = await authenticateOperationsRequest(new Request("http://localhost/api/operations/commands", { method: "POST", headers: { cookie, authorization: "Bearer " + issued.token } }), access);
    expect(reader.role).toBe("read-only");
    expect(() => assertOperationsAccess(reader, { id: "command", type: "customer.save", payload: {} })).toThrow();
  });
  it("uses the validated incoming Host when Next canonicalizes a loopback request URL", async () => {
    const cookie = "tam_session=" + await createSessionToken();
    const request = (host: string, origin: string | null, url = "http://localhost:8777/api/operations/commands") => new Request(url, { method: "POST", headers: { cookie, host, ...(origin === null ? {} : { origin }) } });
    await expect(authenticateOperationsRequest(request("127.0.0.1:8777", "http://127.0.0.1:8777"), access)).resolves.toEqual(admin);
    await expect(authenticateOperationsRequest(request("localhost:8777", "http://localhost:8777", "http://0.0.0.0:8777/api/operations/commands"), access)).resolves.toEqual(admin);
    await expect(authenticateOperationsRequest(request("[::1]:8777", "http://[::1]:8777"), access)).resolves.toEqual(admin);
    for (const origin of ["https://evil.example", "http://localhost:8777", "http://127.0.0.1:8778", "null", null]) await expect(authenticateOperationsRequest(request("127.0.0.1:8777", origin), access)).rejects.toMatchObject({ code: "CSRF" });
    for (const host of ["127.0.0.1:8777,evil.example", "user@127.0.0.1:8777", "127.0.0.1:8777/path", "127.0.0.1:65536"]) await expect(authenticateOperationsRequest(request(host, "http://127.0.0.1:8777"), access)).rejects.toMatchObject({ code: "CSRF" });
  });
  it("enforces configured HTTPS and exact owned desktop origins without broadening to other hosts or ports", async () => {
    const cookie = "tam_session=" + await createSessionToken();
    const request = (origin: string) => new Request("http://localhost:8777/api/operations/commands", { method: "POST", headers: { cookie, host: "127.0.0.1:8777", origin } });
    vi.stubEnv("OPS_PUBLIC_ORIGIN", "https://ledger.example.com");
    await expect(authenticateOperationsRequest(request("https://ledger.example.com"), access)).resolves.toEqual(admin);
    await expect(authenticateOperationsRequest(request("http://127.0.0.1:8777"), access)).rejects.toMatchObject({ code: "CSRF" });
    await expect(authenticateOperationsRequest(request("https://ledger.example.com.evil.example"), access)).rejects.toMatchObject({ code: "CSRF" });
    vi.stubEnv("OPS_PUBLIC_ORIGIN", ""); vi.stubEnv("APP_ALLOW_INSECURE_COOKIES", "true"); vi.stubEnv("OPS_DESKTOP_ORIGIN", "http://127.0.0.1:8777");
    await expect(authenticateOperationsRequest(request("http://127.0.0.1:8777"), access)).resolves.toEqual(admin);
    await expect(authenticateOperationsRequest(request("http://localhost:8777"), access)).rejects.toMatchObject({ code: "CSRF" });
    await expect(authenticateOperationsRequest(request("http://127.0.0.1:8778"), access)).rejects.toMatchObject({ code: "CSRF" });
    vi.stubEnv("APP_ALLOW_INSECURE_COOKIES", "false"); vi.stubEnv("OPS_DESKTOP_ORIGIN", "http://evil.example");
    await expect(authenticateOperationsRequest(request("http://evil.example"), access)).rejects.toMatchObject({ code: "CSRF" });
  });
  it("customer output excludes inventory, other customers, costs and private notes", () => {
    const snapshot = empty();
    snapshot.customers = [record("a", "customer", { name: "A", note: "private", tags: ["internal"] }), record("b", "customer", { name: "B" })] as OperationsSnapshot["customers"];
    snapshot.bills = [record("bill-a", "bill", { customerId: "a", amountMinor: 8000, note: "internal" }), record("bill-b", "bill", { customerId: "b", amountMinor: 9000 })] as OperationsSnapshot["bills"];
    snapshot.entries = [record("receipt-a", "entry", { type: "receipt", customerId: "a", amountMinor: 8000 }), record("receipt-b", "entry", { type: "receipt", customerId: "b", amountMinor: 9000 }), record("cost-a", "entry", { type: "cost", customerId: "a", amountMinor: 1000 }), record("linked-a", "entry", { type: "refund", billId: "bill-a", amountMinor: 100 })] as OperationsSnapshot["entries"];
    snapshot.subscriptions = [record("sub", "subscription", { amountMinor: 1000 })] as OperationsSnapshot["subscriptions"];
    const result = filterOperationsSnapshot(snapshot, { id: "credential-a", role: "customer", customerId: "a" });
    expect(result.customers.map(item => item.id)).toEqual(["a"]);
    expect(result.bills.map(item => item.id)).toEqual(["bill-a"]);
    expect(result.entries.map(item => item.id)).toEqual(["receipt-a", "linked-a"]);
    expect(result.subscriptions).toEqual([]); expect(result.rentals).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private"); expect(JSON.stringify(result)).not.toContain("internal");
    expect(() => assertOperationsAccess({ id: "a", role: "customer", customerId: "a" }, { id: "write", type: "entry.receive", payload: {} })).toThrow();
  });
  it("administration is unavailable to operators and ledger secret fields are rejected", () => {
    const operator: OpsActor = { id: "operator", role: "operator" };
    expect(() => access.invite(operator, { label: "Escalate", role: "admin" })).toThrow();
    expect(() => access.revoke(operator, "id")).toThrow();
    expect(() => access.list(operator)).toThrow();
    expect(() => assertOperationsAccess(operator, { id: "import", type: "import.commit", payload: {} })).toThrow();
    expect(() => assertNoSecrets({ nested: { smtpUrl: "synthetic secret" } })).toThrow();
    expect(() => assertNoSecrets({ nested: { smtp_password: "synthetic secret" } })).toThrow();
    expect(() => assertNoSecrets({ note: "SMTP is smtp://user:pass@smtp.example.com" })).toThrow();
  });
  it("caps streamed body sizes even if the client omits content length", async () => {
    const request = new Request("http://localhost", { method: "POST", body: JSON.stringify({ large: "x".repeat(10000) }) });
    await expect(boundedJson(request, 100)).rejects.toMatchObject({ code: "TOO_LARGE" });
    await expect(boundedJson(new Request("http://localhost", { method: "POST", body: "not json" }))).rejects.toMatchObject({ code: "INVALID" });
  });
});
