/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

module.exports = function writeSeedData(root, target) {
  const value = execFileSync(process.execPath, [
    path.join(root, "node_modules/tsx/dist/cli.mjs"), "-e",
    'import { CURRENCIES } from "./src/lib/currencies"; process.stdout.write(JSON.stringify(CURRENCIES));',
  ], { cwd: root, encoding: "utf8", windowsHide: true });
  const rows = JSON.parse(value);
  if (!Array.isArray(rows) || !rows.length) throw new Error("Currency seed data unavailable");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(rows, null, 2) + "\n");
};
