import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestDb } from "@/test/db-harness";
import { seedCurrencies } from "@/db/seed";
import { createSessionToken } from "@/lib/auth";
import { insertChannel } from "@/db/channels";
import { insertSpaceWithMother } from "@/db/spaces";
import { accountReceipt, motherAccount } from "@/db/schema";
import { upsertRates } from "@/db/fxRates";
import { createOperationsContext, handleOperationsApi, handleSyncApi } from "./http";
import { validateHubUrl } from "./sync";
import type { OpsActor } from "./types";

const owner: OpsActor = { id: "local-admin", role: "admin" };
describe("two independent SQLite ledgers synchronize through authenticated HTTP", () => {
  const databases: ReturnType<typeof createTestDb>[] = [];
  const context = (transport?: typeof fetch) => {
    const database = createTestDb(); seedCurrencies(database.db); databases.push(database);
    return createOperationsContext(database.sqlite, transport);
  };
  beforeEach(() => { vi.stubEnv("APP_AUTH_SECRET", "test-only-sync-secret"); });
  afterEach(() => { for (const database of databases.splice(0)) database.sqlite.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });
  async function ownerRequest(route: string, body?: unknown) {
    return new Request("http://127.0.0.1/api/" + route, { method: body === undefined ? "GET" : "POST", headers: { cookie: "tam_session=" + await createSessionToken(), origin: "http://127.0.0.1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  it("persists stable device IDs, downloads actual records, and retries a lost acknowledgement exactly once", async () => {
    const hub = context(); let offline = false, loseAcknowledgement = false;
    const transport: typeof fetch = async (input, init) => {
      if (offline) throw new TypeError("simulated network offline");
      const request = new Request(input, init), route = new URL(request.url).pathname;
      const response = route.startsWith("/api/sync/") ? await handleSyncApi(request, route.slice(10), hub) : await handleOperationsApi(request, route.slice(16), hub);
      if (loseAcknowledgement && route === "/api/sync/push") { loseAcknowledgement = false; throw new TypeError("response lost after server commit"); }
      return response;
    };
    hub.store.execute({ id: "seed", type: "customer.save", payload: { id: "customer:a", name: "Alice" } }, owner);
    const token = hub.access.invite(owner, { label: "Client admin", role: "admin" }).token;
    const client = context(transport), deviceId = client.sync.deviceId();
    expect(createOperationsContext(client.sqlite, transport).sync.deviceId()).toBe(deviceId);
    await client.sync.connect(owner, { url: "http://127.0.0.1:8777", token, allowLoopback: true });
    expect(client.store.snapshot().customers).toHaveLength(0);
    await client.sync.pull(owner);
    expect(client.store.snapshot().customers[0]).toMatchObject({ id: "customer:a", revision: 1, data: { name: "Alice" } });
    const command = { id: randomUUID(), type: "customer.save", payload: { id: "customer:a", name: "Updated", expectedRevision: 1 } };
    offline = true;
    const queued = await handleOperationsApi(await ownerRequest("operations/commands", command), "commands", client);
    expect(queued.status).toBe(200); expect((await queued.json()).queued).toBe(true);
    expect(client.sync.status().pending).toBe(1); expect(client.store.snapshot().customers[0].data.name).toBe("Alice");
    offline = false; loseAcknowledgement = true;
    await expect(client.sync.flush(owner)).rejects.toThrow("response lost");
    expect(hub.store.snapshot().customers[0].revision).toBe(2);
    expect(client.sync.status().pending).toBe(1);
    await client.sync.flush(owner);
    expect(client.sync.status().pending).toBe(0);
    expect(hub.store.snapshot().customers[0].revision).toBe(2);
    expect(client.store.snapshot().customers[0]).toMatchObject({ revision: 2, data: { name: "Updated" } });
    expect(hub.store.audit().filter(item => item.commandId === command.id)).toHaveLength(1);
    expect(JSON.stringify(client.sqlite.prepare("SELECT * FROM ops_device").all())).not.toContain(token);
  });
  it.each(["local", "remote"] as const)("detects concurrent edits and audits explicit %s conflict choice", async choice => {
    const hub = context();
    const transport: typeof fetch = async (input, init) => {
      const request = new Request(input, init), route = new URL(request.url).pathname;
      return route.startsWith("/api/sync/") ? handleSyncApi(request, route.slice(10), hub) : handleOperationsApi(request, route.slice(16), hub);
    };
    hub.store.execute({ id: "seed", type: "customer.save", payload: { id: "customer:a", name: "Initial" } }, owner);
    const token = hub.access.invite(owner, { label: "Peer", role: "admin" }).token, client = context(transport);
    await client.sync.connect(owner, { url: "http://127.0.0.1:8777", token, allowLoopback: true }); await client.sync.pull(owner);
    client.store.execute({ id: "local-edit", type: "customer.save", payload: { id: "customer:a", name: "Local", expectedRevision: 1 } }, owner);
    hub.store.execute({ id: "remote-edit", type: "customer.save", payload: { id: "customer:a", name: "Remote", expectedRevision: 1 } }, owner);
    await client.sync.pull(owner);
    expect(client.store.snapshot().customers[0].data.name).toBe("Local");
    const conflict = client.sync.conflicts(owner)[0]; expect(conflict.recordId).toBe("customer:a");
    await client.sync.resolve(owner, conflict.id, choice);
    const expected = choice === "local" ? "Local" : "Remote";
    expect(client.store.snapshot().customers[0].data.name).toBe(expected); expect(hub.store.snapshot().customers[0].data.name).toBe(expected);
    expect(client.sync.conflicts(owner)).toHaveLength(0);
    expect(client.access.securityAudit(owner).some(row => (row as { action: string }).action === "sync.resolve." + choice)).toBe(true);
  });
  it("retries a receipt without double charging and preserves the hub's frozen FX instead of the client's newer rate", async () => {
    const hub = context(); let offline = false, dropResponse = false;
    const transport: typeof fetch = async (input, init) => {
      if (offline) throw new TypeError("offline");
      const request = new Request(input, init), route = new URL(request.url).pathname;
      const response = route.startsWith("/api/sync/") ? await handleSyncApi(request, route.slice(10), hub) : await handleOperationsApi(request, route.slice(16), hub);
      if (dropResponse && route === "/api/sync/push") { dropResponse = false; throw new TypeError("receipt acknowledgement lost"); }
      return response;
    };
    const client = context(transport);
    for (const [context, rateToUsd] of [[hub, "0.2"], [client, "0.5"]] as const) {
      const database = databases.find(database => database.sqlite === context.sqlite)!;
      upsertRates(database.db, [{ currencyCode: "CNY", rateToUsd, quoteDate: "2026-10-13", fetchedAt: "2026-10-13T00:00:00Z", source: "test" }]);
    }
    hub.store.execute({ id: "customer", type: "customer.save", payload: { id: "customer:a", name: "Alice" } }, owner);
    hub.store.execute({ id: "subscription", type: "subscription.save", payload: { id: "subscription:s", name: "Service", currency: "USD", amountMinor: 1000, period: { unit: "month", count: 1 }, startDate: "2026-10-01", endDate: "2026-11-01" } }, owner);
    hub.store.execute({ id: "invoice", type: "bill.issue", payload: { subscriptionId: "subscription:s", customerId: "customer:a", amountMinor: 2000, currency: "USD", startDate: "2026-10-01", endDate: "2026-11-01" } }, owner);
    const token = hub.access.invite(owner, { label: "Finance peer", role: "admin" }).token;
    await client.sync.connect(owner, { url: "http://127.0.0.1:8777", token, allowLoopback: true }); await client.sync.pull(owner);
    const command = { id: "receipt-once", type: "entry.receive", payload: { billId: "bill:invoice", amountMinor: 1000, currency: "USD", date: "2026-10-13" } };
    offline = true;
    const response = await handleOperationsApi(await ownerRequest("operations/commands", command), "commands", client);
    expect((await response.json()).queued).toBe(true); expect(client.store.snapshot().entries).toHaveLength(0);
    offline = false; dropResponse = true;
    await expect(client.sync.flush(owner)).rejects.toThrow("acknowledgement lost");
    expect(hub.store.snapshot().entries).toHaveLength(1);
    await client.sync.flush(owner);
    expect(hub.store.snapshot().entries).toHaveLength(1); expect(client.store.snapshot().entries).toHaveLength(1);
    expect(client.store.snapshot().entries[0].data).toMatchObject({ amountMinor: 1000, usdMinor: 1000, cnyMinor: 5000, fx: { cnyRateToUsd: "0.2" } });
    await client.sync.pull(owner); expect(client.store.snapshot().entries[0].data.cnyMinor).toBe(5000);
  });
  it("does not auto-upload on connect, requires explicit bootstrap, and refuses overwriting a populated hub", async () => {
    const hub = context();
    const transport: typeof fetch = (input, init) => {
      const request = new Request(input, init), route = new URL(request.url).pathname;
      return route.startsWith("/api/sync/") ? handleSyncApi(request, route.slice(10), hub) : handleOperationsApi(request, route.slice(16), hub);
    };
    const client = context(transport), token = hub.access.invite(owner, { label: "Peer", role: "admin" }).token;
    client.store.execute({ id: "seed", type: "customer.save", payload: { id: "customer:a", name: "Local" } }, owner);
    await client.sync.connect(owner, { url: "http://127.0.0.1:8777", token, allowLoopback: true });
    expect(hub.store.snapshot().customers).toHaveLength(0);
    await client.sync.bootstrap(owner, "upload"); expect(hub.store.snapshot().customers[0].data.name).toBe("Local");
    await expect(client.sync.bootstrap(owner, "upload")).rejects.toThrow();
  });
  it("replicates legacy projections to an empty device without copying SQLite or disabling their source records", async () => {
    const hub = context();
    const transport: typeof fetch = (input, init) => {
      const request = new Request(input, init), route = new URL(request.url).pathname;
      return route.startsWith("/api/sync/") ? handleSyncApi(request, route.slice(10), hub) : handleOperationsApi(request, route.slice(16), hub);
    };
    const client = context(transport), database = databases.find(database => database.sqlite === client.sqlite)!;
    const channel = insertChannel(database.db, "Source card").id;
    const id = insertSpaceWithMother(database.db, { name: "Legacy Business", planType: "team", sharingMode: "shared", country: "US", paymentChannelId: channel, currencyCode: "USD", amountMinor: 2000, amountUsd: 2000, openingDate: "2026-01-01", currentPeriodStartDate: "2026-01-01", periodUnit: "month", periodCount: 1, expiryDate: "2026-02-01" }, "owner@example.com").id;
    database.db.update(motherAccount).set({ usageStatus: "rented", contact: "Source customer", joinedDate: "2026-01-01", monthlyPaymentDay: 1, nextPaymentDate: "2026-02-01", expectedCurrencyCode: "USD", expectedAmountMinor: 8000, expectedAmountUsd: 8000, expectedRateUsed: "1", expectedRateAsOf: "2026-01-01", expectedRateSource: "identity" }).run();
    database.db.insert(accountReceipt).values({ spaceId: id, receivedDate: "2026-01-01", amountMinor: 8000, currencyCode: "USD", rateUsed: "1", rateAsOf: "2026-01-01", rateSource: "identity", amountUsd: 8000 }).run();
    const token = hub.access.invite(owner, { label: "Migration peer", role: "admin" }).token;
    await client.sync.connect(owner, { url: "http://127.0.0.1:8777", token, allowLoopback: true }); await client.sync.bootstrap(owner, "upload");
    for (let read = 0; read < 2; read++) {
      const snapshot = hub.store.snapshot();
      expect(snapshot.subscriptions[0].data.status).toBe("active"); expect(snapshot.rentals[0].data.status).toBe("active");
      expect(snapshot.customers[0].data.archived).toBe(false); expect(snapshot.entries[0].data.status).toBe("posted");
      expect(snapshot.subscriptions[0].data.legacy?.sources).toContain("space:" + id);
    }
    expect((hub.sqlite.prepare("SELECT count(*) AS n FROM space").get() as { n: number }).n).toBe(0);
  });
  it("blocks non-HTTPS targets, redirects and revoked queued member operations", async () => {
    for (const url of ["http://example.com", "file:///tmp", "https://user:password@example.com", "https://example.com/?secret=x"]) expect(() => validateHubUrl(url)).toThrow();
    expect(() => validateHubUrl("http://127.0.0.1:8777")).toThrow();
    expect(validateHubUrl("http://127.0.0.1:8777", true)).toBe("http://127.0.0.1:8777");
    const hub = context(); let pushes = 0;
    const transport: typeof fetch = (input, init) => {
      expect(init?.redirect).toBe("error"); const request = new Request(input, init), route = new URL(request.url).pathname;
      if (route === "/api/sync/push") pushes++;
      return route.startsWith("/api/sync/") ? handleSyncApi(request, route.slice(10), hub) : handleOperationsApi(request, route.slice(16), hub);
    };
    const client = context(transport), remoteToken = hub.access.invite(owner, { label: "Peer", role: "admin" }).token;
    await client.sync.connect(owner, { url: "http://127.0.0.1:8777", token: remoteToken, allowLoopback: true });
    const issued = client.access.invite(owner, { label: "Operator", role: "operator" });
    const actor: OpsActor = { id: issued.credential.id, role: "operator" };
    client.sync.enqueue(actor, { id: "queued", type: "customer.save", payload: { name: "Cancelled" } }); client.access.revoke(owner, actor.id);
    await client.sync.flush(owner); expect(pushes).toBe(0); expect(client.sync.status().pending).toBe(0); expect(hub.store.snapshot().customers).toHaveLength(0);
  });
  it("automatically retries server-side with backoff even without a browser online event", async () => {
    const hub = context(); let offline = false, attempts = 0;
    const transport: typeof fetch = (input, init) => {
      attempts++; if (offline) return Promise.reject(new TypeError("offline"));
      const request = new Request(input, init), route = new URL(request.url).pathname;
      return route.startsWith("/api/sync/") ? handleSyncApi(request, route.slice(10), hub) : handleOperationsApi(request, route.slice(16), hub);
    };
    const client = context(transport), token = hub.access.invite(owner, { label: "Automatic", role: "admin" }).token;
    await client.sync.connect(owner, { url: "http://127.0.0.1:8777", token, allowLoopback: true });
    client.sync.enqueue(owner, { id: "automatic-command", type: "customer.save", payload: { name: "Auto recovered" } });
    vi.useFakeTimers(); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("NEXT_PHASE", "");
    offline = true; attempts = 0; client.sync.start(); client.sync.start();
    try {
      await vi.advanceTimersByTimeAsync(60000); expect(attempts).toBe(1); expect(client.sync.status().lastError).toBeTruthy();
      await vi.advanceTimersByTimeAsync(119999); expect(attempts).toBe(1);
      offline = false; await vi.advanceTimersByTimeAsync(1);
      expect(client.sync.status().pending).toBe(0); expect(client.store.snapshot().customers[0].data.name).toBe("Auto recovered");
      expect(client.sync.status().lastError).toBeUndefined();
    } finally { client.sync.stop(); }
  });
  it("can reauthorize after a local key rotation without silently reverting to standalone writes", async () => {
    const hub = context();
    const transport: typeof fetch = (input, init) => {
      const request = new Request(input, init), route = new URL(request.url).pathname;
      return route.startsWith("/api/sync/") ? handleSyncApi(request, route.slice(10), hub) : handleOperationsApi(request, route.slice(16), hub);
    };
    const client = context(transport), token = hub.access.invite(owner, { label: "Rotated peer", role: "admin" }).token;
    await client.sync.connect(owner, { url: "http://127.0.0.1:8777", token, allowLoopback: true });
    vi.stubEnv("APP_AUTH_SECRET", "test-only-rotated-local-key");
    expect(client.sync.status()).toMatchObject({ connected: false, configured: true, requiresReconnect: true });
    const command = { id: "must-not-fallback", type: "customer.save", payload: { name: "Unconfirmed" } };
    const blocked = await handleOperationsApi(await ownerRequest("operations/commands", command), "commands", client);
    expect(blocked.status).toBe(400); expect(client.store.snapshot().customers).toHaveLength(0);
    await client.sync.connect(owner, { url: "http://127.0.0.1:8777", token, allowLoopback: true });
    expect(client.sync.status()).toMatchObject({ connected: true, requiresReconnect: false });
  });
});
