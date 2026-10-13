/* eslint-disable @typescript-eslint/no-require-imports -- Actual SQLite maintenance integration tests intentionally use CommonJS. */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const Database = require("better-sqlite3");
const { initialize, inspectDatabase, onlineBackup, reminders } = require("../../scripts/initialize.cjs");
const { BackupManager, FILES, compareVersions, openBackup, sealBackup } = require("../backups.js");
const { createConfig, loadConfig } = require("../runtime.js");
const { ReminderManager } = require("../reminders.js");
const { readQueue, saveQueue } = require("../offline-queue.js");
const root = path.resolve(__dirname, "../..");
const artifacts = path.join(root, "test-artifacts");
const migrations = path.join(root, "drizzle");
const wrappingKey = crypto.createHash("sha256").update("synthetic-key-wrapping-fixture").digest();
function protectKey(value) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", wrappingKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}
function unprotectKey(bytes) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", wrappingKey, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
}
function mfaValue(secret) {
  const key = crypto.createHash("sha256").update("team-account-manager:mfa:v1").update("\0").update(secret).digest();
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update("JBSWY3DPEHPK3PXP"), cipher.final()]);
  return ["v1", iv.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}
function workspace(t) {
  fs.mkdirSync(artifacts, { recursive: true });
  const directory = fs.mkdtempSync(path.join(artifacts, "desktop-maintenance-"));
  t.after(() => { assert.ok(path.resolve(directory).startsWith(`${artifacts}${path.sep}`)); fs.rmSync(directory, { recursive: true, force: true }); });
  return directory;
}
function fixture(t) {
  const directory = workspace(t), userData = path.join(directory, "user-data");
  const config = createConfig(userData, "synthetic-login-key");
  const seed = path.join(directory, "seed.json");
  fs.writeFileSync(seed, JSON.stringify([
    { code: "USD", name: "USD fixture", symbol: "$", countryCode: "US", countryName: "Fixture", minorUnit: 2 },
    { code: "CNY", name: "CNY fixture", symbol: "¥", countryCode: "CN", countryName: "Fixture", minorUnit: 2 },
  ]));
  const database = path.join(userData, "data/app.db"); initialize(database, migrations, seed);
  const sqlite = new Database(database); sqlite.pragma("foreign_keys = ON"); sqlite.pragma("journal_mode=WAL");
  sqlite.prepare("INSERT INTO payment_channel(id,name) VALUES(1,'Fixture card')").run();
  sqlite.prepare("INSERT INTO space(id,name,country,payment_channel_id,currency_code,amount_minor,amount_usd,expiry_date) VALUES(1,'Fixture subscription','US',1,'USD',5000,5000,'2026-10-15')").run();
  sqlite.prepare("INSERT INTO mother_account(space_id,email,usage_status,expected_amount_minor,expected_currency_code,expected_amount_usd,next_payment_date) VALUES(1,'mother@example.org','rented',1500,'USD',1500,'2026-10-13')").run();
  sqlite.prepare("INSERT INTO child_account(space_id,email,joined_date,monthly_amount_minor,monthly_currency_code,monthly_rate_used,monthly_rate_as_of,monthly_rate_source,monthly_amount_usd,monthly_payment_day,next_payment_date,usage_status) VALUES(1,'member@example.org','2026-10-01',2000,'USD','1','2026-10-01','fixture',2000,12,'2026-10-12','rented')").run();
  sqlite.prepare("INSERT INTO app_setting(key,value) VALUES(?,?)").run("auth.mfa.enabled", "true");
  sqlite.prepare("INSERT INTO app_setting(key,value) VALUES(?,?)").run("auth.mfa.secret", mfaValue(config.authSecret));
  sqlite.prepare("INSERT INTO app_setting(key,value) VALUES(?,?)").run("space.emailReminder.smtpUrl", "smtp://fixture-user:fixture-password@mail.example.org");
  sqlite.close();
  fs.writeFileSync(path.join(userData, "credentials.bin"), Buffer.from("synthetic-dpapi-encrypted-credential"));
  fs.writeFileSync(path.join(userData, "desktop-preferences.json"), JSON.stringify({ closeToTray: true, notifications: true }));
  const manager = new BackupManager({ userData, appVersion: "1.1.0", protectKey, unprotectKey,
    backupDb: onlineBackup, inspectDb: (file, secret) => inspectDatabase(file, migrations, secret),
    upgradeDb: file => initialize(file, migrations, seed) });
  return { directory, userData, config, database, seed, manager };
}
function amount(database) {
  const sqlite = new Database(database, { readonly: true });
  try { return sqlite.prepare("SELECT amount_minor FROM space WHERE id=1").get().amount_minor; } finally { sqlite.close(); }
}
test("online backup includes WAL commits and preserves encrypted security in an authenticated package", async t => {
  const data = fixture(t), file = path.join(data.directory, "snapshot.sbbackup");
  const connection = new Database(data.database); connection.pragma("journal_mode=WAL");
  connection.prepare("UPDATE space SET amount_minor=6123 WHERE id=1").run();
  try { await data.manager.create(file); } finally { connection.close(); }
  const text = fs.readFileSync(file, "utf8");
  assert.equal(text.includes(data.config.authSecret), false); assert.equal(text.includes("fixture-password"), false);
  const { payload, entries } = data.manager.read(file);
  assert.equal(payload.database.summary.money.subscriptions[0].amount_minor, "6123");
  assert.equal(payload.database.summary.mfaEnabled, true);
  assert.ok(entries.has("credentials.bin")); assert.ok(entries.has("config.json"));
  assert.throws(() => inspectDatabase(data.database, migrations, "wrong-secret"), /MFA encryption/u);
});
test("restore validates first, preserves login and MFA, and creates an exact rollback archive", async t => {
  const data = fixture(t), file = path.join(data.directory, "snapshot.sbbackup");
  await data.manager.create(file);
  const connection = new Database(data.database); connection.prepare("UPDATE space SET amount_minor=9876 WHERE id=1").run(); connection.close();
  const originalCredentials = fs.readFileSync(path.join(data.userData, "credentials.bin"));
  fs.writeFileSync(path.join(data.userData, "credentials.bin"), "changed-credential");
  const prepared = await data.manager.prepareRestore(file); let stops = 0, starts = 0;
  const result = await data.manager.restorePrepared(prepared, { stop: async () => { stops += 1; }, start: async () => { starts += 1; } });
  assert.equal(amount(data.database), 5000); assert.equal(stops, 1); assert.equal(starts, 1);
  assert.deepEqual(loadConfig(data.userData), data.config);
  assert.equal(loadConfig(data.userData).loginKeyHash, crypto.createHash("sha256").update("synthetic-login-key").digest("hex"));
  assert.deepEqual(fs.readFileSync(path.join(data.userData, "credentials.bin")), originalCredentials);
  assert.equal(inspectDatabase(data.database, migrations, data.config.authSecret).summary.mfaEnabled, true);
  assert.equal(data.manager.read(result.rollbackFile).payload.database.summary.money.subscriptions[0].amount_minor, "9876");
});
test("damaged encryption, manifest hash, unsafe paths and money mismatch leave live data untouched", async t => {
  const data = fixture(t), file = path.join(data.directory, "snapshot.sbbackup"); await data.manager.create(file);
  const original = JSON.parse(fs.readFileSync(file, "utf8"));
  const payload = openBackup(original, unprotectKey); const attempts = [];
  attempts.push({ ...original, tag: Buffer.alloc(16).toString("base64") });
  for (const modify of [
    value => { value.files[0].sha256 = "0".repeat(64); },
    value => { value.files[0].path = "../escape.db"; },
    value => { value.files.push({ ...value.files[1] }); },
    value => { value.database.summary.counts.space = 99; },
    value => { value.database.summary.money.subscriptions[0].amount_minor = "999999"; },
  ]) { const copy = structuredClone(payload); modify(copy); attempts.push(sealBackup(copy, protectKey)); }
  for (const envelope of attempts) {
    fs.writeFileSync(file, JSON.stringify(envelope));
    await assert.rejects(data.manager.prepareRestore(file));
    assert.equal(amount(data.database), 5000); assert.deepEqual(loadConfig(data.userData), data.config);
  }
  assert.equal(fs.existsSync(path.join(data.userData, "escape.db")), false);
});
test("a valid SHA256 envelope containing corrupt SQLite is refused before stopping service", async t => {
  const data = fixture(t), file = path.join(data.directory, "snapshot.sbbackup"); await data.manager.create(file);
  const payload = data.manager.read(file).payload;
  const database = Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(6000)]);
  payload.files[0] = { path: "data/app.db", bytes: database.length, data: database.toString("base64"), sha256: crypto.createHash("sha256").update(database).digest("hex") };
  fs.writeFileSync(file, JSON.stringify(sealBackup(payload, protectKey)));
  await assert.rejects(data.manager.prepareRestore(file)); assert.equal(amount(data.database), 5000);
});
test("tampering staged database after confirmation cannot bypass validation", async t => {
  const data = fixture(t), file = path.join(data.directory, "snapshot.sbbackup"); await data.manager.create(file);
  const prepared = await data.manager.prepareRestore(file);
  const staged = new Database(path.join(prepared.directory, "candidate/data/app.db"));
  staged.prepare("UPDATE space SET amount_minor=99 WHERE id=1").run(); staged.close();
  let stopped = false;
  await assert.rejects(data.manager.restorePrepared(prepared, { stop: async () => { stopped = true; }, start: async () => {} }), /发生变化/u);
  assert.equal(stopped, false); assert.equal(amount(data.database), 5000); data.manager.discardPrepared(prepared);
});
test("backend restart failure automatically rolls data and credentials back", async t => {
  const data = fixture(t), file = path.join(data.directory, "snapshot.sbbackup"); await data.manager.create(file);
  const db = new Database(data.database); db.prepare("UPDATE space SET amount_minor=7777 WHERE id=1").run(); db.close();
  fs.writeFileSync(path.join(data.userData, "credentials.bin"), "before-restore");
  const prepared = await data.manager.prepareRestore(file); let starts = 0;
  await assert.rejects(data.manager.restorePrepared(prepared, { stop: async () => {}, start: async () => {
    starts += 1; if (starts === 1) throw new Error("synthetic restart failure");
  } }), /已回滚/u);
  assert.equal(starts, 2); assert.equal(amount(data.database), 7777);
  assert.equal(fs.readFileSync(path.join(data.userData, "credentials.bin"), "utf8"), "before-restore");
  assert.equal(fs.existsSync(path.join(data.userData, "restore-journal.json")), false);
});
test("interrupted atomic restore rolls original files back on next startup", async t => {
  const data = fixture(t), name = `.restore-${crypto.randomUUID()}`, directory = path.join(data.userData, name);
  const paths = [...FILES, "data/app.db-wal", "data/app.db-shm"];
  const files = paths.map(filename => ({ path: filename, existed: fs.existsSync(path.join(data.userData, filename)) }));
  fs.mkdirSync(path.join(directory, "original/data"), { recursive: true });
  fs.renameSync(data.database, path.join(directory, "original/data/app.db")); fs.writeFileSync(data.database, "interrupted replacement");
  fs.writeFileSync(path.join(data.userData, "restore-journal.json"), JSON.stringify({ version: 1, directory: name, files }));
  assert.equal(data.manager.recoverInterruptedRestore(), true); assert.equal(amount(data.database), 5000);
});
test("newer or unrecognized SQLite schema is blocked before migration and restore", async t => {
  const data = fixture(t); const sqlite = new Database(data.database);
  sqlite.prepare("INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)").run("future-migration-hash", Date.now() + 99999999999); sqlite.close();
  assert.throws(() => initialize(data.database, migrations, data.seed), /Downgrade is refused/u);
  assert.throws(() => inspectDatabase(data.database, migrations, data.config.authSecret), /Downgrade is refused/u);
  assert.equal(amount(data.database), 5000);
});
test("known older schema is upgraded in staging without downgrading the running database", async t => {
  const data = fixture(t), oldFolder = path.join(data.directory, "old-migrations");
  fs.cpSync(migrations, oldFolder, { recursive: true });
  const journalFile = path.join(oldFolder, "meta/_journal.json"), journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
  journal.entries.pop(); fs.writeFileSync(journalFile, JSON.stringify(journal));
  const oldDatabase = path.join(data.directory, "old.db"); initialize(oldDatabase, oldFolder, data.seed);
  const old = new Database(oldDatabase);
  old.prepare("INSERT INTO payment_channel(id,name) VALUES(1,'Old fixture card')").run();
  old.prepare("INSERT INTO space(id,name,country,payment_channel_id,currency_code,amount_minor,amount_usd) VALUES(1,'Old fixture subscription','US',1,'USD',3333,3333)").run(); old.close();
  const oldData = path.join(data.directory, "old-user"); fs.mkdirSync(path.join(oldData, "data"), { recursive: true });
  fs.copyFileSync(oldDatabase, path.join(oldData, "data/app.db")); fs.copyFileSync(path.join(data.userData, "config.json"), path.join(oldData, "config.json"));
  const oldManager = new BackupManager({ ...data.manager, userData: oldData, appVersion: "1.0.0", protectKey, unprotectKey,
    backupDb: onlineBackup, inspectDb: (file, secret) => inspectDatabase(file, oldFolder, secret), upgradeDb: file => initialize(file, migrations, data.seed) });
  const archive = path.join(data.directory, "old.sbbackup"); await oldManager.create(archive);
  const prepared = await data.manager.prepareRestore(archive);
  assert.equal(amount(data.database), 5000);
  const staged = inspectDatabase(path.join(prepared.directory, "candidate/data/app.db"), migrations, data.config.authSecret);
  assert.equal(staged.schema.applied, journal.entries.length + 1);
  await data.manager.restorePrepared(prepared, { stop: async () => {}, start: async () => {} });
  assert.equal(amount(data.database), 3333);
  assert.equal(inspectDatabase(data.database, migrations, data.config.authSecret).schema.applied, journal.entries.length + 1);
});
test("unavailable Windows encryption cannot overwrite the ledger or create plaintext archive", async t => {
  const data = fixture(t), file = path.join(data.directory, "unavailable.sbbackup");
  data.manager.protectKey = () => { throw new Error("synthetic Windows encryption unavailable"); };
  await assert.rejects(data.manager.create(file), /encryption unavailable/u);
  assert.equal(fs.existsSync(file), false); assert.equal(amount(data.database), 5000);
});
test("version upgrades create and retain at most five encrypted recovery points", async t => {
  const data = fixture(t);
  assert.ok(await data.manager.beforeUpgrade()); data.manager.markStarted(); assert.equal(await data.manager.beforeUpgrade(), null);
  for (let index = 0; index < 6; index += 1) await data.manager.createCheckpoint("rollback");
  assert.equal(data.manager.list().length, 5);
});
test("a future installed version blocks old clients even when SQL migrations are unchanged", async t => {
  const data = fixture(t);
  fs.writeFileSync(path.join(data.userData, "installed-version.json"), JSON.stringify({ version: "2.0.0" }));
  await assert.rejects(data.manager.beforeUpgrade(), /较新版本 2\.0\.0/u);
  assert.equal(amount(data.database), 5000); assert.equal(data.manager.list().length, 0);
  assert.equal(compareVersions("2.0.0", "2.0.0-beta.2"), 1);
  assert.equal(compareVersions("2.0.0-beta.10", "2.0.0-beta.2"), 1);
  assert.equal(compareVersions("2.0.0-beta.2", "2.0.0-beta.2+windows"), 0);
  assert.throws(() => compareVersions("2.0.0-beta.02", "2.0.0"), /无效/u);
});
test("SQLite reminder helper uses Shanghai date, excludes self-use and obeys configured threshold", t => {
  const data = fixture(t);
  const result = reminders(data.database, new Date("2026-10-12T16:01:00Z"));
  assert.equal(result.today, "2026-10-13"); assert.equal(result.entries.length, 3);
  assert.equal(result.entries.find(row => row.kind === "member").daysUntilDue, -1);
  const sqlite = new Database(data.database); sqlite.prepare("UPDATE child_account SET usage_status='self'").run();
  sqlite.prepare("INSERT INTO app_setting(key,value) VALUES('space.status.soonDays','1')").run(); sqlite.close();
  assert.deepEqual(reminders(data.database, new Date("2026-10-12T16:01:00Z")).entries.map(row => row.kind), ["mother"]);
});
test("daily system notifications deduplicate across restart and retry failed delivery", async t => {
  const data = fixture(t); let notices = 0, shown = false;
  let source = reminders(data.database, new Date("2026-10-12T16:01:00Z"));
  const options = { userData: data.userData, fetchReminders: async () => source, notify: async details => {
    assert.equal(details.body.includes("example.org"), false); assert.equal(details.body.includes("5000"), false);
    notices += 1; return shown;
  } };
  const manager = new ReminderManager(options); assert.equal((await manager.check()).sent, 0);
  shown = true; assert.equal((await manager.check()).sent, 3); assert.equal((await new ReminderManager(options).check()).sent, 0);
  source = reminders(data.database, new Date("2026-10-13T16:01:00Z")); assert.equal((await manager.check()).sent, 3);
  assert.equal(notices, 3);
});
test("operational records and device security settings are included in exact archive summary", async t => {
  const data = fixture(t), sqlite = new Database(data.database);
  const insert = sqlite.prepare("INSERT INTO ops_record(id,kind,data,revision,updated_at) VALUES(?,?,?,1,'2026-10-13T00:00:00Z')");
  insert.run("ops-sub", "subscription", JSON.stringify({ name: "Synthetic ops", currency: "USD", amountMinor: 5432, status: "active", endDate: "2026-10-15" }));
  insert.run("ops-rental", "rental", JSON.stringify({ status: "active", usage: "rented", endDate: "2026-10-13", billing: { currency: "USD", amountMinor: 1234 } }));
  insert.run("ops-bill", "bill", JSON.stringify({ status: "open", dueDate: "2026-10-13", amountMinor: 1000, discountMinor: 0, currency: "USD" }));
  insert.run("ops-receipt", "entry", JSON.stringify({ type: "receipt", status: "posted", billId: "ops-bill", amountMinor: 1000, appliedMinor: 1000, currency: "USD", usdMinor: 1000 }));
  sqlite.exec("CREATE TABLE ops_device(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  sqlite.prepare("INSERT INTO ops_device VALUES('synthetic-hub-token','synthetic-private-device-value')").run(); sqlite.close();
  const file = path.join(data.directory, "operational.sbbackup"); await data.manager.create(file);
  assert.equal(fs.readFileSync(file, "utf8").includes("synthetic-private-device-value"), false);
  const archived = data.manager.read(file).payload.database.summary.operations;
  assert.equal(archived.counts.subscription, 1); assert.equal(archived.money.find(row => row.group === "subscription::USD").amountMinor, "5432");
  const notifications = reminders(data.database, new Date("2026-10-12T16:01:00Z"));
  assert.equal(notifications.entries.length, 2); assert.equal(notifications.entries.some(row => row.kind === "bill"), false);
  assert.equal(notifications.entries.every(row => row.id.includes("ops:")), true);
  const prepared = await data.manager.prepareRestore(file);
  await data.manager.restorePrepared(prepared, { stop: async () => {}, start: async () => {} });
  assert.deepEqual(inspectDatabase(data.database, migrations, data.config.authSecret).summary.operations, archived);
});
test("unsubmitted browser commands are preserved in encrypted local exports and validate before requeue", t => {
  const data = fixture(t), origin = "http://127.0.0.1:32100";
  const rows = [{ id: "synthetic-command", actorId: "synthetic-operator", command: { id: "synthetic-command", type: "customer.save", payload: { name: "Synthetic private queue customer" } }, createdAt: "2026-10-13T00:00:00Z" }];
  const file = saveQueue(data.userData, origin, rows, protectKey);
  assert.equal(fs.readFileSync(file, "utf8").includes("Synthetic private queue customer"), false);
  assert.deepEqual(readQueue(file, origin, unprotectKey), rows);
  assert.throws(() => readQueue(file, "http://127.0.0.1:32101", unprotectKey), /不属于/u);
  assert.throws(() => saveQueue(data.userData, origin, [...rows, ...rows], protectKey), /无效/u);
  assert.throws(() => saveQueue(data.userData, origin, [{ ...rows[0], id: "mismatched-id" }], protectKey), /无效/u);
});
