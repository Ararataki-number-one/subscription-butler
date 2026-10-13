/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { initialize } = require("./initialize.cjs");
const writeSeed = require("./seed-data.cjs");
const root = path.resolve(__dirname, "..");
const folder = path.join(root, "test-artifacts", "build-data");
const dbFile = path.join(folder, "app.db");
const seedFile = path.join(folder, "currencies.json");
writeSeed(root, seedFile);
initialize(dbFile, path.join(root, "drizzle"), seedFile);
const result = spawnSync(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "build"], {
  cwd: root, stdio: "inherit", windowsHide: true,
  env: { ...process.env, DB_FILE_NAME: dbFile, NEXT_PHASE: "phase-production-build" },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
