/* eslint-disable @typescript-eslint/no-require-imports */
// Real HTTP acceptance against two separately initialized, synthetic ledgers.
// Requires the prepared desktop runtime; never opens an existing user profile.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const {
  backendEnvironment, createConfig, createLocalOwnerSession, findFreePort,
  launchBackend, runInitializer, runtimePaths, stopBackendAndCloseConnections,
} = require("../desktop/runtime.js");

const root = path.resolve(__dirname, "..");
const artifacts = path.join(root, "test-artifacts");
fs.mkdirSync(artifacts, { recursive: true });
if (fs.lstatSync(artifacts).isSymbolicLink()) throw new Error("Synthetic artifact directory cannot be a link.");
const directory = fs.mkdtempSync(path.join(artifacts, "sync-smoke-"));
const runtime = runtimePaths(path.join(root, "desktop/runtime"));
const children = new Set();
const secrets = new Set();
let requests = 0;

function inspect(peer, query, ...parameters) {
  const db = new Database(peer.database, { readonly: true, fileMustExist: true });
  try { return db.prepare(query).all(...parameters); }
  finally { db.close(); }
}
async function start(peer) {
  peer.child = await launchBackend(runtime, peer.environment, (name, chunk) => {
    fs.appendFileSync(path.join(directory, peer.name + "-" + name), chunk);
  }, { onSpawn: child => children.add(child) });
}
async function stop(peer) {
  await stopBackendAndCloseConnections(peer.child, child => child.kill(), async () => {});
  peer.child = undefined;
}
async function peer(name) {
  const userData = path.join(directory, name);
  fs.mkdirSync(userData);
  const config = createConfig(userData, "Synthetic-sync-acceptance-" + name);
  secrets.add(config.authSecret);
  const port = await findFreePort();
  const environment = backendEnvironment(config, userData, port);
  await runInitializer(runtime, environment);
  const database = path.join(userData, "data/app.db");
  const db = new Database(database);
  try {
    assert.equal(db.prepare("SELECT key FROM app_setting WHERE (key LIKE '%.emailReminder.enabled' AND value='true') OR (key LIKE '%.emailReminder.smtpUrl' AND value<>'')").all().length, 0,
      "Synthetic ledger must not enable email reminders or contain SMTP settings");
    const now = new Date(), at = now.toISOString();
    const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(now);
    const quote = db.prepare("INSERT INTO fx_rate(currency_code,rate_to_usd,quote_date,source,fetched_at) VALUES(?,?,?,?,?) ON CONFLICT(currency_code) DO UPDATE SET rate_to_usd=excluded.rate_to_usd,quote_date=excluded.quote_date,source=excluded.source,fetched_at=excluded.fetched_at");
    quote.run("USD", "1", date, "synthetic-sync", at);
    quote.run("CNY", "0.14", date, "synthetic-sync", at);
  } finally { db.close(); }
  const value = { name, userData, database, environment, base: "http://127.0.0.1:" + port,
    cookie: "tam_session=" + createLocalOwnerSession(config.authSecret).value, child: undefined };
  secrets.add(value.cookie);
  await start(value);
  return value;
}
async function api(peer, route, body, options = {}) {
  requests += 1;
  const response = await fetch(peer.base + route, {
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(options.public ? {} : options.token ? { Authorization: "Bearer " + options.token } : { Cookie: peer.cookie }),
      Origin: peer.base, Connection: "close", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(30000),
  });
  const value = await response.json();
  assert.equal(response.status, options.status ?? 200,
    JSON.stringify({ peer: peer.name, route, status: response.status, error: value.error }));
  return value;
}
const command = (peer, type, payload, id = crypto.randomUUID(), options) => api(peer, "/api/operations/commands", { id, type, payload }, options);
const snapshot = async (peer, options) => (await api(peer, "/api/operations/snapshot", undefined, options)).snapshot;
async function invite(peer, role, label, customerId) {
  const issued = await api(peer, "/api/operations/access", { label, role, ...(customerId ? { customerId } : {}), expiresInDays: 1 }, { status: 201 });
  secrets.add(issued.token);
  return issued;
}
function record(snapshot, kind, id) {
  const value = snapshot[kind].find(row => row.id === id);
  assert.ok(value, "Missing synthetic " + kind + " record " + id);
  return value;
}
// Replication preserves identity, revision and data; each device timestamps
// its own local write rather than copying the other device's updatedAt.
const comparable = row => ({ id: row.id, kind: row.kind, revision: row.revision, data: row.data });

async function main() {
  try {
    const center = await peer("center"), client = await peer("client");
    await api(center, "/api/operations/snapshot", undefined, { public: true, status: 401 });
    const device = await invite(center, "admin", "Synthetic client device");
    await command(client, "customer.save", { id: "customer:sync-a", name: "Synthetic customer A", contact: "synthetic-contact-a", tags: ["synthetic-private"], note: "Synthetic private staff note" });
    await command(client, "customer.save", { id: "customer:sync-b", name: "Synthetic customer B", contact: "synthetic-contact-b" });
    let result = await command(client, "subscription.save", { id: "subscription:sync", name: "Synthetic sync service", service: "Example Service", currency: "USD", amountMinor: 1000, startDate: "2026-10-01", period: { unit: "month", count: 1 }, capacity: 2 });
    const slots = result.snapshot.slots.filter(row => row.data.subscriptionId === "subscription:sync");
    assert.equal(slots.length, 2);
    result = await command(client, "rental.join", { slotId: slots[0].id, customerId: "customer:sync-a", usage: "rented", startDate: "2026-10-01", currency: "USD", amountMinor: 5000, period: { unit: "month", count: 1 } });
    const bill = result.snapshot.bills.find(row => row.data.customerId === "customer:sync-a");
    assert.ok(bill);
    await command(client, "rental.join", { slotId: slots[1].id, customerId: "customer:sync-b", usage: "rented", startDate: "2026-10-01", currency: "USD", amountMinor: 6000, period: { unit: "month", count: 1 } });

    await api(client, "/api/sync/connect", { url: center.base, token: device.token }, { status: 400 });
    assert.equal((await api(client, "/api/sync/status")).configured, false);
    const connected = await api(client, "/api/sync/connect", { url: center.base, token: device.token, allowLoopback: true });
    assert.equal(connected.connected, true);
    assert.equal(connected.remoteRole, "admin");
    const deviceId = connected.deviceId;
    assert.equal((await snapshot(center)).customers.length, 0, "Connect uploaded data without explicit bootstrap");
    await api(client, "/api/sync/bootstrap", { direction: "upload" });
    const uploaded = await snapshot(center);
    assert.equal(uploaded.customers.length, 2);
    assert.equal(uploaded.rentals.length, 2);
    assert.equal(record(uploaded, "bills", bill.id).data.amountMinor, 5000);
    assert.deepEqual(comparable(record(uploaded, "customers", "customer:sync-a")), comparable(record(await snapshot(client), "customers", "customer:sync-a")));
    await command(center, "customer.save", { id: "customer:center-only", name: "Synthetic center-only customer" });
    assert.equal((await snapshot(client)).customers.length, 2);
    await api(client, "/api/sync/bootstrap", { direction: "download" });
    assert.equal(record(await snapshot(client), "customers", "customer:center-only").data.name, "Synthetic center-only customer");

    // A real center outage must persist intent without confirming a payment.
    await stop(center);
    const receiptCommand = { id: "sync-smoke-receipt-once", type: "entry.receive", payload: { billId: bill.id, currency: "USD", amountMinor: 2000, date: "2026-10-13", note: "Synthetic offline receipt" } };
    const before = await snapshot(client);
    const queued = await api(client, "/api/operations/commands", receiptCommand);
    assert.equal(queued.queued, true);
    assert.equal(queued.status.pending, 1);
    assert.deepEqual(queued.changedIds, []);
    assert.deepEqual(queued.snapshot.entries, before.entries, "Offline client confirmed an unaccepted receipt");
    assert.deepEqual(queued.snapshot.bills, before.bills);
    const outbox = inspect(client, "SELECT command_json,state FROM ops_sync_outbox WHERE command_id=?", receiptCommand.id);
    assert.equal(outbox.length, 1); assert.equal(outbox[0].state, "queued");
    assert.deepEqual(JSON.parse(outbox[0].command_json), receiptCommand);
    assert.equal(inspect(client, "SELECT id FROM ops_command WHERE id=?", receiptCommand.id).length, 0);
    await stop(client); await start(client);
    const durable = await api(client, "/api/sync/status");
    assert.equal(durable.deviceId, deviceId); assert.equal(durable.connected, true); assert.equal(durable.pending, 1);
    assert.deepEqual((await snapshot(client)).entries, before.entries);
    await start(center);
    assert.equal((await snapshot(center)).entries.length, before.entries.length);
    const flushed = await api(client, "/api/sync/flush", {});
    assert.equal(flushed.status.pending, 0);
    const after = await snapshot(center);
    const receipts = after.entries.filter(row => row.data.type === "receipt" && row.data.billId === bill.id);
    assert.equal(receipts.length, 1); assert.equal(receipts[0].data.amountMinor, 2000);
    assert.deepEqual((await snapshot(client)).entries.map(comparable), after.entries.map(comparable));
    assert.equal(inspect(client, "SELECT state FROM ops_sync_outbox WHERE command_id=?", receiptCommand.id)[0].state, "sent");
    assert.equal(inspect(center, "SELECT id FROM ops_command WHERE id=?", receiptCommand.id).length, 1);
    const replay = await api(center, "/api/sync/push", { deviceId, commands: [receiptCommand] }, { token: device.token });
    assert.equal(replay.acknowledgements[0].ok, true); assert.equal(replay.acknowledgements[0].replayed, true);
    const retried = await api(client, "/api/operations/commands", receiptCommand);
    assert.equal(retried.queued, false);
    assert.equal((await snapshot(center)).entries.filter(row => row.data.billId === bill.id).length, 1);
    assert.equal(inspect(center, "SELECT command_id FROM ops_audit WHERE command_id=?", receiptCommand.id).length, 1);

    // A stale local intent creates a visible conflict until an explicit choice.
    const customer = record(await snapshot(client), "customers", "customer:sync-a");
    await command(center, "customer.save", { id: customer.id, expectedRevision: customer.revision, name: "Synthetic center revision" });
    const conflictCommand = { id: "sync-smoke-stale-customer", type: "customer.save", payload: { id: customer.id, expectedRevision: customer.revision, name: "Synthetic rejected local revision" } };
    const rejected = await api(client, "/api/operations/commands", conflictCommand, { status: 409 });
    assert.equal(rejected.error.code, "CONFLICT");
    const conflicts = (await api(client, "/api/sync/conflicts")).conflicts;
    const conflict = conflicts.find(row => row.commandId === conflictCommand.id);
    assert.ok(conflict); assert.ok(conflict.reason);
    assert.equal(inspect(client, "SELECT state FROM ops_sync_outbox WHERE command_id=?", conflictCommand.id)[0].state, "conflict");
    assert.equal(record(await snapshot(center), "customers", customer.id).data.name, "Synthetic center revision");
    await api(client, "/api/sync/conflicts/" + conflict.id + "/resolve", { choice: "remote" });
    assert.equal((await api(client, "/api/sync/conflicts")).conflicts.length, 0);
    assert.equal(record(await snapshot(client), "customers", customer.id).data.name, "Synthetic center revision");
    assert.equal(inspect(client, "SELECT state FROM ops_sync_outbox WHERE command_id=?", conflictCommand.id)[0].state, "resolved");
    assert.ok(inspect(client, "SELECT action FROM ops_security_audit WHERE resource_id=? AND action='sync.resolve.remote'", conflict.id).length);

    // Read-only center grants remain read-only even behind a local owner cookie.
    const reader = await invite(center, "read-only", "Synthetic read-only device");
    const readSnapshot = await snapshot(center, { token: reader.token });
    assert.equal(readSnapshot.customers.length, 3);
    await command(center, "customer.save", { name: "Synthetic forbidden reader write" }, undefined, { token: reader.token, status: 403 });
    await api(center, "/api/sync/push", { deviceId, commands: [] }, { token: reader.token, status: 403 });
    const readonly = await api(client, "/api/sync/connect", { url: center.base, token: reader.token, allowLoopback: true });
    assert.equal(readonly.remoteRole, "read-only");
    await api(client, "/api/sync/bootstrap", { direction: "download" });
    await command(client, "customer.save", { name: "Synthetic forbidden relayed write" }, undefined, { status: 403 });
    assert.equal((await api(client, "/api/sync/status")).pending, 0);
    await api(center, "/api/operations/access/" + reader.credential.id, undefined, { method: "DELETE" });
    await snapshot(center, { token: reader.token, status: 401 });
    await api(client, "/api/sync/pull", {}, { status: 403 });
    await api(client, "/api/sync/connect", { url: center.base, token: device.token, allowLoopback: true });

    const customerAccess = await invite(center, "customer", "Synthetic customer portal", customer.id);
    const scoped = await snapshot(center, { token: customerAccess.token });
    assert.deepEqual(scoped.customers.map(row => row.id), [customer.id]);
    assert.equal(scoped.subscriptions.length, 0); assert.equal(scoped.slots.length, 0);
    assert.equal(scoped.rentals.length, 0); assert.equal(scoped.channels.length, 0);
    assert.ok(scoped.bills.length); assert.ok(scoped.entries.length);
    assert.ok(scoped.bills.every(row => row.data.customerId === customer.id));
    assert.ok(scoped.entries.every(row => row.data.customerId === customer.id));
    assert.equal(scoped.customers[0].data.note, ""); assert.deepEqual(scoped.customers[0].data.tags, []);
    const scopedChanges = await api(center, "/api/sync/changes?cursor=0", undefined, { token: customerAccess.token });
    assert.deepEqual(scopedChanges.snapshot.customers.map(row => row.id), [customer.id]);
    assert.ok(scopedChanges.changes.every(row => row.record.kind === "customer" ? row.record.id === customer.id : row.record.data.customerId === customer.id));
    await command(center, "customer.save", { name: "Synthetic forbidden customer write" }, undefined, { token: customerAccess.token, status: 403 });
    await api(center, "/api/sync/push", { deviceId, commands: [] }, { token: customerAccess.token, status: 403 });
    await api(center, "/api/operations/report?customerId=customer:sync-b", undefined, { token: customerAccess.token, status: 403 });
    await api(client, "/api/sync/connect", { url: center.base, token: customerAccess.token, allowLoopback: true }, { status: 403 });
    assert.equal((await api(client, "/api/sync/status")).remoteRole, "admin");
    await api(center, "/api/operations/access/" + customerAccess.credential.id, undefined, { method: "DELETE" });
    await snapshot(center, { token: customerAccess.token, status: 401 });
    await api(center, "/api/sync/changes?cursor=0", undefined, { token: customerAccess.token, status: 401 });

    console.log(JSON.stringify({ syncSmoke: "passed", requests, independentLedgers: true, explicitBootstrapBothDirections: true,
      offlineSqliteOutbox: true, clientRestartPreservesQueue: true, noUnconfirmedReceipt: true, centerRestartFlushesOnce: true,
      commandRetryIdempotent: true, explicitConflictResolution: true, readonlyDeviceEnforcedAndRevoked: true,
      customerIsolationAndRevocation: true, artifactDirectory: path.relative(root, directory) }));
  } finally {
    // Only ChildProcess instances created by this script are ever terminated.
    await Promise.all([...children].map(child => stopBackendAndCloseConnections(child, owned => owned.kill(), async () => {})));
  }
}
main().catch(error => {
  let message = String(error.message);
  for (const secret of secrets) message = message.replaceAll(secret, "[redacted]");
  console.error(message); process.exitCode = 1;
});
