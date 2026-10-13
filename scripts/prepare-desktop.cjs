/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const writeSeed = require("./seed-data.cjs");
const root = path.resolve(__dirname, "..");
const runtime = path.join(root, "desktop", "runtime");
const standalone = path.join(root, ".next", "standalone");
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows x64 runtime packaging is required");
if (!fs.existsSync(path.join(standalone, "server.js"))) throw new Error("Run npm run build first");
if (fs.existsSync(runtime)) {
  if (!path.resolve(runtime).startsWith(root + path.sep) || fs.lstatSync(runtime).isSymbolicLink()) throw new Error("Unsafe runtime target");
  fs.rmSync(runtime, { recursive: true, force: true });
}
const allowed = source => !/\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/i.test(source)
  && !path.basename(source).startsWith(".env");
fs.cpSync(standalone, runtime, { recursive: true, dereference: true, filter: allowed });
fs.cpSync(path.join(root, ".next/static"), path.join(runtime, ".next/static"), { recursive: true });
fs.cpSync(path.join(root, "public"), path.join(runtime, "public"), { recursive: true });
fs.cpSync(path.join(root, "drizzle"), path.join(runtime, "drizzle"), { recursive: true });
fs.copyFileSync(path.join(__dirname, "initialize.cjs"), path.join(runtime, "initialize.cjs"));
writeSeed(root, path.join(runtime, "default-currencies.json"));
for (const name of ["drizzle-orm", "bindings", "file-uri-to-path"]) {
  fs.cpSync(path.join(root, "node_modules", name), path.join(runtime, "node_modules", name), { recursive: true });
}
const sqlRoot = path.join(root, "node_modules/better-sqlite3");
const sqlTarget = path.join(runtime, "node_modules/better-sqlite3");
fs.mkdirSync(sqlTarget, { recursive: true });
for (const item of ["lib", "package.json", "LICENSE"]) fs.cpSync(path.join(sqlRoot, item), path.join(sqlTarget, item), { recursive: true });
fs.mkdirSync(path.join(sqlTarget, "build/Release"), { recursive: true });
fs.copyFileSync(path.join(sqlRoot, "build/Release/better_sqlite3.node"), path.join(sqlTarget, "build/Release/better_sqlite3.node"));
fs.copyFileSync(process.execPath, path.join(runtime, "node.exe"));
fs.mkdirSync(path.join(runtime, "licenses"), { recursive: true });
const nodeLicense = path.join(path.dirname(process.execPath), "LICENSE");
if (!fs.existsSync(nodeLicense)) throw new Error("Use the official Node.js binary distribution (LICENSE required)");
fs.copyFileSync(nodeLicense, path.join(runtime, "licenses/Node-LICENSE.txt"));
fs.cpSync(path.join(root, "third-party"), path.join(runtime, "licenses", "additional"), { recursive: true });
function collectLicenses(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const source = path.join(directory, entry.name);
    if (entry.name.startsWith("@")) { collectLicenses(source); continue; }
    const manifestFile = path.join(source, "package.json");
    if (!fs.existsSync(manifestFile)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    const target = path.join(runtime, "licenses", (manifest.name + "-" + manifest.version).replace(/[^a-zA-Z0-9._-]/g, "_"));
    const files = fs.readdirSync(source).filter(name => /^(?:licen[cs]e|notice|copying|third[-_]?party)/i.test(name)
      && fs.statSync(path.join(source, name)).isFile());
    if (files.length) {
      fs.mkdirSync(target, { recursive: true });
      for (const file of files) fs.copyFileSync(path.join(source, file), path.join(target, file));
    }
    const nested = path.join(source, "node_modules");
    if (fs.existsSync(nested)) collectLicenses(nested);
  }
}
collectLicenses(path.join(root, "node_modules"));
const serverFile = path.join(runtime, "server.js");
let server = fs.readFileSync(serverFile, "utf8");
server = server.replace(/const nextConfig = (\{[^\n]+\})\r?\n/, (_match, text) => {
  const config = JSON.parse(text);
  delete config.outputFileTracingRoot;
  delete config.repoRoot;
  if (config.turbopack) delete config.turbopack.root;
  return "const nextConfig = " + JSON.stringify(config) + "\n";
});
fs.writeFileSync(serverFile, server);
function sanitizePaths(directory) {
  const patterns = [root, root.replaceAll("\\", "/"), JSON.stringify(root).slice(1, -1)];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { sanitizePaths(file); continue; }
    if (!/\.(?:json|js|cjs|mjs|map)$/i.test(entry.name)) continue;
    let text = fs.readFileSync(file, "utf8");
    for (const pattern of patterns) text = text.split(pattern).join(".");
    if (/[A-Z]:[/\\]+Users[/\\]+[^/\\]+/i.test(text)) throw new Error("Local workspace path remains in runtime: " + path.relative(runtime, file));
    fs.writeFileSync(file, text);
  }
}
sanitizePaths(runtime);
fs.writeFileSync(path.join(runtime, "runtime-info.json"), JSON.stringify({ node: process.version, arch: process.arch,
  version: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version }, null, 2));
const check = execFileSync(path.join(runtime, "node.exe"), ["-e",
  'const Database=require("better-sqlite3"); const db=new Database(":memory:"); console.log(db.prepare("select 1 as ok").get().ok); db.close();',
], { cwd: runtime, encoding: "utf8", windowsHide: true });
if (check.trim() !== "1") throw new Error("Native SQLite runtime validation failed");
console.log("Self-contained Windows runtime prepared");
