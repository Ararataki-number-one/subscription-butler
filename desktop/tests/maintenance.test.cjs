/* eslint-disable @typescript-eslint/no-require-imports -- Native IPC authorization uses a real synthetic loopback HTTP server. */
const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");
const { requireMaintenanceAdmin } = require("../maintenance.js");
test("desktop maintenance requires verified admin and never promotes scoped members via ambient cookie", async t => {
  const member = `sbm_${"a".repeat(43)}`, admin = `sbm_${"b".repeat(43)}`;
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization === `Bearer ${member}`) { response.writeHead(403); response.end('{"error":"scoped member"}'); }
    else if (request.headers.authorization === `Bearer ${admin}` || request.headers.cookie === "tam_session=synthetic-admin-cookie") {
      response.end('{"actor":{"id":"synthetic-admin","role":"admin"}}');
    } else { response.writeHead(401); response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await requireMaintenanceAdmin(url, undefined, "synthetic-admin-cookie")).role, "admin");
  assert.equal((await requireMaintenanceAdmin(url, admin)).role, "admin");
  await assert.rejects(requireMaintenanceAdmin(url, member, "synthetic-admin-cookie"), /管理员/u);
  await assert.rejects(requireMaintenanceAdmin(url), /管理员/u);
  await assert.rejects(requireMaintenanceAdmin(url, "invalid-token", "synthetic-admin-cookie"), /凭证无效/u);
  await assert.rejects(requireMaintenanceAdmin("https://example.org", admin), /地址无效/u);
});
