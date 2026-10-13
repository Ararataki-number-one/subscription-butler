/* eslint-disable @typescript-eslint/no-require-imports -- Electron launcher tests intentionally use CommonJS, matching the packaged runtime. */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { EventEmitter, once } = require("node:events");
const { test } = require("node:test");
const {
  assertSmokeDirectory, backendEnvironment, createConfig, createLocalOwnerSession, externalWebUrl, findFreePort, initializeLocalConfig, launchBackend,
  loadConfig, persistentLoopbackPort, requestHealth, runInitializer, runtimePaths, stopBackendAndCloseConnections, trustedLocalUrl, validateLoginKey,
} = require("../runtime.js");

function temporaryDirectory(t) {
  const root = path.resolve(__dirname, "../../test-artifacts"); fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, "subscription-butler-test-"));
  t.after(() => { assert.ok(path.resolve(directory).startsWith(`${root}${path.sep}`)); fs.rmSync(directory, { recursive: true, force: true }); });
  return directory;
}

test("first-run config preserves exact Unicode key while only storing its hash", (t) => {
  const directory = temporaryDirectory(t);
  const loginKey = "  测试密钥abcdef  ";
  assert.equal(loadConfig(directory), null);
  const config = createConfig(directory, loginKey);
  assert.equal(config.loginKeyHash, crypto.createHash("sha256").update(loginKey).digest("hex"));
  assert.equal(config.authSecret.length, 64);
  assert.deepEqual(loadConfig(directory), config);
  assert.ok(fs.existsSync(path.join(directory, "data")));
  for (const filename of ["config.json", ".env"]) {
    assert.equal(fs.readFileSync(path.join(directory, filename), "utf8").includes(loginKey), false);
  }
  assert.throws(() => createConfig(directory, "another-key"), /不能覆盖/u);
  assert.deepEqual(loadConfig(directory), config);
});
test("smoke isolation rejects real profile, case aliases, descendants and Windows junctions", t => {
  const directory = temporaryDirectory(t), actual = path.join(directory, "actual-profile"), isolated = path.join(directory, "isolated-profile");
  fs.mkdirSync(actual); fs.writeFileSync(path.join(actual, "marker.txt"), "unchanged synthetic ledger");
  assert.throws(() => assertSmokeDirectory(actual, actual), /完全独立/u);
  assert.throws(() => assertSmokeDirectory(path.join(actual, "nested-test"), actual), /完全独立/u);
  assert.throws(() => assertSmokeDirectory(directory, actual), /完全独立/u);
  if (process.platform === "win32") {
    assert.throws(() => assertSmokeDirectory(actual.toUpperCase(), actual), /完全独立/u);
    const alias = path.join(directory, "profile-junction"); fs.symlinkSync(actual, alias, "junction");
    assert.throws(() => assertSmokeDirectory(alias, actual), /完全独立/u);
    assert.throws(() => assertSmokeDirectory(path.join(alias, "nested-test"), actual), /完全独立/u);
    fs.unlinkSync(alias);
  }
  assert.equal(assertSmokeDirectory(isolated, actual), path.join(fs.realpathSync.native(directory), "isolated-profile"));
  assert.equal(fs.readFileSync(path.join(actual, "marker.txt"), "utf8"), "unchanged synthetic ledger");
});
test("local desktop initializes private config without a key prompt and preserves it across restarts", t => {
  const directory = temporaryDirectory(t);
  const first = initializeLocalConfig(directory);
  assert.equal(first.authSecret.length, 64); assert.equal(first.loginKeyHash.length, 64);
  assert.deepEqual(initializeLocalConfig(directory), first);
  assert.equal(fs.existsSync(path.join(directory, "credentials.bin")), false);
  const legacy = { ...first, authSecret: "8121e68c-fd96-45e4-b821-8e3d51af70e5" };
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify(legacy));
  assert.deepEqual(initializeLocalConfig(directory), legacy);
});
test("native local owner cookie matches backend verifier and expires without exposing a login key", async t => {
  const directory = temporaryDirectory(t), config = initializeLocalConfig(directory), now = Date.now();
  const { verifySessionToken } = await import("../../src/lib/auth.ts");
  const previous = process.env.APP_AUTH_SECRET;
  try {
    process.env.APP_AUTH_SECRET = config.authSecret;
    const session = createLocalOwnerSession(config.authSecret, now);
    assert.equal(await verifySessionToken(session.value, now), true);
    assert.equal(await verifySessionToken(session.value, session.expiresAt + 1), false);
    assert.equal(session.value.includes(config.authSecret), false); assert.equal(session.value.includes(config.loginKeyHash), false);
    assert.notEqual(createLocalOwnerSession(config.authSecret, now).value, session.value);
    process.env.APP_AUTH_SECRET = "wrong-signing-secret";
    assert.equal(await verifySessionToken(session.value, now), false);
  } finally { if (previous === undefined) delete process.env.APP_AUTH_SECRET; else process.env.APP_AUTH_SECRET = previous; }
});

test("invalid keys and corrupt configs never silently replace existing data", (t) => {
  const directory = temporaryDirectory(t);
  for (const key of ["short", "        ", "abcdefgh\n", "\u0000abcdefgh", "a".repeat(257), null]) {
    assert.throws(() => validateLoginKey(key));
  }
  fs.writeFileSync(path.join(directory, "config.json"), "{}");
  assert.throws(() => loadConfig(directory), /配置损坏/u);
  fs.writeFileSync(path.join(directory, "config.json"), "invalid-json");
  assert.throws(() => loadConfig(directory), /无法读取/u);
});

test("imported UUID auth secret is preserved for existing MFA encryption", (t) => {
  const directory = temporaryDirectory(t);
  const config = createConfig(directory, "test-key-123");
  config.authSecret = "8121e68c-fd96-45e4-b821-8e3d51af70e5";
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify(config));
  assert.equal(loadConfig(directory).authSecret, config.authSecret);
  assert.equal(backendEnvironment(config, directory, 31337).APP_AUTH_SECRET, config.authSecret);
  for (const invalid of ["too-short", "a".repeat(257), `${"a".repeat(32)}\n`, `${"a".repeat(32)}\u0000`]) {
    fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({ ...config, authSecret: invalid }));
    assert.throws(() => loadConfig(directory), /配置损坏/u);
  }
});

test("backend gets loopback, persistent SQLite, auth and correct cookie flag", (t) => {
  const directory = temporaryDirectory(t);
  const config = createConfig(directory, "test-key-123");
  const environment = backendEnvironment(config, directory, 31337, {
    NODE_OPTIONS: "--require=untrusted", ELECTRON_RUN_AS_NODE: "1", SYSTEMROOT: "C:\\Windows",
    DB_FILE_NAME: "wrong.db", APP_ALLOW_INSECURE_COOKIES: "false", HOSTNAME: "0.0.0.0",
    OPS_PUBLIC_ORIGIN: "https://self-hosted.example.org", OPS_DESKTOP_ORIGIN: "http://127.0.0.1:1111",
  });
  assert.equal(environment.HOSTNAME, "127.0.0.1");
  assert.equal(environment.PORT, "31337");
  assert.equal(environment.DB_FILE_NAME, path.join(directory, "data", "app.db"));
  assert.equal(environment.APP_AUTH_SECRET, config.authSecret);
  assert.equal(environment.APP_ALLOW_INSECURE_COOKIES, "true");
  assert.equal(environment.OPS_DESKTOP_ORIGIN, "http://127.0.0.1:31337");
  assert.equal(environment.OPS_PUBLIC_ORIGIN, undefined);
  assert.equal(environment.SYSTEMROOT, "C:\\Windows");
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
  assert.throws(() => backendEnvironment(config, directory, 0));
});

test("only exact loopback origin can use desktop credentials", () => {
  assert.equal(trustedLocalUrl("http://127.0.0.1:31337/login?next=%2F", 31337), true);
  for (const url of ["http://localhost:31337/", "https://127.0.0.1:31337/", "http://127.0.0.1:31338/", "http://127.0.0.1:31337.evil.example/", "file:///app", "http://user@127.0.0.1:31337/", "nonsense"]) {
    assert.equal(trustedLocalUrl(url, 31337), false, url);
  }
  for (const url of ["javascript:alert(1)", "file:///C:/secret", "cmd:run", "https://user:pass@example.com/"]) {
    assert.equal(externalWebUrl(url), false, url);
  }
  assert.equal(externalWebUrl("https://github.com/Ararataki-number-one/subscription-butler/releases"), true);
});

test("desktop origin survives restarts and never silently switches occupied ports", async (t) => {
  const directory = temporaryDirectory(t);
  const first = await persistentLoopbackPort(directory);
  assert.equal(await persistentLoopbackPort(directory), first);
  const server = http.createServer((_request, response) => response.end("foreign process"));
  await new Promise(resolve => server.listen(first, "127.0.0.1", resolve));
  try {
    await assert.rejects(persistentLoopbackPort(directory), /已被占用/u);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "server-port.json"), "utf8")).port, first);
  } finally { await new Promise(resolve => server.close(resolve)); }
  assert.equal(await persistentLoopbackPort(directory), first);
});
test("distribution validates every bundled executable/script", (t) => {
  const directory = temporaryDirectory(t);
  for (const file of ["node.exe", "initialize.cjs", "server.js"]) {
    assert.throws(() => runtimePaths(directory, "win32"), /运行文件缺失/u);
    fs.writeFileSync(path.join(directory, file), "");
  }
  const paths = runtimePaths(directory, "win32");
  assert.equal(paths.node, path.join(directory, "node.exe"));
  assert.equal(paths.server, path.join(directory, "server.js"));
});

test("health checks reject bad status or malformed payload", async (t) => {
  let mode = "healthy";
  const server = http.createServer((_request, response) => {
    response.writeHead(mode === "error" ? 500 : 200);
    response.end(mode === "healthy" ? '{"status":"ok"}' : "invalid");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  assert.equal(await requestHealth(port), true);
  mode = "malformed";
  assert.equal(await requestHealth(port), false);
  mode = "error";
  assert.equal(await requestHealth(port), false);
});

test("initializer runs with bundled Node and propagates migration failure", async (t) => {
  const directory = temporaryDirectory(t);
  const runtime = { node: process.execPath, initialize: path.join(directory, "initialize.cjs"), directory };
  const marker = path.join(directory, "initialized.txt");
  fs.writeFileSync(runtime.initialize, 'require("node:fs").writeFileSync(process.env.MARKER, "ready");');
  await runInitializer(runtime, { ...process.env, MARKER: marker });
  assert.equal(fs.readFileSync(marker, "utf8"), "ready");
  fs.writeFileSync(runtime.initialize, "process.exit(7)");
  await assert.rejects(runInitializer(runtime, process.env), /退出码 7/u);
});

test("launcher waits for healthy service then stops child cleanly", async (t) => {
  const root = path.resolve(__dirname, "../../test-artifacts"); fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, "subscription-butler-test-"));
  const serverFile = path.join(directory, "server.js");
  fs.writeFileSync(serverFile, 'require("node:http").createServer((req,res)=>{res.end(JSON.stringify({status:"ok"}));}).listen(Number(process.env.PORT),process.env.HOSTNAME);');
  const port = await findFreePort();
  const child = await launchBackend({ node: process.execPath, server: serverFile, directory }, { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1" }, undefined, { timeoutMs: 5000, intervalMs: 20 });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    assert.ok(path.resolve(directory).startsWith(`${root}${path.sep}`)); fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(await requestHealth(port), true);
});

test("launcher reports immediate backend failure before opening app", async (t) => {
  const directory = temporaryDirectory(t);
  const serverFile = path.join(directory, "server.js");
  fs.writeFileSync(serverFile, "process.exit(9)");
  await assert.rejects(launchBackend({ node: process.execPath, server: serverFile, directory }, { ...process.env, PORT: String(await findFreePort()) }, undefined, { timeoutMs: 5000, intervalMs: 20 }), /已退出（9）/u);
});

test("launcher terminates an unresponsive backend on timeout", async (t) => {
  const directory = temporaryDirectory(t);
  const serverFile = path.join(directory, "server.js");
  fs.writeFileSync(serverFile, "setInterval(()=>{}, 1000)");
  let child;
  await assert.rejects(launchBackend({ node: process.execPath, server: serverFile, directory }, { ...process.env, PORT: String(await findFreePort()) }, undefined, { timeoutMs: 150, intervalMs: 20, onSpawn: (value) => { child = value; } }), /启动超时/u);
  if (child.exitCode === null) await once(child, "exit");
  assert.equal(child.killed, true);
});
test("backend shutdown waits for exit and closes Chrome connections before restart can continue", async () => {
  const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
  const order = [];
  await stopBackendAndCloseConnections(child, current => {
    assert.equal(current, child); order.push("terminate");
    setImmediate(() => { order.push("exit"); child.exitCode = 0; child.emit("exit", 0); });
  }, async () => { assert.equal(child.exitCode, 0); order.push("close-connections"); });
  order.push("restart");
  assert.deepEqual(order, ["terminate", "exit", "close-connections", "restart"]);
  await stopBackendAndCloseConnections(null, () => assert.fail("must not kill"), async () => order.push("close-again"));
  assert.equal(order.at(-1), "close-again");
});
test("failed backend termination does not proceed to clear sockets or a replacement backend", async () => {
  const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
  let closed = false;
  await assert.rejects(stopBackendAndCloseConnections(child, () => {}, async () => { closed = true; }, 10), /停止超时/u);
  assert.equal(closed, false); assert.equal(child.listenerCount("exit"), 0);
});
