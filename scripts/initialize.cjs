/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { drizzle } = require("drizzle-orm/better-sqlite3");
const { migrate } = require("drizzle-orm/better-sqlite3/migrator");

function initialize(dbFile, migrationsFolder, seedFile) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const sqlite = new Database(dbFile);
  try {
    sqlite.pragma("journal_mode = WAL"); sqlite.pragma("foreign_keys = ON");
    migrate(drizzle(sqlite), { migrationsFolder });
    const insert = sqlite.prepare("INSERT INTO currency(code,name,symbol,country_code,country_name,minor_unit,is_active) VALUES(@code,@name,@symbol,@countryCode,@countryName,@minorUnit,1) ON CONFLICT(code) DO UPDATE SET country_code=excluded.country_code,country_name=excluded.country_name");
    sqlite.transaction(rows => { for (const row of rows) insert.run(row); })(JSON.parse(fs.readFileSync(seedFile, "utf8")));
    if (sqlite.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("Database integrity check failed");
  } finally { sqlite.close(); }
}
async function main() {
  if (process.argv.includes("--backup-source")) {
    const sourcePath = process.argv[process.argv.indexOf("--backup-source") + 1];
    const targetPath = process.argv[process.argv.indexOf("--backup-target") + 1];
    if (!sourcePath || !targetPath || path.resolve(sourcePath) === path.resolve(targetPath)) throw new Error("Invalid backup paths");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const source = new Database(sourcePath, { readonly: true });
    try { await source.backup(targetPath); } finally { source.close(); }
    console.log("Database backup completed");
    return;
  }
  const dbFile = process.env.DB_FILE_NAME;
  if (!dbFile) throw new Error("DB_FILE_NAME is required");
  initialize(dbFile, path.join(__dirname, "drizzle"), path.join(__dirname, "default-currencies.json"));
  console.log("Database initialized");
}
module.exports = { initialize };
if (require.main === module) void main().catch(error => { console.error(error.message); process.exitCode = 1; });
