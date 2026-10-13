/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { backendEnvironment, createConfig, findFreePort, launchBackend, runInitializer, runtimePaths } = require("../desktop/runtime.js");
const root = path.resolve(__dirname, "..");
fs.mkdirSync(path.join(root, "test-artifacts"), { recursive: true });
const userData = fs.mkdtempSync(path.join(root, "test-artifacts", "runtime-smoke-"));
async function main() {
  const runtime = runtimePaths(path.join(root, "desktop/runtime"));
  const config = createConfig(userData, "Synthetic-smoke-login");
  await runInitializer(runtime, backendEnvironment(config, userData, 32100));
  const dbFile = path.join(userData, "data/app.db");
  const db = new Database(dbFile);
  db.prepare("INSERT INTO payment_channel(name) VALUES(?)").run("Smoke test card"); db.close();
  const payload = "v1." + (Date.now() + 3600000) + "." + crypto.randomUUID();
  const cookie = "tam_session=" + payload + "." + crypto.createHmac("sha256", config.authSecret).update(payload).digest("hex");
  for (let cycle = 0; cycle < 2; cycle++) {
    const port = await findFreePort();
    const env = backendEnvironment(config, userData, port);
    const child = await launchBackend(runtime, env, (_name, chunk) => {
      fs.appendFileSync(path.join(userData, "server.log"), chunk);
    });
    try {
      for (const route of ["/", "/spaces", "/reference-data/channels", "/settings"]) {
        const response = await fetch("http://127.0.0.1:" + port + route, {
          headers: { Cookie: cookie }, redirect: "manual", signal: AbortSignal.timeout(30000),
        });
        assert.equal(response.status, 200, "Protected route failed: " + route);
        const body = await response.text();
        assert(body.includes("订阅管家"), "Branding missing: " + route);
        if (route.includes("channels")) assert(body.includes("Smoke test card"), "Persistent channel missing");
      }
    } finally {
      child.kill();
      await new Promise(resolve => child.once("exit", resolve));
    }
  }
  console.log("Authenticated bundled-runtime smoke passed; data survives restart");
}
fs.mkdirSync(path.join(root, "test-artifacts"), { recursive: true });
main().catch(error => { console.error(error.message); process.exitCode = 1; });
