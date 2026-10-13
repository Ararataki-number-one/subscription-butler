/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
module.exports = async context => {
  const output = path.resolve(context.appOutDir);
  const runtime = path.join(output, "resources/runtime");
  if (!runtime.startsWith(output + path.sep)) throw new Error("Invalid packaged runtime");
  const binding = path.join(runtime, "node_modules/better-sqlite3/build/Release/better_sqlite3.node");
  if (!fs.existsSync(binding)) throw new Error("Packaged SQLite binding is missing");
  const result = execFileSync(path.join(runtime, "node.exe"), ["-e",
    'const Database=require("better-sqlite3"); const db=new Database(":memory:"); console.log(db.prepare("select 1 as ok").get().ok); db.close();',
  ], { cwd: runtime, encoding: "utf8", windowsHide: true });
  if (result.trim() !== "1") throw new Error("Packaged native runtime failed validation");
};
