/* eslint-disable @typescript-eslint/no-require-imports -- Bundled Node maintenance helper intentionally uses CommonJS. */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { drizzle } = require("drizzle-orm/better-sqlite3");
const { migrate } = require("drizzle-orm/better-sqlite3/migrator");
const { readMigrationFiles } = require("drizzle-orm/migrator");

function supportedSchema(migrationsFolder) {
  return readMigrationFiles({ migrationsFolder }).map(row => ({ hash: row.hash, createdAt: row.folderMillis }));
}
function tables(sqlite) {
  return new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
}
function checkSchema(sqlite, migrationsFolder) {
  const supported = supportedSchema(migrationsFolder);
  if (!tables(sqlite).has("__drizzle_migrations")) {
    if (tables(sqlite).has("space")) throw new Error("Database migration history is missing");
    return { applied: 0, latest: 0, supported: supported.length, supportedLatest: supported.at(-1)?.createdAt || 0 };
  }
  const applied = sqlite.prepare("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all();
  for (const [index, row] of applied.entries()) {
    if (!supported[index] || supported[index].hash !== row.hash || supported[index].createdAt !== row.created_at) {
      throw new Error("Database schema is newer or incompatible; use the matching newer application. Downgrade is refused.");
    }
  }
  return { applied: applied.length, latest: applied.at(-1)?.created_at || 0,
    supported: supported.length, supportedLatest: supported.at(-1)?.createdAt || 0 };
}
function canonical(value) {
  return JSON.stringify(value, (_key, part) => typeof part === "bigint" ? part.toString() : part);
}
function moneySummary(sqlite, table, currencyField, amountFields, tableNames) {
  if (!tableNames.has(table)) return [];
  const columns = new Set(sqlite.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name));
  const grouped = new Map();
  for (const row of sqlite.prepare(`SELECT * FROM "${table}" ORDER BY id`).safeIntegers().iterate()) {
    const currency = row[currencyField] || "UNKNOWN";
    let values = grouped.get(currency);
    if (!values) { values = Object.fromEntries(amountFields.map(field => [field, 0n])); grouped.set(currency, values); }
    for (const field of amountFields) {
      const amount = columns.has(field) ? row[field] : 0n;
      if (amount !== null && typeof amount !== "bigint") throw new Error("Database money column is not an integer");
      values[field] += amount ?? 0n;
    }
  }
  return [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([currencyCode, amounts]) => ({ currencyCode,
    ...Object.fromEntries(Object.entries(amounts).map(([key, value]) => [key, value.toString()])) }));
}
function validateMfa(sqlite, secret) {
  const rows = sqlite.prepare("SELECT key,value FROM app_setting WHERE key LIKE 'auth.mfa.%' ORDER BY key").all();
  const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
  if (values["auth.mfa.enabled"] === "true" && !values["auth.mfa.secret"]) throw new Error("MFA settings are incomplete");
  for (const name of ["auth.mfa.secret", "auth.mfa.pendingSecret"]) {
    if (!values[name]) continue;
    if (typeof secret !== "string") throw new Error("Authentication config is required to verify MFA backup");
    try {
      const [version, iv, ciphertext, tag] = values[name].split(".");
      if (version !== "v1" || !iv || !ciphertext || !tag) throw new Error();
      const key = crypto.createHash("sha256").update("team-account-manager:mfa:v1").update("\0").update(secret).digest();
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
      if (!/^[A-Z2-7]{16,128}$/u.test(plaintext)) throw new Error();
    } catch { throw new Error("MFA encryption does not match the authentication config"); }
  }
}
function operationsSummary(sqlite, tableNames) {
  const counts = {}, grouped = new Map(), recordHash = crypto.createHash("sha256"), securityHash = crypto.createHash("sha256");
  if (tableNames.has("ops_record")) {
    for (const row of sqlite.prepare("SELECT id,kind,data,revision FROM ops_record ORDER BY id").all()) {
      if (!["customer", "template", "subscription", "slot", "rental", "bill", "entry"].includes(row.kind)) throw new Error("Operational record kind is incompatible");
      const data = JSON.parse(row.data);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Operational record data is invalid");
      counts[row.kind] = (counts[row.kind] || 0) + 1;
      recordHash.update(canonical([row.id, row.kind, data, row.revision]));
      const money = row.kind === "rental" ? data.billing : data;
      if (money?.amountMinor === undefined) continue;
      if (!/^[A-Z]{3}$/u.test(money.currency || "") || !Number.isSafeInteger(money.amountMinor)) throw new Error("Operational currency or amount is invalid");
      const group = `${row.kind}:${data.type || ""}:${money.currency}`;
      const values = grouped.get(group) || { amountMinor: 0n, discountMinor: 0n, feeAmountMinor: 0n, totalMinor: 0n, usdMinor: 0n, cnyMinor: 0n, appliedMinor: 0n };
      for (const field of Object.keys(values)) {
        const amount = money[field];
        if (amount !== undefined && amount !== null) {
          if (!Number.isSafeInteger(amount)) throw new Error("Operational money column is not a safe integer");
          values[field] += BigInt(amount);
        }
      }
      grouped.set(group, values);
    }
  }
  for (const table of [...tableNames].filter(name => /^ops_[a-z_]+$/u.test(name) && name !== "ops_record").sort()) {
    for (const row of sqlite.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).safeIntegers().iterate()) securityHash.update(canonical([table, row]));
  }
  const schema = sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'ops_%' AND type='table' ORDER BY name").all();
  return { counts: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
    money: [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([group, amounts]) => ({ group,
      ...Object.fromEntries(Object.entries(amounts).map(([key, value]) => [key, value.toString()])) })),
    recordsHash: recordHash.digest("hex"), securityHash: securityHash.digest("hex"), schemaHash: crypto.createHash("sha256").update(canonical(schema)).digest("hex") };
}
function inspectDatabase(dbFile, migrationsFolder, authSecret) {
  const sqlite = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    sqlite.pragma("trusted_schema = OFF");
    const integrity = sqlite.pragma("integrity_check");
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") throw new Error("Database integrity check failed");
    if (sqlite.pragma("foreign_key_check").length) throw new Error("Database foreign key check failed");
    const tableNames = tables(sqlite);
    for (const table of ["currency", "payment_channel", "space", "mother_account", "child_account", "app_setting"]) {
      if (!tableNames.has(table)) throw new Error(`Database table is missing: ${table}`);
    }
    const schema = checkSchema(sqlite, migrationsFolder);
    if (!schema.applied) throw new Error("Database migration history is empty");
    if (authSecret !== undefined) validateMfa(sqlite, authSecret);
    const counts = Object.fromEntries(["space", "mother_account", "child_account", "payment_channel", "account_receipt"].map(table =>
      [table, tableNames.has(table) ? sqlite.prepare(`SELECT count(*) AS count FROM "${table}"`).get().count : 0]));
    const accountHash = crypto.createHash("sha256");
    for (const table of ["space", "mother_account", "child_account"]) {
      for (const row of sqlite.prepare(`SELECT * FROM "${table}" ORDER BY id`).safeIntegers().iterate()) {
        accountHash.update(canonical([table, row.id, row.space_id ?? null, row.email ?? row.name ?? ""]));
      }
    }
    const settings = sqlite.prepare("SELECT key,value FROM app_setting ORDER BY key").all();
    return { integrity: "ok", schema, summary: { counts,
      money: {
        subscriptions: moneySummary(sqlite, "space", "currency_code", ["amount_minor", "fee_amount_minor", "amount_usd"], tableNames),
        members: moneySummary(sqlite, "child_account", "monthly_currency_code", ["monthly_amount_minor", "monthly_amount_usd"], tableNames),
        mothers: moneySummary(sqlite, "mother_account", "expected_currency_code", ["expected_amount_minor", "expected_amount_usd"], tableNames),
        receipts: moneySummary(sqlite, "account_receipt", "currency_code", ["amount_minor", "amount_usd"], tableNames),
      }, accountHash: accountHash.digest("hex"), settingsHash: crypto.createHash("sha256").update(canonical(settings)).digest("hex"),
      mfaEnabled: settings.some(row => row.key === "auth.mfa.enabled" && row.value === "true"), operations: operationsSummary(sqlite, tableNames) } };
  } finally { sqlite.close(); }
}
function initialize(dbFile, migrationsFolder, seedFile) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const sqlite = new Database(dbFile);
  try {
    // Inspect existing pages and their WAL before migrations or seeds write to
    // the ledger. An invalid log must not be hidden by a partial upgrade.
    try {
      if (sqlite.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("invalid integrity result");
    } catch (error) {
      throw new Error("Database integrity check failed; initialization stopped before writing", { cause: error });
    }
    checkSchema(sqlite, migrationsFolder);
    sqlite.pragma("journal_mode = WAL"); sqlite.pragma("foreign_keys = ON");
    migrate(drizzle(sqlite), { migrationsFolder });
    const insert = sqlite.prepare("INSERT INTO currency(code,name,symbol,country_code,country_name,minor_unit,is_active) VALUES(@code,@name,@symbol,@countryCode,@countryName,@minorUnit,1) ON CONFLICT(code) DO UPDATE SET country_code=excluded.country_code,country_name=excluded.country_name WHERE currency.country_code<>excluded.country_code OR currency.country_name<>excluded.country_name");
    sqlite.transaction(rows => { for (const row of rows) insert.run(row); })(JSON.parse(fs.readFileSync(seedFile, "utf8")));
    if (sqlite.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("Database integrity check failed");
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
  } finally { sqlite.close(); }
}
async function onlineBackup(sourcePath, targetPath) {
  if (!sourcePath || !targetPath || path.resolve(sourcePath) === path.resolve(targetPath)) throw new Error("Invalid backup paths");
  if (fs.existsSync(targetPath)) throw new Error("Backup target already exists");
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try { await source.backup(targetPath); } finally { source.close(); }
}
function dateNumber(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const number = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(number) && new Date(number).toISOString().slice(0, 10) === value ? number / 86400000 : null;
}
function reminders(dbFile, now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const sqlite = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const settings = Object.fromEntries(sqlite.prepare("SELECT key,value FROM app_setting WHERE key IN ('space.status.soonDays','childAccount.status.soonDays')").all().map(row => [row.key, row.value]));
    const threshold = value => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 365 ? Number(value) : 7;
    const entries = [];
    function add(kind, id, dueDate, title, soonDays) {
      const due = dateNumber(dueDate);
      if (due === null) return;
      const daysUntilDue = due - dateNumber(today);
      if (daysUntilDue <= soonDays) entries.push({ id: `${kind}:${id}`, kind, dueDate, title: String(title).slice(0, 120), daysUntilDue });
    }
    if (tables(sqlite).has("ops_record")) {
      const records = sqlite.prepare("SELECT id,kind,data FROM ops_record ORDER BY id").all().map(row => ({ ...row, data: JSON.parse(row.data) }));
      if (records.length) {
        for (const row of records) {
          if (row.kind === "subscription" && row.data.status === "active") add("subscription", `ops:${row.id}`, row.data.endDate, row.data.name, threshold(settings["space.status.soonDays"]));
          if (row.kind === "rental" && row.data.status === "active" && row.data.usage === "rented") add("member", `ops:${row.id}`, row.data.endDate, "租期到期", threshold(settings["childAccount.status.soonDays"]));
          if (row.kind === "bill" && row.data.status === "open") {
            const received = records.filter(entry => entry.kind === "entry" && entry.data.billId === row.id && entry.data.status === "posted")
              .reduce((sum, entry) => sum + (entry.data.type === "receipt" ? entry.data.appliedMinor || 0 : entry.data.type === "refund" ? -(entry.data.appliedMinor || 0) : 0), 0);
            if (row.data.amountMinor - row.data.discountMinor > received) add("bill", `ops:${row.id}`, row.data.dueDate, "账期收款", threshold(settings["childAccount.status.soonDays"]));
          }
        }
        return { today, entries };
      }
    }
    for (const row of sqlite.prepare("SELECT id,name,expiry_date FROM space ORDER BY id").all())
      add("subscription", row.id, row.expiry_date, row.name, threshold(settings["space.status.soonDays"]));
    for (const row of sqlite.prepare("SELECT c.id,c.next_payment_date,c.usage_status,c.monthly_rate_source,c.monthly_amount_minor,s.name FROM child_account c JOIN space s ON s.id=c.space_id WHERE c.is_mother_account=0 ORDER BY c.id").all()) {
      if (row.usage_status === "rented" || (row.usage_status === null && row.monthly_rate_source !== "self-use" && row.monthly_amount_minor > 0)) add("member", row.id, row.next_payment_date, `${row.name} 成员收款`, threshold(settings["childAccount.status.soonDays"]));
    }
    for (const row of sqlite.prepare("SELECT m.id,m.next_payment_date,m.usage_status,s.name FROM mother_account m JOIN space s ON s.id=m.space_id ORDER BY m.id").all()) {
      if (row.usage_status === "rented") add("mother", row.id, row.next_payment_date, `${row.name} 母号收款`, threshold(settings["childAccount.status.soonDays"]));
    }
    return { today, entries };
  } finally { sqlite.close(); }
}
async function main() {
  const args = process.argv.slice(2);
  const argument = name => args[args.indexOf(name) + 1];
  if (args.includes("--backup-source")) {
    await onlineBackup(argument("--backup-source"), argument("--backup-target"));
    console.log(JSON.stringify({ status: "ok" })); return;
  }
  const dbFile = process.env.DB_FILE_NAME;
  if (!dbFile) throw new Error("DB_FILE_NAME is required");
  const migrationFolder = path.join(__dirname, "drizzle");
  if (args.includes("--inspect")) {
    console.log(JSON.stringify(inspectDatabase(dbFile, migrationFolder, process.env.APP_AUTH_SECRET))); return;
  }
  if (args.includes("--reminders")) { console.log(JSON.stringify(reminders(dbFile))); return; }
  initialize(dbFile, migrationFolder, path.join(__dirname, "default-currencies.json"));
  console.log("Database initialized");
}
module.exports = { initialize, inspectDatabase, onlineBackup, reminders, supportedSchema };
if (require.main === module) void main().catch(error => { console.error(error.message); process.exitCode = 1; });
